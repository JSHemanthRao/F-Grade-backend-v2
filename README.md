# F-Grade CRM Backend

Read-only Express backend for natural-language access to Zoho CRM, with a separate Zoho Books query surface and an MCP stdio wrapper for CRM.

## Architecture

```text
HTTP client / Copilot Studio / MCP client
                 |
                 v
      Express routes or MCP stdio tool
                 |
                 v
      CRM controller -> assistant coordinator
                 |
                 v
  question planner -> canonical query plan -> pagination state
                 |
                 v
 CRM service -> metadata/field resolution -> validation -> query execution
                 |
                 v
  Zoho CRM service -> OAuth refresh cache -> Zoho REST / COQL / Bulk APIs
```

The layers have distinct responsibilities:

- `src/app.js` configures HTTP middleware and mounts routes.
- `src/controllers/` owns HTTP request/response handling and presentation helpers.
- `src/services/crmAssistant.service.js` coordinates planning, follow-ups, pagination, diagnostics, and answers.
- `src/planners/` and `src/query/` convert natural language to a canonical, read-only plan.
- `src/services/crm.service.js` resolves live metadata, validates plans, and performs CRM analysis workflows.
- `src/services/zohoCrm.service.js` is the Zoho CRM transport boundary. It owns OAuth-backed REST, COQL, metadata, search, and bulk-read calls.
- `src/services/zohoBooks.service.js` is the independent Zoho Books transport boundary.
- `src/stdio/` exposes the CRM assistant through MCP over stdio.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness response |
| `POST` | `/api/crm/assistant` | Natural-language, read-only CRM query |
| `POST` | `/api/crm/query` | Structured CRM query |
| `POST` | `/api/crm/assistant/fast-summary` | CRM summary workflow |
| `GET` | `/api/crm/metadata` | Live CRM module or field metadata |
| `POST` | `/api/crm/metadata/refresh` | Refresh metadata cache |
| `POST` | `/api/books/query` | Structured, read-only Books query |
| `GET` | `/api/skills` | Available local skill folders |

For assistant follow-ups such as `next page`, `continue`, or `proceed`, pass the latest `continuation_token` returned by the previous assistant response. Also pass the same `conversation_id` on every request when available. In Copilot Studio these values must be bound from internal variables, not filled by generative AI and not requested from the user. See [docs/copilot-crm-pagination-state.md](docs/copilot-crm-pagination-state.md).

## Local development

Requirements: Node.js 20 or newer and valid Zoho credentials for the integrations you intend to use.

```bash
npm install
copy .env.example .env
npm run dev
```

Run the test suite with:

```bash
npm test
```

On Windows systems where PowerShell blocks `npm.ps1`, use `npm.cmd test`.

Run the MCP server with:

```bash
npm run mcp
```

## Configuration

Copy `.env.example` and provide only the credentials needed by the enabled integrations. Never commit `.env`.

- CRM requires `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN`.
- Books routes additionally require `BOOKS_CLIENT_ID`, `BOOKS_CLIENT_SECRET`, `BOOKS_REFRESH_TOKEN`, and `BOOKS_ORGANIZATION_ID`.
- Set `BACKEND_API_KEY` in every shared or deployed environment. Requests under `/api` then require `x-api-key` or `Authorization: Bearer <key>`.
- Set `CORS_ORIGIN` to the specific caller origin in production instead of `*`.
- Set `CRM_TIMEZONE` to the business timezone used when converting date-only CRM filters to datetime bounds.
- Set `REDIS_URL` and optionally `REDIS_PREFIX` when pagination must survive restarts or be shared across Render instances. Without Redis, pagination uses bounded in-memory state and continuation requests must reach the same process.

## Operational notes

CRM OAuth tokens and CRM metadata are cached in memory. Pagination uses Redis as shared state when configured and falls back to bounded in-memory state otherwise. Each continuation token represents one exact page state; historical tokens are not rewritten to newer pages.

The backend is intentionally read-only. The planner rejects mutation requests before CRM execution, and the public API should be deployed behind TLS, a reverse-proxy rate limit, and an explicit API key.
