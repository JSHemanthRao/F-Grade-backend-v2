# Zoho Books architecture and status

## Domain boundary

The backend now keeps Zoho CRM and Zoho Books as separate domains:

- CRM uses the existing Zoho CRM OAuth, metadata, module mapping, and read-only query pipeline.
- Books uses a separate Books-only OAuth config, Books service layer, Books validator, Books metadata handling, and Books routes.

The Books domain intentionally does not share CRM module logic, CRM record mutation rules, or a merged Zoho service.

## Supported and enforceable Books behavior

- Read-only GET operations only.
- Module allowlist with explicit Books modules.
- Metadata-driven field resolution for standard and custom modules.
- Safe pagination and sorting controls.
- Read-only history/comments access where Zoho Books exposes those endpoints.
- No POST, PUT, PATCH, DELETE, or state-changing actions are allowed through this backend.

## Unsupported or not verified

The following remain unsupported or not live-verified in the local codebase unless a real Books OAuth client and an official endpoint are confirmed:

- Global Books audit logs at the organization level
- Deployment or sandbox log endpoints
- Payment state-changing APIs
- UI navigation-only concepts such as Dashboard or CRM tabs
- Custom module APIs without a confirmed module_api_name from Zoho metadata

## Read-only security rule

The Books service must be allowlisted and must reject any operation that is not an official, read-only, GET-based Books read.

## OAuth configuration

Expected environment variables:

- BOOKS_CLIENT_ID
- BOOKS_CLIENT_SECRET
- BOOKS_REFRESH_TOKEN
- BOOKS_ORGANIZATION_ID
- BOOKS_ACCOUNTS_URL
- BOOKS_API_BASE_URL

These are deliberately separate from the CRM OAuth settings.
