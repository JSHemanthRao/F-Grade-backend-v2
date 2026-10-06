# Public bot API security

## Authentication boundary

The custom connector actions call the backend anonymously. They must not send
`x-api-key` or an `Authorization` header. Zoho authentication is separate:
the backend reads its Zoho client ID, client secret, and refresh token from
server-side environment variables and adds its OAuth bearer token only to
Zoho requests.

The anonymous boundary is limited to:

- `POST /api/crm/assistant` — natural-language and schema-validated structured,
  read-only CRM queries.
- `POST /api/crm/audit-log` — bounded Zoho Audit Log export and retrieval.

`GET /health` is also public and exposes only process health. No other route is
made public by the connector change.

The following remain protected by `BACKEND_API_KEY`:

- `/api/crm/query`
- `/api/crm/diagnostics`
- `/api/crm/assistant/fast-summary`
- `/api/crm/audit-log/assistant`
- `/api/crm/metadata` and `/api/crm/metadata/refresh`
- `/api/skills` and its child routes

Unknown API paths return 404. The API key is not part of either bot connector
definition.

## Abuse controls and request boundaries

Defaults are per client IP and per one-minute window:

- CRM assistant general requests: 30 requests.
- CRM aggregate/report requests: 10 requests.
- Audit Log exports: 5 requests.

Override with `BOT_RATE_LIMIT_WINDOW_MS`, `BOT_CRM_RATE_LIMIT`,
`BOT_AGGREGATE_RATE_LIMIT`, and `BOT_AUDIT_RATE_LIMIT`. Counters are bounded,
automatically expiring, and process-local. They require no external service and
are not shared between backend instances.

`REQUEST_BODY_LIMIT` defaults to 100 KB. `REQUEST_TIMEOUT_MS` defaults to 60
seconds. Zoho OAuth and API calls retain their configured upstream timeout and
the Audit Log export polling remains bounded. Requests with query parameters,
unknown top-level fields, or credential-shaped body keys are rejected. These
bot routes do not accept arbitrary endpoint or URL properties. CRM module and
field execution remains resolved and validated by the backend; no caller can
select an arbitrary Zoho URL.

Anonymous access is an intentional security tradeoff: anyone who can reach the
Render host can invoke the two read operations, subject to the limits above.
Process-local rate limiting reduces abuse but is not proof of caller identity,
is not shared across instances, and does not prevent distributed abuse. Restrict
Zoho OAuth scopes, monitor safe usage metrics, and configure edge-level
protections if stronger caller identity or abuse controls become necessary.
These endpoints cannot create, update, or delete CRM records through the
exposed query contract; the Audit Log endpoint returns audit data available to
the configured Zoho identity.

Do not log or return Zoho tokens, client secrets, environment values, API keys,
Authorization headers, raw Axios responses, or signed download URLs. Never
place secrets in request bodies or query strings. Continue rotating server-side
credentials through deployment secrets rather than source files.

## Credential exposure requiring rotation

A tracked `.env` in the nested Copilot skills submodule contained non-placeholder
Zoho client-secret, refresh-token, and access-token values. The working copy was
removed and an ignore rule added, but the values remain in that submodule's Git
history. Treat them as compromised: revoke/rotate the client secret and refresh
token, invalidate the access token, and purge the exposed values from the
submodule's history before distributing a cleaned revision. The rotation and
history cleanup must be completed by an authorized maintainer; no credential
values are reproduced here.

## Power Platform rollout

For each backend custom connector, remove its security definition and all
operation-level security requirements, then save/update the connector. Recreate
the connection if Power Platform requires it and refresh/reselect the action in
the agent. Verify a successful action call with neither `x-api-key` nor
`Authorization` in the generated request. This repository change updates the
OpenAPI definitions; it cannot update or verify a live Power Platform connector.
