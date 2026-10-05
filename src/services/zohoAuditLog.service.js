const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const yauzl = require("yauzl");
const { getZohoConfig } = require("../config/zoho.config");
const { ZohoAuthService } = require("./zohoAuth.service");
const { createAppError } = require("../utils/errors");
const { log } = require("../utils/logger");

const MAX_NETWORK_ATTEMPTS = 3;
const NETWORK_RETRY_DELAYS_MS = [500, 1000];
const MAX_EXPORT_POLLS = 20;
const EXPORT_POLL_INTERVAL_MS = 1000;
const MAX_EXPORT_CREATE_ATTEMPTS = 3;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);
const auditHttpClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false }),
});

class ZohoAuditLogService {
  constructor(httpClient = auditHttpClient, configLoader = getZohoConfig, authService, sleep = delay) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.authService =
      authService || new ZohoAuthService(httpClient, configLoader);
    this.sleep = sleep;
    this.inFlightExports = new Map();
    this.expiredDownloadJobIds = new Set();
  }

  async getAuditLogs(params = {}) {
    const config = this.configLoader();
    await this.getAccessTokenWithRetry(config, false);
    const apiDomain = (
      this.authService.getApiDomain?.() ||
      config.apiBaseUrl ||
      "https://www.zohoapis.com/crm/v8"
    ).replace(/\/+$/, "");
    const apiVersion = config.apiVersion || "v8";

    const baseUrl = /\/crm\/v\d+$/i.test(apiDomain)
      ? apiDomain
      : `${apiDomain}/crm/${apiVersion}`;

    const dateRange = normalizeAuditDateRange(
      params.date_range || todayDateRange(),
    );

    const criteria = [
      {
        field: { api_name: "audited_time" },
        comparator: "between",
        value: [dateRange.start, dateRange.end],
      },
    ];

    // Module filters require both the API name and unique module ID.
    if (params.entity) {
      if (!params.entity_id) {
        throw createAppError(
          "AUDIT_LOG_MODULE_ID_REQUIRED",
          "A Zoho module ID is required for module filtering.",
          400,
        );
      }

      criteria.push({
        field: {
          api_name: "module",
        },
        comparator: "in",
        value: [
          {
            api_name: params.entity,
            id: String(params.entity_id),
          },
        ],
      });
    }

    // Zoho supports only these audit action values.
    if (params.action) {
      const action = String(params.action).toLowerCase();

      if (!["added", "updated", "deleted"].includes(action)) {
        throw createAppError(
          "AUDIT_LOG_INVALID_ACTION",
          `Unsupported audit action: ${action}`,
          400,
          { operation: "audit_log" },
        );
      }

      criteria.push({
        field: { api_name: "action" },
        comparator: "equal",
        value: action,
      });
    }

    // User filters require a valid Zoho user ID.
    if (params.user?.id) {
      criteria.push({
        field: { api_name: "done_by" },
        comparator: "in",
        value: [
          {
            id: String(params.user.id),
            name: params.user.name || "",
          },
        ],
      });
    }

    const auditCriteria = buildAuditCriteria(criteria);

    const requestBody = {
      audit_log_export: [
        {
          criteria: auditCriteria,
        },
      ],
    };

    console.log(
      "[ZOHO_AUDIT_LOG_REQUEST]",
      JSON.stringify(
        {
          url: `${baseUrl}/settings/audit_log_export`,
          body: requestBody,
        },
        null,
        2,
      ),
    );

    const exportKey = stableStringify(normalizeCriteria(auditCriteria));
    const existingExport = this.inFlightExports.get(exportKey);
    if (existingExport) return existingExport;

    const exportPromise = this.createAndDownloadAuditLog(
      baseUrl,
      config,
      requestBody,
      auditCriteria,
    );
    this.inFlightExports.set(exportKey, exportPromise);
    try {
      return await exportPromise;
    } finally {
      if (this.inFlightExports.get(exportKey) === exportPromise) {
        this.inFlightExports.delete(exportKey);
      }
    }
  }

  async createAndDownloadAuditLog(baseUrl, config, requestBody, requestedCriteria) {
    let job;
    for (let attempt = 0; attempt < MAX_EXPORT_CREATE_ATTEMPTS && !job; attempt += 1) {
      try {
        const createResponse = await this.scheduleAuditLogExport(baseUrl, config, requestBody);
        job = getCreatedAuditLogJob(createResponse);
      } catch (error) {
        if (!isAlreadyScheduledError(error)) throw error;
        const jobs = await this.getScheduledAuditLogExports(baseUrl, config, requestedCriteria);
        job = findMatchingScheduledJob(jobs, requestedCriteria, this.expiredDownloadJobIds);
        if (job) break;

        const expiredJob = findExpiredMatchingJob(jobs, requestedCriteria, this.expiredDownloadJobIds);
        if (expiredJob) throw createExpiredDownloadLinkError(expiredJob);

        const activeJobs = jobs.filter((candidate) => isActiveExportStatus(candidate?.status));
        for (const activeJob of activeJobs) {
          await this.pollAuditLogExport(
            baseUrl,
            config,
            activeJob,
            "AUDIT_LOG_EXPORT_WAIT_TIMEOUT",
          );
        }

        if (activeJobs.length === 0 && attempt > 0) {
          throw createUnmatchedScheduledExportError();
        }

        if (attempt === MAX_EXPORT_CREATE_ATTEMPTS - 1) {
          if (activeJobs.length) {
            throw createAppError(
              "AUDIT_LOG_EXPORT_RETRY_LIMIT",
              "Zoho continued to report a scheduled export after the blocking jobs completed and the retry limit was reached.",
              504,
              { operation: "audit_log", retry_limit: MAX_EXPORT_CREATE_ATTEMPTS },
            );
          }
          throw createUnmatchedScheduledExportError();
        }
      }
    }

    const jobId =
      job?.details?.id ||
      job?.job_id ||
      job?.id;

    if (!jobId) {
      throw createAppError(
        "AUDIT_LOG_EXPORT_JOB_UNAVAILABLE",
        "Zoho did not return an audit-log export job ID.",
        502,
      );
    }

    const { job: exportJob, downloadUrl } = await this.pollAuditLogExport(
      baseUrl,
      config,
      { ...job, id: jobId },
      "AUDIT_LOG_EXPORT_TIMEOUT",
    );
    if (isAuditLogJobExpired(exportJob)) {
      this.markExpiredDownloadJob(jobId);
      throw createExpiredDownloadLinkError(exportJob);
    }

    let download;
    try {
      download = await this.request("get", downloadUrl, config, undefined, {
        responseType: "arraybuffer",
      });
    } catch (error) {
      if (!isExpiredDownloadError(error)) throw error;
      this.markExpiredDownloadJob(jobId);
      throw createExpiredDownloadLinkError(exportJob, error);
    }

    let records;
    try {
      records = await parseAuditLogDownload(download.data);
    } catch (_error) {
      throw createAppError(
        "AUDIT_LOG_DOWNLOAD_INVALID",
        "Zoho returned an audit-log download that could not be parsed as CSV or ZIP.",
        502,
        { operation: "audit_log", job_id: String(jobId), status: exportJob.status },
      );
    }

    return {
      records,
      info: {
        count: records.length,
        more_records: false,
      },
    };
  }

  markExpiredDownloadJob(jobId) {
    if (this.expiredDownloadJobIds.size >= 256) {
      this.expiredDownloadJobIds.delete(this.expiredDownloadJobIds.values().next().value);
    }
    this.expiredDownloadJobIds.add(String(jobId));
  }

  async scheduleAuditLogExport(baseUrl, config, requestBody) {
    return this.request(
      "post",
      `${baseUrl}/settings/audit_log_export`,
      config,
      requestBody,
      { zohoApiRequest: true },
    );
  }

  async getScheduledAuditLogExports(baseUrl, config, requestedCriteria) {
    let response;
    try {
      response = await this.request(
        "get",
        `${baseUrl}/settings/audit_log_export`,
        config,
        undefined,
        { zohoApiRequest: true },
      );
    } catch (error) {
      if (
        error.details?.upstream_status === 400 &&
        error.details?.upstream_code === "NO_CONTENT"
      ) {
        logScheduledExportJobs([], requestedCriteria);
        return [];
      }
      throw error;
    }

    const jobs = response.data?.audit_log_export;
    const scheduledJobs = Array.isArray(jobs) ? jobs : [];
    logScheduledExportJobs(scheduledJobs, requestedCriteria);
    return scheduledJobs;
  }

  async pollAuditLogExport(baseUrl, config, job, timeoutCode) {
    const jobId = job?.id || job?.job_id || job?.details?.id;
    if (!jobId) {
      throw createAppError(
        "AUDIT_LOG_EXPORT_JOB_UNAVAILABLE",
        "Zoho did not return an audit-log export job ID.",
        502,
      );
    }

    let exportJob;
    let selectedJobSeen = false;
    let finishedWithoutDownload = false;
    let lastResponse;
    for (let attempt = 0; attempt < MAX_EXPORT_POLLS; attempt += 1) {
      const response = await this.request(
        "get",
        `${baseUrl}/settings/audit_log_export/${encodeURIComponent(jobId)}`,
        config,
        undefined,
        { zohoApiRequest: true },
      );
      lastResponse = response;
      const jobs = Array.isArray(response.data?.audit_log_export)
        ? response.data.audit_log_export
        : [];
      exportJob = selectAuditLogJob(jobs, jobId);
      selectedJobSeen ||= Boolean(exportJob);
      const state = normalizeExportStatus(exportJob?.status);
      const links = exportJob?.download_links;
      const downloadUrl = firstValidDownloadLink(links);

      log("info", `[ZOHO_AUDIT_EXPORT_STATUS] ${JSON.stringify({
        jobId: String(jobId),
        jobStatus: exportJob?.status || null,
        responseTopLevelKeys: Object.keys(response || {}),
        payloadTopLevelKeys: Object.keys(response.data || {}),
        auditLogExportLength: jobs.length,
        selectedJobKeys: exportJob ? Object.keys(exportJob) : [],
        downloadLinksPresent: Object.prototype.hasOwnProperty.call(exportJob || {}, "download_links"),
        downloadLinksType: Array.isArray(links) ? "array" : typeof links,
        downloadLinksCount: Array.isArray(links) ? links.length : 0,
      })}`);

      if (state === "finished") {
        if (timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT") return { job: exportJob };
        if (downloadUrl) return { job: exportJob, downloadUrl };
        finishedWithoutDownload = true;
      }
      if (state === "failed") {
        if (timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT") return { job: exportJob };
        const safeError = safeAuditLogJobError(exportJob, config);
        throw createAppError(
          "AUDIT_LOG_EXPORT_FAILED",
          `Zoho audit-log export job ${jobId} failed with status '${exportJob.status}'.`,
          502,
          { operation: "audit_log", job_id: String(jobId), status: exportJob.status, ...safeError },
        );
      }

      if (attempt < MAX_EXPORT_POLLS - 1) {
        await this.sleep(EXPORT_POLL_INTERVAL_MS);
      }
    }

    const errorCode = timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT"
      ? timeoutCode
      : !selectedJobSeen
        ? "AUDIT_LOG_EXPORT_STATUS_UNAVAILABLE"
        : finishedWithoutDownload
          ? "AUDIT_LOG_DOWNLOAD_UNAVAILABLE"
          : timeoutCode;
    if (errorCode === "AUDIT_LOG_DOWNLOAD_UNAVAILABLE") {
      logAuditExportStatusDebug(lastResponse, jobId, config);
      const selectedJobKeys = exportJob && typeof exportJob === "object"
        ? Object.keys(exportJob)
        : [];
      const downloadLinks = exportJob?.download_links;
      const discoveredArtifactPaths = findAuditArtifactLocations(exportJob)
        .map(({ path }) => path);
      log("info", `[ZOHO_AUDIT_EXPORT_STATUS_DEBUG] ${JSON.stringify({
        requestedJobId: String(jobId),
        selectedJobId: safeAuditDebugValue(getExportJobId(exportJob), config),
        selectedJobStatus: safeAuditDebugValue(exportJob?.status, config),
        selectedJobKeys,
        hasDownloadLinks: Object.prototype.hasOwnProperty.call(exportJob || {}, "download_links"),
        downloadLinksType: getAuditDebugType(downloadLinks),
        downloadLinksCount: Array.isArray(downloadLinks) ? downloadLinks.length : 0,
        discoveredArtifactPaths,
      })}`);
    }

    const unavailableDownloadDetails = errorCode === "AUDIT_LOG_DOWNLOAD_UNAVAILABLE"
      ? {
        selected_job_keys: exportJob && typeof exportJob === "object"
          ? Object.keys(exportJob)
          : [],
        has_download_links: Object.prototype.hasOwnProperty.call(exportJob || {}, "download_links"),
        download_links_type: getAuditDebugType(exportJob?.download_links),
        download_links_count: Array.isArray(exportJob?.download_links)
          ? exportJob.download_links.length
          : 0,
        discovered_artifact_paths: findAuditArtifactLocations(exportJob)
          .map(({ path }) => path),
      }
      : {};

    throw createAppError(
      errorCode,
      timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT"
        ? "A scheduled Zoho audit-log export is still blocking this request."
        : !selectedJobSeen
          ? "Zoho did not return the requested audit-log export job in its status response."
          : finishedWithoutDownload
            ? "Zoho marked the audit-log export finished but did not provide a valid download link within the polling limit."
            : "Zoho audit-log export did not finish within the polling limit.",
      timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT"
        ? 504
        : !selectedJobSeen || finishedWithoutDownload
          ? 502
          : 504,
      {
        operation: "audit_log",
        job_id: String(jobId),
        ...(timeoutCode === "AUDIT_LOG_EXPORT_WAIT_TIMEOUT"
          ? { blocking_job_id: String(jobId) }
          : {}),
        status: normalizeExportStatus(exportJob?.status) || normalizeExportStatus(job.status) || null,
        response_top_level_keys: Object.keys(lastResponse || {}),
        audit_log_export_count: Array.isArray(lastResponse?.data?.audit_log_export)
          ? lastResponse.data.audit_log_export.length
          : 0,
        ...unavailableDownloadDetails,
      },
    );
  }

  async request(method, url, config, data, requestOptions = {}) {
    const { zohoApiRequest = false, ...axiosOptions } = requestOptions;
    let tokenRefreshed = false;

    authRetry: for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      const token = await this.getAccessTokenWithRetry(
        config,
        tokenRefreshed,
      );
      const requestUrl = zohoApiRequest
        ? resolveZohoApiUrl(url, config, this.authService.getApiDomain?.())
        : url;

      for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
        const startedAt = Date.now();
        const options = {
          ...axiosOptions,
          headers: {
            ...axiosOptions.headers,
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(method === "get" ? {} : { "Content-Type": "application/json" }),
          },
          timeout: config.timeoutMs,
        };

        try {
          return method === "get"
            ? await this.httpClient.get(requestUrl, options)
            : await this.httpClient.post(requestUrl, data, options);
        } catch (error) {
          if (error.response?.status === 401) {
            log("warn", `[AUTH_FAILURE] ${JSON.stringify({
              source: "zoho_oauth",
              path: "/api/crm/audit-log",
              method,
              upstreamStatus: 401,
              retrying: authAttempt === 0,
            })}`);
            this.authService.clearToken?.();
            if (authAttempt === 0) {
              tokenRefreshed = true;
              continue authRetry;
            }
          }

          if (error.response) {
            throw createZohoHttpError(error, token, config);
          }

          const code = getNetworkErrorCode(error);
          const shouldRetry = RETRYABLE_NETWORK_CODES.has(code)
            && attempt < MAX_NETWORK_ATTEMPTS;
          logNetworkFailure(error, {
            hostname: getHostname(requestUrl),
            method,
            attempt,
            elapsedMs: Date.now() - startedAt,
            tokenRefreshed,
            retry: shouldRetry,
            secrets: [token, config.clientId, config.clientSecret, config.refreshToken],
          });

          if (shouldRetry) {
            await this.sleep(NETWORK_RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }

          throw createNetworkError("audit_log", error);
        }
      }
    }

    throw createAppError("ZOHO_AUTHENTICATION_ERROR", "Unable to authenticate with Zoho CRM.", 502, {
      operation: "audit_log",
      upstream_status: 401,
      upstream_code: null,
    });
  }

  async getAccessTokenWithRetry(config, tokenRefreshed) {
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
      try {
        return await this.authService.getAccessToken();
      } catch (error) {
        const cause = error.cause || error;
        if (cause.response) {
          throw createAppError(
            "ZOHO_AUTHENTICATION_ERROR",
            "Unable to authenticate with Zoho CRM.",
            502,
            {
              operation: "audit_log",
              upstream_status: cause.response.status || null,
              upstream_code: cause.response.data?.code || null,
            },
          );
        }
        if (!error.cause && error.code !== "ZOHO_AUTHENTICATION_ERROR") {
          throw error;
        }

        const code = getNetworkErrorCode(cause);
        const shouldRetry = !cause.response
          && attempt < MAX_NETWORK_ATTEMPTS
          && RETRYABLE_NETWORK_CODES.has(code);
        const startedAt = error.networkStartedAt || Date.now();
        logNetworkFailure(cause, {
          hostname: getHostname(config.accountsUrl),
          method: "POST",
          attempt,
          elapsedMs: Date.now() - startedAt,
          tokenRefreshed,
          retry: shouldRetry,
          secrets: [config.clientId, config.clientSecret, config.refreshToken],
        });
        if (shouldRetry) {
          await this.sleep(NETWORK_RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        throw createNetworkError("audit_log", cause);
      }
    }

    throw createNetworkError("audit_log", new Error("Zoho token request failed."));
  }
}

function resolveZohoApiUrl(url, config, apiDomain) {
  const original = new URL(url);
  const suffix = original.pathname.replace(/^\/crm\/v\d+/i, "");
  const domain = (apiDomain || config.apiBaseUrl || "https://www.zohoapis.com").replace(/\/+$/, "");
  const baseUrl = /\/crm\/v\d+$/i.test(domain)
    ? domain
    : `${domain}/crm/${config.apiVersion || "v8"}`;
  return `${baseUrl}${suffix}${original.search}`;
}

function isAlreadyScheduledError(error) {
  return error.statusCode === 400
    && error.details?.upstream_status === 400
    && error.details?.upstream_code === "ALREADY_SCHEDULED";
}

function getCreatedAuditLogJob(response) {
  const data = response.data || {};
  return data.audit_log_export?.[0] || data.details || data;
}

function createUnmatchedScheduledExportError() {
  return createAppError(
    "AUDIT_LOG_SCHEDULED_EXPORT_UNMATCHED",
    "Zoho reports an audit-log export is already scheduled, but no existing job with matching criteria could be identified after inspecting available jobs.",
    409,
    {
      operation: "audit_log",
      upstream_status: 400,
      upstream_code: "ALREADY_SCHEDULED",
    },
  );
}

function findMatchingScheduledJob(jobs, requestedCriteria, expiredJobIds = new Set()) {
  const statusPriority = { finished: 0, progress: 1, scheduled: 2 };
  return jobs
    .filter((job) => getExportJobId(job)
      && statusPriority[normalizeExportStatus(job.status)] !== undefined
      && !expiredJobIds.has(String(getExportJobId(job)))
      && !isAuditLogJobExpired(job)
      && criteriaMatch(job.criteria, requestedCriteria))
    .sort((left, right) => (
      statusPriority[normalizeExportStatus(left.status)]
      - statusPriority[normalizeExportStatus(right.status)]
    ))[0] || null;
}

function findExpiredMatchingJob(jobs, requestedCriteria, expiredJobIds) {
  return jobs.find((job) => getExportJobId(job)
    && normalizeExportStatus(job.status) === "finished"
    && criteriaMatch(job.criteria, requestedCriteria)
    && (expiredJobIds.has(String(getExportJobId(job))) || isAuditLogJobExpired(job))) || null;
}

function getExportJobId(job) {
  return job?.id || job?.job_id || job?.details?.id || null;
}

function isActiveExportStatus(status) {
  return ["progress", "scheduled"].includes(normalizeExportStatus(status));
}

function normalizeExportStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function logAuditExportStatusDebug(response, requestedJobId, config) {
  const payload = response?.data;
  const jobsValue = payload?.audit_log_export;
  const jobs = Array.isArray(jobsValue) ? jobsValue : [];
  log("info", `[ZOHO_AUDIT_EXPORT_STATUS_DEBUG] ${JSON.stringify({
    requestedJobId: String(requestedJobId),
    responseType: getAuditDebugType(payload),
    topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    auditLogExportExists: Boolean(
      payload && Object.prototype.hasOwnProperty.call(payload, "audit_log_export"),
    ),
    auditLogExportType: getAuditDebugType(jobsValue),
    auditLogExportCount: getAuditDebugCount(jobsValue),
    jobs: jobs.map((job) => {
      const safeJob = job && typeof job === "object" ? job : {};
      const links = safeJob.download_links;
      const error = safeJob.error || safeJob.details?.error || safeJob.error_details || {};
      return {
        id: safeAuditDebugValue(getExportJobId(safeJob), config),
        status: safeAuditDebugValue(safeJob.status, config),
        keys: Object.keys(safeJob),
        hasDownloadLinks: Object.prototype.hasOwnProperty.call(safeJob, "download_links"),
        downloadLinksType: getAuditDebugType(links),
        downloadLinksCount: Array.isArray(links) ? links.length : 0,
        hasDownloadUrl: Object.prototype.hasOwnProperty.call(safeJob, "download_url"),
        hasDownloadLink: Object.prototype.hasOwnProperty.call(safeJob, "download_link"),
        errorCode: safeAuditDebugValue(
          error.code || safeJob.error_code,
          config,
        ),
        errorMessage: safeAuditDebugValue(
          error.message || safeJob.error_message || safeJob.message,
          config,
        ),
      };
    }),
    artifactLocations: findAuditArtifactLocations(payload),
  })}`);
}

function getAuditDebugType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function getAuditDebugCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === undefined || value === null ? 0 : 1;
}

function safeAuditDebugValue(value, config) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return `[${getAuditDebugType(value)}]`;
  }
  const secrets = [
    config.clientId,
    config.clientSecret,
    config.refreshToken,
    process.env.BACKEND_API_KEY,
  ]
    .filter(Boolean)
    .map(String);
  let safeValue = String(value);
  for (const secret of secrets) {
    safeValue = safeValue.split(secret).join("[REDACTED]");
  }
  return safeValue
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/Zoho-oauthtoken\s+\S+/gi, "Zoho-oauthtoken [REDACTED]")
    .replace(/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

function findAuditArtifactLocations(value) {
  const locations = [];
  const visited = new WeakSet();
  const artifactKey = /(download|artifact|file|link|url)/i;

  function visit(current, path) {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      if (artifactKey.test(key)) {
        locations.push({
          path: childPath,
          type: getAuditDebugType(child),
          count: getAuditDebugCount(child),
        });
      }
      visit(child, childPath);
    }
  }

  visit(value, "");
  return locations;
}

function selectAuditLogJob(jobs, requestedJobId) {
  const exactJob = jobs.find((candidate) => String(getExportJobId(candidate) || "") === String(requestedJobId));
  if (exactJob) return exactJob;
  if (jobs.length === 1 && !getExportJobId(jobs[0])) return jobs[0];
  return null;
}

function firstValidDownloadLink(links) {
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (typeof link !== "string" || !link.trim()) continue;
    try {
      const url = new URL(link.trim());
      if (url.protocol === "https:") return link.trim();
    } catch {
      continue;
    }
  }
  return null;
}

function isAuditLogJobExpired(job) {
  if (!job?.expiry_date) return false;
  const expiryTime = Date.parse(job.expiry_date);
  return Number.isFinite(expiryTime) && expiryTime <= Date.now();
}

function isExpiredDownloadError(error) {
  return error.details?.upstream_status === 410
    || /expired|expiry/i.test(String(error.details?.upstream_code || ""));
}

function createExpiredDownloadLinkError(job, cause) {
  return createAppError(
    "AUDIT_LOG_DOWNLOAD_LINK_EXPIRED",
    "The Zoho audit-log download link has expired; a new export may be required.",
    502,
    {
      operation: "audit_log",
      job_id: String(getExportJobId(job) || "unknown"),
      status: normalizeExportStatus(job?.status) || null,
      expiry_date: job?.expiry_date || null,
      upstream_status: cause?.details?.upstream_status || null,
      upstream_code: cause?.details?.upstream_code || null,
    },
  );
}

function safeAuditLogJobError(job, config) {
  const value = job?.error || job?.details?.error || job?.error_details || {};
  const code = value.code || job?.error_code || null;
  const message = value.message || job?.error_message || job?.message || null;
  const secrets = [config.clientId, config.clientSecret, config.refreshToken];
  return {
    ...(code ? { upstream_code: sanitizeMessage(code, secrets) } : {}),
    ...(message ? { upstream_message: sanitizeMessage(message, secrets) } : {}),
  };
}

function logScheduledExportJobs(jobs, requestedCriteria) {
  log("info", `[ZOHO_AUDIT_SCHEDULED_JOBS] ${JSON.stringify({
    requestedCriteria: normalizeCriteria(requestedCriteria),
    jobCount: jobs.length,
  })}`);
  for (const job of jobs) {
    const safeJob = job && typeof job === "object" ? job : {};
    log("info", `[ZOHO_AUDIT_SCHEDULED_JOB] ${JSON.stringify({
      jobId: getExportJobId(safeJob),
      status: safeJob.status || null,
      criteria: safeJob.criteria || null,
      matchesRequest: criteriaMatch(safeJob.criteria, requestedCriteria),
      jobStartTime: findJobMetadata(safeJob, /start/i),
      jobEndTime: findJobMetadata(safeJob, /end/i),
      expiryDate: findJobMetadata(safeJob, /expir/i),
    })}`);
  }
}

function findJobMetadata(value, keyPattern) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key) && (typeof child !== "object" || child === null)) return child;
    const nested = findJobMetadata(child, keyPattern);
    if (nested !== null) return nested;
  }
  return null;
}

function criteriaMatch(existingCriteria, requestedCriteria) {
  return Boolean(existingCriteria)
    && stableStringify(normalizeCriteria(existingCriteria))
      === stableStringify(normalizeCriteria(requestedCriteria));
}

function normalizeCriteria(criteria) {
  if (Array.isArray(criteria)) return normalizeCriteriaGroup("and", criteria);
  if (!criteria || typeof criteria !== "object") return criteria;

  const comparator = normalizeComparator(criteria.comparator);
  const fieldApiName = String(criteria.field?.api_name || "").toLowerCase();
  const groupOperator = String(criteria.group_operator || "and").trim().toLowerCase();
  const normalized = {};

  for (const key of Object.keys(criteria).sort()) {
    if (key === "group" && Array.isArray(criteria.group)) {
      Object.assign(normalized, normalizeCriteriaGroup(groupOperator, criteria.group));
    } else if (key === "group_operator") {
      normalized[key] = groupOperator;
    } else if (key === "comparator") {
      normalized[key] = comparator;
    } else if (key === "value") {
      normalized[key] = normalizeCriteriaValue(criteria.value, fieldApiName, comparator);
    } else {
      normalized[key] = normalizeCriteria(criteria[key]);
    }
  }
  return normalized;
}

function normalizeCriteriaGroup(operator, criteria) {
  const normalizedOperator = ["or", "||"].includes(String(operator).trim().toLowerCase())
    ? "or"
    : "and";
  const children = [];
  for (const item of criteria) {
    const normalized = normalizeCriteria(item);
    if (normalized?.group_operator === normalizedOperator
      && Array.isArray(normalized.group)
      && Object.keys(normalized).length === 2) {
      children.push(...normalized.group);
    } else {
      children.push(normalized);
    }
  }
  children.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return { group_operator: normalizedOperator, group: children };
}

function normalizeComparator(comparator) {
  const value = String(comparator || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["equals", "equal_to", "eq", "="].includes(value)) return "equal";
  if (["not_equals", "not_equal_to", "ne", "!="].includes(value)) return "not_equal";
  return value;
}

function normalizeCriteriaValue(value, fieldApiName, comparator) {
  if (fieldApiName === "action" && typeof value === "string") return value.trim().toLowerCase();
  if (fieldApiName === "audited_time" && comparator === "between" && Array.isArray(value)) {
    return value.map(normalizeTimestampBoundary);
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => fieldApiName === "action" && typeof item === "string"
      ? item.trim().toLowerCase()
      : normalizeCriteria(item));
    return comparator === "in"
      ? normalized.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
      : normalized;
  }
  return normalizeCriteria(value);
}

function normalizeTimestampBoundary(value) {
  if (typeof value !== "string") return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/i.exec(value);
  if (!match) return value;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);
  if (localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return value;

  const offsetMinutes = zone.toUpperCase() === "Z"
    ? 0
    : (sign === "+" ? 1 : -1) * (Number(offsetHourText) * 60 + Number(offsetMinuteText));
  if (zone.toUpperCase() !== "Z"
    && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return value;
  const utcDate = new Date(localDate.getTime() - offsetMinutes * 60000);
  const normalizedFraction = fraction.replace(/0+$/, "");
  return `${utcDate.toISOString().slice(0, 19)}${normalizedFraction ? `.${normalizedFraction}` : ""}Z`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const child = value[key];
        if (key === "group" && Array.isArray(child)) {
          const normalizedGroup = child.map(stableStringify).sort();
          return `${JSON.stringify(key)}:[${normalizedGroup.join(",")}]`;
        }
        if (
          key === "value" &&
          String(value.comparator || "").toLowerCase() === "in" &&
          Array.isArray(child)
        ) {
          const normalizedSet = child.map(stableStringify).sort();
          return `${JSON.stringify(key)}:[${normalizedSet.join(",")}]`;
        }
        return `${JSON.stringify(key)}:${stableStringify(child)}`;
      });
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function parseAuditLogDownload(payload) {
  const buffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload || "");
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const csv = await extractCsvFromZip(buffer);
    return parseCsv(csv.toString("utf8"));
  }
  return parseCsv(buffer.toString("utf8"));
}

function extractCsvFromZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) return reject(openError);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };

      zipFile.on("error", fail);
      zipFile.on("end", () => {
        if (!settled) fail(new Error("The ZIP archive contains no CSV file."));
      });
      zipFile.on("entry", (entry) => {
        if (!entry.fileName.toLowerCase().endsWith(".csv")) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > 100 * 1024 * 1024) {
          fail(new Error("The audit-log CSV exceeds the supported size."));
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", fail);
          stream.on("end", () => {
            if (settled) return;
            settled = true;
            zipFile.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zipFile.readEntry();
    });
  });
}

function createZohoHttpError(error, token, config) {
  const status = error.response.status;
  const responseData = error.response.data || {};
  const zohoError = responseData.audit_log_export?.[0]
    || responseData.data?.[0]
    || responseData;
  const upstreamCode = zohoError.code || null;
  const isAuthError = status === 401 || status === 403;
  const message = status === 401
    ? "Zoho rejected CRM authentication after a token refresh attempt."
    : status === 403
      ? "Zoho denied access to the requested CRM audit-log operation."
      : sanitizeMessage(zohoError.message || responseData.message || error.message, [
        token,
        config.clientId,
        config.clientSecret,
        config.refreshToken,
      ]);
  const code = status === 401
    ? "ZOHO_AUTHENTICATION_ERROR"
    : status === 403
      ? "ZOHO_AUTHORIZATION_ERROR"
      : status === 404
        ? "ZOHO_ENDPOINT_NOT_FOUND"
        : upstreamCode || "AUDIT_LOG_REQUEST_FAILED";

  return createAppError(code, message, isAuthError ? 502 : status, {
    operation: "audit_log",
    upstream_status: status,
    upstream_code: upstreamCode,
  });
}

function createNetworkError(operation, error) {
  return createAppError(
    "AUDIT_LOG_UPSTREAM_NETWORK_ERROR",
    "Unable to establish a connection to the Zoho CRM API.",
    502,
    { operation, upstream_status: null, upstream_code: null },
  );
}

function logNetworkFailure(error, details) {
  log("warn", `[ZOHO_AUDIT_NETWORK_ERROR] ${JSON.stringify({
    operation: "audit_log",
    hostname: details.hostname,
    method: String(details.method).toUpperCase(),
    attempt: details.attempt,
    code: getNetworkErrorCode(error),
    message: sanitizeMessage(error.message, details.secrets),
    elapsedMs: details.elapsedMs,
    tokenRefreshed: details.tokenRefreshed,
    retry: details.retry,
  })}`);
}

function getNetworkErrorCode(error) {
  return error?.code || error?.cause?.code || null;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function sanitizeMessage(message, secrets = []) {
  let safeMessage = String(message || "Network request failed.");
  for (const secret of secrets) {
    if (secret) safeMessage = safeMessage.split(String(secret)).join("[REDACTED]");
  }
  return safeMessage
    .replace(/Zoho-oauthtoken\s+\S+/gi, "Zoho-oauthtoken [REDACTED]")
    .replace(/(access_token|refresh_token|client_secret|client_id|api_key)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Zoho permits no more than two criteria in each group.
// Nest additional criteria to keep each group within that limit.
function buildAuditCriteria(criteria) {
  if (criteria.length === 1) {
    return criteria[0];
  }

  if (criteria.length === 2) {
    return {
      group_operator: "and",
      group: criteria,
    };
  }

  return {
    group_operator: "and",
    group: [criteria[0], buildAuditCriteria(criteria.slice(1))],
  };
}

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);

    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? null]),
    );
  });
}

function splitCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

function todayDateRange() {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  return {
    start: `${date}T00:00:00+05:30`,
    end: `${date}T23:59:59+05:30`,
  };
}

function normalizeAuditDateRange(range) {
  const start = String(range.start);
  const end = String(range.end);

  const startTimestamp = /^\d{4}-\d{2}-\d{2}$/.test(start)
    ? `${start}T00:00:00+05:30`
    : start;

  let endTimestamp = end;

  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    const [year, month, day] = end.split("-").map(Number);
    const endDate = new Date(Date.UTC(year, month - 1, day));

    if (range.end_operator === "exclusive") {
      endDate.setUTCDate(endDate.getUTCDate() - 1);
    }

    const endYear = endDate.getUTCFullYear();
    const endMonth = String(endDate.getUTCMonth() + 1).padStart(2, "0");
    const endDay = String(endDate.getUTCDate()).padStart(2, "0");

    endTimestamp = `${endYear}-${endMonth}-${endDay}T23:59:59+05:30`;
  }

  return {
    start: startTimestamp,
    end: endTimestamp,
  };
}

module.exports = { ZohoAuditLogService };
