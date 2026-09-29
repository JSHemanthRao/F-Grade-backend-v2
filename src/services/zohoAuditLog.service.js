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
    const token = await this.authService.getAccessToken();
    const apiDomain = (
      this.authService.getApiDomain() || config.apiBaseUrl
    ).replace(/\/+$/, "");

    const apiVersion = config.apiVersion || "v8";

    const baseUrl = /\/crm\/v\d+$/i.test(apiDomain)
      ? apiDomain
      : `${apiDomain}/crm/${apiVersion}`;

    // const dateRange = params.date_range || todayDateRange();
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
    if (params.entity)
      criteria.push({
        field: { api_name: "module" },
        comparator: "in",
        value: [{ api_name: params.entity }],
      });
    if (params.action) {
      criteria.push({
        field: { api_name: "action" },
        comparator: "equal",
        value: params.action,
      });
    }
    if (params.user?.id) {
      criteria.push({
        field: { api_name: "done_by" },
        comparator: "in",
        value: [
          {
            id: params.user.id,
            name: params.user.name || "",
          },
        ],
      });
    }
    const auditCriteria =
      criteria.length === 1
        ? criteria[0]
        : {
            group_operator: "and",
            group: criteria,
          };

    const createResponse = await this.request(
      "post",
      `${baseUrl}/settings/audit_log_export`,
      token,
      config,
      {
        audit_log_export: [
          {
            criteria: auditCriteria,
          },
        ],
      },
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
    if (!jobId)
      throw createAppError(
        "AUDIT_LOG_EXPORT_JOB_UNAVAILABLE",
        "Zoho did not return an audit-log export job ID.",
        502,
      );

    let status;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await this.request(
        "get",
        `${baseUrl}/settings/audit_log_export/${encodeURIComponent(jobId)}`,
        token,
        config,
      );
      const state = String(
        status.data?.audit_log_export?.[0]?.status || "",
      ).toLowerCase();
      if (state === "finished") break;
      if (state === "failed")
        throw createAppError(
          "AUDIT_LOG_EXPORT_FAILED",
          "Zoho audit-log export failed.",
          502,
        );
      if (attempt < 19)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const exportJob = status?.data?.audit_log_export?.[0];
    if (String(exportJob?.status || "").toLowerCase() !== "finished")
      throw createAppError(
        "AUDIT_LOG_EXPORT_TIMEOUT",
        "Zoho audit-log export did not finish within the polling limit.",
        504,
      );
    const downloadUrl = exportJob.download_links?.[0];
    if (!downloadUrl)
      throw createAppError(
        "AUDIT_LOG_DOWNLOAD_UNAVAILABLE",
        "Zoho did not provide an audit-log download link.",
        502,
      );
    const download = await this.httpClient.get(downloadUrl, {
      responseType: "text",
      timeout: config.timeoutMs,
    });
    const records = parseCsv(String(download.data || ""));
    return { records, info: { count: records.length, more_records: false } };
  }

  async request(method, url, token, config, data) {
    try {
      const options = {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        timeout: config.timeoutMs,
      };

      return method === "get"
        ? await this.httpClient.get(url, options)
        : await this.httpClient.post(url, data, options);
    } catch (error) {
      const status = error.response?.status ?? null;
      const responseData = error.response?.data ?? null;

      // Zoho may return its error inside the audit_log_export array.
      const zohoError =
        responseData?.audit_log_export?.[0] ||
        responseData?.data?.[0] ||
        responseData ||
        {};

      const errorCode = zohoError?.code || null;

      const errorMessage =
        zohoError?.message ||
        responseData?.message ||
        error.message ||
        "Unable to retrieve Zoho Audit Log data.";

      // Log the complete Zoho response for debugging.
      console.error(
        "[ZOHO_AUDIT_LOG_API_ERROR]",
        JSON.stringify(
          {
            method: method.toUpperCase(),
            url,
            status,
            response: responseData,
            message: error.message,
          },
          null,
          2,
        ),
      );

      if (status === 401) {
        this.authService.clearToken?.();
      }

      const appErrorCode =
        status === 401
          ? "ZOHO_AUTHENTICATION_ERROR"
          : status === 403
            ? "ZOHO_AUTHORIZATION_ERROR"
            : status === 404
              ? "ZOHO_ENDPOINT_NOT_FOUND"
              : errorCode || "AUDIT_LOG_REQUEST_FAILED";

      throw createAppError(appErrorCode, errorMessage, status || 502, {
        operation: "audit_log",
        upstream_status: status,
        upstream_code: errorCode,
      });
    }
  }
}

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
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
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += char;
  }
  values.push(value.trim());
  return values;
}

module.exports = { ZohoAuditLogService };

function todayDateRange() {
  const now = new Date();

  // Get today's date in India (IST)
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

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
    const endDate = new Date(`${end}T00:00:00+05:30`);

    if (range.end_operator === "exclusive") {
      endDate.setDate(endDate.getDate() - 1);
    }

    const year = endDate.getFullYear();
    const month = String(endDate.getMonth() + 1).padStart(2, "0");
    const day = String(endDate.getDate()).padStart(2, "0");

    endTimestamp = `${year}-${month}-${day}T23:59:59+05:30`;
  }

  return {
    start: startTimestamp,
    end: endTimestamp,
  };
}
