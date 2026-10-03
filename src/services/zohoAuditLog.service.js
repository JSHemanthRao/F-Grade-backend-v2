const axios = require("axios");
const { getZohoConfig } = require("../config/zoho.config");
const { ZohoAuthService } = require("./zohoAuth.service");
const { createAppError } = require("../utils/errors");

class ZohoAuditLogService {
  constructor(httpClient = axios, configLoader = getZohoConfig, authService) {
    this.httpClient = httpClient;
    this.configLoader = configLoader;
    this.authService =
      authService || new ZohoAuthService(httpClient, configLoader);
  }

  async getAuditLogs(params = {}) {
    const config = this.configLoader();
    await this.authService.getAccessToken();

    const apiDomain = (
      this.authService.getApiDomain() || config.apiBaseUrl
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

    const createResponse = await this.request(
      "post",
      `${baseUrl}/settings/audit_log_export`,
      config,
      requestBody,
    );

    const job =
      createResponse.data?.audit_log_export?.[0] ||
      createResponse.data?.details ||
      createResponse.data;

    const jobId =
      job?.details?.id ||
      job?.job_id ||
      job?.id ||
      createResponse.data?.details?.id;

    if (!jobId) {
      throw createAppError(
        "AUDIT_LOG_EXPORT_JOB_UNAVAILABLE",
        "Zoho did not return an audit-log export job ID.",
        502,
      );
    }

    let status;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await this.request(
        "get",
        `${baseUrl}/settings/audit_log_export/${encodeURIComponent(jobId)}`,
        config,
      );

      const state = String(
        status.data?.audit_log_export?.[0]?.status || "",
      ).toLowerCase();

      if (state === "finished") {
        break;
      }

      if (state === "failed") {
        throw createAppError(
          "AUDIT_LOG_EXPORT_FAILED",
          "Zoho audit-log export failed.",
          502,
        );
      }

      if (attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const exportJob = status?.data?.audit_log_export?.[0];

    if (String(exportJob?.status || "").toLowerCase() !== "finished") {
      throw createAppError(
        "AUDIT_LOG_EXPORT_TIMEOUT",
        "Zoho audit-log export did not finish within the polling limit.",
        504,
      );
    }

    const downloadUrl = exportJob.download_links?.[0];

    if (!downloadUrl) {
      throw createAppError(
        "AUDIT_LOG_DOWNLOAD_UNAVAILABLE",
        "Zoho did not provide an audit-log download link.",
        502,
      );
    }

    const download = await this.request("get", downloadUrl, config, undefined, {
      responseType: "text",
    });

    const records = parseCsv(String(download.data || ""));

    return {
      records,
      info: {
        count: records.length,
        more_records: false,
      },
    };
  }

  async request(method, url, config, data, requestOptions = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await this.authService.getAccessToken();
        const options = {
          ...requestOptions,
          headers: {
            ...requestOptions.headers,
            Authorization: `Zoho-oauthtoken ${token}`,
            ...(method === "get" ? {} : { "Content-Type": "application/json" }),
          },
          timeout: config.timeoutMs,
        };

        return method === "get"
          ? await this.httpClient.get(url, options)
          : await this.httpClient.post(url, data, options);
      } catch (error) {
        const status = error.response?.status ?? null;
        const responseData = error.response?.data ?? null;
        const zohoError =
          responseData?.audit_log_export?.[0] ||
          responseData?.data?.[0] ||
          responseData ||
          {};
        const errorCode = zohoError?.code || null;
        const upstreamMessage =
          zohoError?.message ||
          responseData?.message ||
          error.message ||
          "Unable to retrieve Zoho Audit Log data.";

        if (status === 401) {
          this.authService.clearToken?.();
          if (attempt === 0) continue;
        }

        const authRejected = status === 401 || status === 403;
        const appErrorCode =
          status === 401
            ? "ZOHO_AUTHENTICATION_ERROR"
            : status === 403
              ? "ZOHO_AUTHORIZATION_ERROR"
              : status === 404
                ? "ZOHO_ENDPOINT_NOT_FOUND"
                : error.code || errorCode || "AUDIT_LOG_REQUEST_FAILED";
        const message = status === 401
          ? "Zoho rejected CRM authentication after a token refresh attempt."
          : status === 403
            ? "Zoho denied access to the requested CRM audit-log operation."
            : error.code === "ZOHO_AUTHENTICATION_ERROR"
              ? "Unable to authenticate with Zoho CRM."
              : upstreamMessage;

        throw createAppError(
          appErrorCode,
          message,
          authRejected ? 502 : status || 502,
          {
            operation: "audit_log",
            upstream_status: status,
            upstream_code: errorCode,
          },
        );
          }
    }

    throw createAppError(
      "ZOHO_AUTHENTICATION_ERROR",
      "Unable to authenticate with Zoho CRM.",
      502,
      { operation: "audit_log" },
    );
  }
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
