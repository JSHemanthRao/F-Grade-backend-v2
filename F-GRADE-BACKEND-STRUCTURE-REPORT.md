# F-Grade Backend Structural Report

Inspection was read-only. No backend source, configuration, OAuth, token, or test files were modified. No `.env` values are included.

## 1. Complete Project Tree

```text
F-Grade Backend/
├── package.json
├── package-lock.json
├── crm.openapi.json
├── README.md
├── SPEC_IMPLEMENTATION.md
├── .env.example
├── .gitignore
├── .vscode/
│   ├── settings.json
│   └── extensions.json 
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   │   ├── env.js
│   │   └── zoho.config.js
│   ├── constants/
│   │   ├── crmModules.js
│   │   └── crmOperators.js
│   ├── controllers/
│   │   └── crm.controller.js
│   ├── middleware/
│   │   ├── errorHandler.js
│   │   └── requestLogger.js
│   ├── routes/
│   │   ├── crm.routes.js
│   │   ├── health.routes.js
│   │   └── skills.routes.js
│   ├── services/
│   │   ├── backendClient.js
│   │   ├── coql.service.js
│   │   ├── crm.service.js
│   │   ├── zohoAuth.service.js
│   │   └── zohoCrm.service.js
│   ├── skills/loader.js
│   ├── stdio/server.js
│   ├── tools/crmTool.js
│   ├── utils/
│   │   ├── circuitBreaker.js
│   │   ├── errors.js
│   │   ├── logger.js
│   │   └── zohoRecord.js
│   └── validators/crmQuery.validator.js
├── scripts/check-zoho-auth.js
├── test/
│   ├── backendClient.test.js
│   ├── circuitBreaker.test.js
│   ├── crm.test.js
│   ├── foundation.test.js
│   └── zoho.service.test.js
├── docs/assistant-sample.json
├── diagnostics.json
├── tmp_assistant_body.json
├── test-output.txt
└── suite-output.txt
```

Additional bundled repositories:

```text
aitour-building-copilots-with-copilot-studio/
├── lab/lab-default/
├── lab/lab-dev/
└── src/ContosoApiApp/       # Separate .NET tutorial application

copilot-studio-agent-skills-main/
└── skills/                  # Separate reference documentation
```

The tutorial repository is not the Node backend, but its skills directory is the default runtime source for `/api/skills`.

## 2. File-by-File Purpose

### Root files

- `package.json`: Node metadata, npm scripts, dependencies, Node `>=20` requirement.
- `package-lock.json`: Locked npm dependency tree.
- `crm.openapi.json`: The single authoritative OpenAPI 3.0.3 CRM assistant contract.
- `.env.example`: Environment-variable names and example configuration.
- `.gitignore`: Ignores `.env`, `node_modules`, logs, temporary files, and Python artifacts.
- `README.md`: Mostly repeated repository title text; no useful architecture documentation.
- `SPEC_IMPLEMENTATION.md`: Describes a larger architecture whose referenced files are absent from the active backend.
- `docs/assistant-sample.json`: Saved assistant response example.
- `diagnostics.json`: Saved diagnostics response artifact.
- `tmp_assistant_body.json`: Saved assistant request example.
- `test-output.txt` and `suite-output.txt`: Saved historical test/log artifacts.

### Application/configuration

- `src/app.js`: Creates Express app, installs CORS, logging, JSON parsing, routes, 404 handling, and error handling. Used by `src/server.js` and tests.
- `src/server.js`: Starts HTTP server on `0.0.0.0`, uses configured `PORT`, handles port errors and shutdown signals.
- `src/config/env.js`: Loads dotenv and parses runtime settings.
- `src/config/zoho.config.js`: Resolves Zoho API/accounts URLs and required OAuth settings.

### Constants/validation

- `src/constants/crmModules.js`: Static module names, fields, and API mappings. Exports `CRM_MODULES` and `CRM_API_NAMES`.
- `src/constants/crmOperators.js`: Supported filter operators. Exports `CRM_OPERATORS`.
- `src/validators/crmQuery.validator.js`: Validates modules, fields, filters, aggregates, sorting, limits, and offsets.

### Routes/controllers

- `src/routes/crm.routes.js`: Mounts CRM routes: `/query`, `/test`, `/diagnostics`, `/assistant`, and `/assistant/fast-summary`.
- `src/routes/health.routes.js`: Implements `GET /health/`.
- `src/routes/skills.routes.js`: Implements skill listing and file-reading routes.
- `src/controllers/crm.controller.js`: HTTP handlers, natural-language planning, date parsing, module detection, aggregation detection, conversation follow-ups, dashboard formatting, and answer generation.

### Middleware/utilities

- `src/middleware/errorHandler.js`: Converts exceptions into JSON error responses.
- `src/middleware/requestLogger.js`: Logs request method, URL, status, and duration.
- `src/utils/errors.js`: Creates structured application errors.
- `src/utils/logger.js`: Basic console and request logging.
- `src/utils/circuitBreaker.js`: Closed/open/half-open circuit breaker for transient upstream failures.
- `src/utils/zohoRecord.js`: Sanitizes Zoho records and lookup objects.

### Services

- `src/services/zohoAuth.service.js`: Refresh-token OAuth, access-token cache, expiry handling, concurrent refresh protection, and token invalidation.
- `src/services/zohoCrm.service.js`: Low-level Zoho client for records, COQL, aggregates, counts, search, users, modules, and fields.
- `src/services/crm.service.js`: Main CRM business service and analysis engine.
- `src/services/coql.service.js`: Generates COQL and search/count criteria from structured filters.
- `src/services/backendClient.js`: HTTP client used by MCP tooling to call the assistant endpoint.

### STDIO/skills

- `src/stdio/server.js`: MCP server over STDIO using `@modelcontextprotocol/sdk`.
- `src/tools/crmTool.js`: Implements the MCP `query_crm` tool.
- `src/skills/loader.js`: Reads skill directories and files from `SKILLS_PATH`.

### Tests/scripts

- `test/foundation.test.js`: HTTP routes, planner, validation, dashboard responses, and OpenAPI expectations.
- `test/zoho.service.test.js`: CRM service, OAuth cache, COQL, metadata, pagination, aggregation, and conversion behavior.
- `test/backendClient.test.js`: Backend URL construction and error handling.
- `test/circuitBreaker.test.js`: Circuit-breaker behavior.
- `test/crm.test.js`: Direct legacy mock-controller test.
- `scripts/check-zoho-auth.js`: Checks whether the OAuth service can authenticate.

## 3. Backend Entry Point

- Main application factory: `src/app.js`
- HTTP startup: `src/server.js`
- Framework: Express 4
- Default port: `3000`
- Configurable port: `PORT`
- Bind address: `0.0.0.0`

Routes:

```text
GET  /health/
GET  /api/skills/
GET  /api/skills/:skill
GET  /api/skills/:skill/file?name=...
POST /api/crm/query
POST /api/crm/test
GET  /api/crm/diagnostics
POST /api/crm/assistant
POST /api/crm/assistant/fast-summary
```

Request flow:

```text
HTTP request
  -> Express app
  -> route
  -> CrmController
  -> CrmService
  -> validation/planning
  -> ZohoCrmService
  -> ZohoAuthService
  -> Zoho CRM API
  -> record sanitization
  -> JSON response
```

## 4. Zoho OAuth Structure

OAuth is implemented in `src/services/zohoAuth.service.js`.

Behavior:

1. `getAccessToken()` loads configuration.
2. A cached token is reused while outside a five-minute expiry buffer.
3. Concurrent refreshes share one promise.
4. Refresh uses `grant_type=refresh_token`.
5. The returned access token and `api_domain` are cached in memory.
6. A `401` response clears the cache.
7. The next request refreshes automatically.

OAuth endpoint:

```text
POST {accountsUrl}/oauth/v2/token
```

Domains:

- Explicit accounts override: `ZOHO_ACCOUNTS_URL`
- Default accounts domain: `https://accounts.zoho.com`
- Default API domain: `https://www.zohoapis.com/crm/v8`
- API domain can be configured through `ZOHO_API_BASE_URL` or `ZOHO_API_DOMAIN`.

OAuth variable names:

```text
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
ZOHO_ACCOUNTS_URL
ZOHO_API_BASE_URL
ZOHO_API_DOMAIN
```

Legacy fallbacks:

```text
CLIENT_ID
CLIENT_SECRET
REFRESH_TOKEN
```

OAuth scopes:

- No explicit `scope` parameter is requested in source code.
- Calls inherit scopes already granted to the refresh token.
- Token payload scope fields may be logged for diagnostics.
- No individual API method declares its own OAuth scope.

## 5. Zoho CRM API Structure

All CRM calls use the cached token in:

```text
Authorization: Zoho-oauthtoken <access token>
```

### Records

- `ZohoCrmService.query` -> POST `/coql`
- Unsupported-COQL fallback -> GET `/{module}`
- `getRecordsByIds` -> GET `/{module}?ids=...&fields=...`

### Module metadata

- `getModulesMetadata` -> GET `/settings/modules`

### Fields metadata

- `getFieldMetadata` -> GET `/settings/fields?module=...`
- `getCoqlSafeFields` filters metadata locally for COQL-safe types.

### COQL

- `executeQueryRequest` -> POST `/coql`
- `aggregate` -> POST `/coql`

### Search

- `searchRecords` -> GET `/{module}/search`

### Bulk Read

```text
NOT IMPLEMENTED
```

### Users

- `getUsers` -> GET `/users?type=AllUsers`
- `resolveUserId` converts owner names to Zoho user IDs.

### Organization

```text
NOT IMPLEMENTED
```

### Audit Logs

```text
NOT IMPLEMENTED as a Zoho Audit Logs API
```

The “today activity” report queries Meetings, Calls, Tasks, Notes, and discovered modules. It does not call an audit-log endpoint.

### Files

```text
NOT IMPLEMENTED
```

No file, attachment, upload, or download APIs exist.

## 6. Module Resolution

Static mappings are in `src/constants/crmModules.js`:

```text
Meetings          -> Events
Sales Orders      -> Sales_Orders
Purchase Orders   -> Purchase_Orders
Renewal Accounts  -> Renewal_Accounts
Leads             -> Leads
Deals             -> Deals
```

`resolveModuleApiName` behavior:

1. Check hard-coded `CRM_API_NAMES`.
2. If absent, request `/settings/modules`.
3. Match `api_name`, `module_name`, `plural_label`, or `singular_label`.
4. Return the live API name.
5. If no match exists, return the normalized input unchanged.

This is partially hard-coded and partially metadata-driven.

Risks:

- Static mappings take precedence over live metadata.
- Custom labels may not match static assumptions.
- Public structured record requests restrict modules using `STRICT_MODULES`.
- Dynamic activity analysis can support custom modules differently from ordinary record requests.

## 7. Field Resolution

Static fields are defined in `CRM_MODULES` using Zoho API names such as:

```text
Created_Time
Modified_Time
Closing_Date
Deal_Name
Lead_Source
Account_Name
```

Dynamic fields are obtained from:

```text
GET /settings/fields?module={module}
```

Metadata is stored in an in-memory `Map` with a TTL controlled by `ZOHO_METADATA_TTL_MS`.

There is no general display-label conversion:

```text
"Created Time"  -> not automatically converted
"Created_Time"  -> accepted API field name
```

Custom fields are partially supported through live metadata, but strict validation still uses static mappings for known modules and public structured record requests.

## 8. COQL Implementation

COQL generation is in `src/services/coql.service.js`.

Functions:

- `buildCoqlQuery`
- `buildFilterClauses`
- `buildWhereClause`
- `buildModuleCriteria`
- `buildCriteria`
- `formatValue`
- `formatComparisonValue`

Supported operators:

```text
equals, not_equals, contains, starts_with,
greater_than, less_than, greater_equal, less_equal,
in, between, is_null, is_not_null
```

Records use:

```text
select field1, field2 from Module where ... order by ...
```

Aggregates use:

```text
select SUM(Amount) from Deals where ...
select Owner, SUM(Amount) from Deals where ... group by Owner
```

An unfiltered query receives `(id is not null)`.

Pagination is appended as:

```text
limit {offset}, {limit}
```

Default limit is `20`; validated maximum is `200`.

Grouping is used for lead-source and deal-owner reports. There are no SQL-style joins. Lookup relationships use metadata plus separate Search and record-by-ID calls.

Errors are retried when transient, protected by a circuit breaker, and converted to application errors. A `401` clears the access-token cache. Unsupported COQL fields may fall back to the REST records endpoint.

## 9. Query Routing

There is no general intelligent API router.

```text
Natural-language records -> regex planner -> COQL records
Count request           -> Zoho module count endpoint
Aggregate request       -> aggregate COQL
Relationship search      -> Zoho Search API
Records by IDs           -> REST records API
Today activity           -> multiple count/query calls
Large record retrieval   -> repeated COQL pages
Bulk dataset             -> NOT IMPLEMENTED
```

The planner is implemented by `planQuestion` in `src/controllers/crm.controller.js`.

## 10. Copilot Studio/OpenAPI

`crm.openapi.json` documents the single Copilot operation:

```text
POST /api/crm/assistant
```

Operation IDs:

```text
askCrmAssistant
```

`AssistantRequest` properties:

```text
question
conversation_id
module
request_type
analysis
query
limit
offset
```

Responses document `200`, `400`, and `502` responses.

Authentication is not defined in the OpenAPI document. The Express application also has no authentication middleware. `BackendClient` can send `BACKEND_API_KEY`, but the server does not enforce it.

Flow:

```text
Copilot Studio
  -> OpenAPI tool
  -> POST /api/crm/assistant
  -> crm.controller.assistant
  -> planQuestion
  -> CrmService.query
  -> ZohoCrmService
  -> Zoho OAuth
  -> Zoho CRM
  -> JSON response
  -> Copilot Studio
```

OpenAPI mismatch:

- Live health, skills, query, test, and diagnostics routes are undocumented.
- Current OpenAPI uses `components.schemas`.
- Tests expect a legacy `definitions` structure and extra Copilot metadata.
- Two current tests fail because of this mismatch.

## 11. STDIO/MCP

STDIO is implemented.

Files:

```text
src/stdio/server.js
src/tools/crmTool.js
src/services/backendClient.js
```

Protocol:

```text
Model Context Protocol over STDIO
```

Tool:

```text
query_crm
```

Flow:

```text
MCP client
  -> query_crm
  -> CrmTool
  -> BackendClient
  -> POST /api/crm/assistant
  -> backend result
```

The MCP server does not call Zoho directly.

## 12. Test Structure

Tests cover:

- Health endpoint
- CRM routes
- Assistant route and aliases
- Follow-up questions
- Natural-language planning
- Counts and aggregates
- Lead conversion analysis
- Dashboard responses
- Query validation
- COQL generation
- OAuth cache and refresh behavior
- Dynamic module metadata
- Dynamic activity modules
- Pagination
- Owner resolution
- Search and record-by-ID relationship logic
- Backend client errors
- Circuit-breaker transitions

OAuth is tested with mocks, not against live Zoho.

Current test result:

```text
99 tests
97 passing
2 failing
0 skipped
```

The failures are in `test/foundation.test.js`:

1. The CRM contract is maintained in `crm.openapi.json`.
2. Expected legacy `definitions.AssistantRequest` and `definitions.AssistantResponse` are absent.

## 13. Configuration

Runtime:

```text
Node.js >= 20
Express 4
CommonJS modules
Node built-in test runner
```

Dependencies:

```text
express
axios
cors
dotenv
@modelcontextprotocol/sdk
```

Development dependency:

```text
@microsoft/agents-copilotstudio-client
```

No linting or formatting scripts are defined.

Environment variable names:

```text
NODE_ENV
PORT
REQUEST_BODY_LIMIT
LOG_LEVEL
CORS_ORIGIN

ZOHO_ACCOUNTS_URL
ZOHO_API_BASE_URL
ZOHO_API_DOMAIN
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
CLIENT_ID
CLIENT_SECRET
REFRESH_TOKEN

ZOHO_REQUEST_TIMEOUT_MS
ZOHO_MAX_RETRIES
ZOHO_CIRCUIT_FAILURE_THRESHOLD
ZOHO_CIRCUIT_RESET_TIMEOUT_MS
ZOHO_MAX_CONCURRENCY
ZOHO_MAX_QUERY_BUDGET
ZOHO_METADATA_TTL_MS
USE_ZOHO_METADATA_FOR_STATIC_MODULES

BACKEND_API_URL
BACKEND_API_PATH
BACKEND_API_KEY
BACKEND_REQUEST_TIMEOUT_MS
BACKEND_DIAGNOSTICS

SKILLS_PATH
```

## 14. Documentation

`SPEC_IMPLEMENTATION.md` describes an intended larger system containing central intent resolution, phonetic correction, conversation context, date detection, business criteria, stage history, retrieval, dashboards, metadata services, and 371 tests.

Those referenced files are absent from the active root backend, including:

```text
src/crm/services/intent-resolution.service.js
src/crm/services/retrieval-engine.service.js
src/crm/services/dashboard.service.js
src/crm/services/crm-metadata.service.js
```

The actual implementation uses one Express app, a controller regex planner, `CrmService`, `ZohoCrmService`, static constants, optional live metadata, COQL, and an MCP wrapper.

The specification is stale, copied from another implementation, or describes an architecture that was never merged.

## 15. Current Architecture Diagram

```text
HTTP Client / Copilot Studio
        |
        v
OpenAPI-described POST /api/crm/assistant
        |
        v
src/controllers/crm.controller.js
        |
        +--> planQuestion()
        |       +--> records
        |       +--> count
        |       +--> aggregate
        |       +--> analysis workflows
        |
        v
src/services/crm.service.js
        |
        +--> crmQuery.validator.js
        +--> coql.service.js
        +--> metadata and owner resolution
        |
        v
src/services/zohoCrm.service.js
        |
        +--> COQL
        +--> records
        +--> search
        +--> count
        +--> users
        +--> module metadata
        +--> field metadata
        |
        v
src/services/zohoAuth.service.js
        |
        +--> refresh token
        +--> cached access token
        |
        v
Zoho CRM
        |
        v
Sanitized response
        |
        v
Express JSON response
```

## 16. Current Status

| Component | Status | Notes |
|---|---|---|
| OAuth | Working/Partial | Refresh, caching, expiry buffer, concurrent refresh, and 401 invalidation exist. |
| Records API | Working | COQL records with REST fallback. |
| Count API | Working | Uses Zoho module count endpoint. |
| Aggregate API | Working | Uses COQL aggregates. |
| Module metadata | Working/Partial | Dynamic metadata exists, but public validation remains statically restricted. |
| Field metadata | Working/Partial | Live metadata and caching exist; no label conversion. |
| COQL | Working | Structured generation, validation, pagination, and aggregation. |
| Search | Working/Partial | Primarily used for lead/deal relationships. |
| Bulk Read | Not implemented | No endpoint or service function. |
| Users | Working | Used for owner resolution. |
| Organization | Not implemented | No organization endpoint. |
| Audit Logs | Not implemented | Today activity is module-record aggregation, not Zoho audit logs. |
| Files | Not implemented | No file or attachment APIs. |
| OpenAPI | Partial/Broken contract | Documents two endpoints but does not match current tests. |
| Copilot integration | Partial | Assistant endpoint exists; no server-side auth scheme. |
| STDIO/MCP | Working | One `query_crm` tool. |
| Error handling | Working/Partial | Centralized errors; no HTTP auth errors because auth middleware is absent. |
| Tests | Partial | 97 of 99 tests pass. |
| Documentation | Broken/Stale | Specification describes missing architecture and outdated test counts. |

## 17. Problems Found

### HIGH

1. OpenAPI contract and tests are inconsistent.
2. No HTTP authentication middleware is mounted.
3. The mock CRM endpoint is mounted unconditionally.

### MEDIUM

4. Static and dynamic module resolution are inconsistent.
5. No display-label-to-API-field conversion exists.
6. OpenAPI documents only two of the live route families.
7. `SPEC_IMPLEMENTATION.md` references missing source files and outdated test counts.
8. The skills loader silently returns empty arrays if its configured directory is unavailable.

### LOW

9. Saved artifacts do not consistently represent current source behavior.
10. No linting or formatting command is defined.

## 18. Final Structure Summary

### A. Current backend architecture

Node.js CommonJS Express backend with regex-based natural-language planning, structured validation, COQL, Zoho REST APIs, refresh-token authentication, metadata handling, and an MCP STDIO wrapper.

### B. Main entry point

`src/server.js`

### C. Main CRM service

`src/services/crm.service.js`

### D. OAuth service

`src/services/zohoAuth.service.js`

### E. Query service

`src/services/zohoCrm.service.js`

COQL construction is delegated to `src/services/coql.service.js`.

### F. Metadata service

There is no separate metadata service. Metadata is implemented in:

```text
src/services/zohoCrm.service.js
src/constants/crmModules.js
src/validators/crmQuery.validator.js
```

### G. OpenAPI entry point

`crm.openapi.json`

### H. Test entry point

```text
npm test
```

### I. Important files likely to be modified later

```text
src/controllers/crm.controller.js
src/services/crm.service.js
src/services/zohoCrm.service.js
src/services/coql.service.js
src/validators/crmQuery.validator.js
src/constants/crmModules.js
crm.openapi.json
test/foundation.test.js
test/zoho.service.test.js
```

### J. Files that should probably remain untouched

Unless corresponding behavior is intentionally changed:

```text
src/services/zohoAuth.service.js
src/utils/circuitBreaker.js
src/utils/zohoRecord.js
src/middleware/errorHandler.js
package-lock.json
diagnostics.json
test-output.txt
suite-output.txt
```
