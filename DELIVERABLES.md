Deliverables for Copilot Studio CRM integration

- OpenAPI: crm.openapi.json (top-level in repository).
- Endpoints added:
  - POST /api/crm/assistant (operationId: askCrmAssistant) — main assistant endpoint (already present).
  - GET /api/crm/diagnostics — CRM diagnostic summary (existing).
  - GET /api/crm/metadata[?module=ModuleName] — returns live module list or field metadata sample for a module.
  - POST /api/crm/metadata/refresh — refresh cached module/field metadata (optional module in body).

Quick Copilot Studio import steps:
1. Open Copilot Studio and import `crm.openapi.json`.
2. Map the connector input to the `question` field only. The backend resolves the module, fields, dates, filters, sorting, pagination, and Zoho API.
3. Test the connector by sending `question` values such as "Show today's leads".
4. Use `/api/crm/metadata?module=Leads` to validate module/field mapping.

Notes:
- No secrets are included in the OpenAPI or deliverables.
- Diagnostic endpoints redact sensitive details unless `crmDebug` is enabled in `env`.

If you want, I can also produce a zipped package of `crm.openapi.json` and this README for import.