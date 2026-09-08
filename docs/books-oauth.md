# Zoho Books OAuth and scopes

## OAuth separation

Zoho Books uses a dedicated configuration path and must not reuse the CRM refresh token or client settings.

## Required read-only scope posture

The implementation is intentionally scoped to read access only. This backend never requests or performs create, update, delete, or state-changing Books actions.

## Environment variables

- BOOKS_CLIENT_ID
- BOOKS_CLIENT_SECRET
- BOOKS_REFRESH_TOKEN
- BOOKS_ORGANIZATION_ID
- BOOKS_ACCOUNTS_URL
- BOOKS_API_BASE_URL

## Status

- CODE VERIFIED: separate Books config and service plumbing
- LIVE VERIFIED: not yet, pending an actual Books OAuth client and environment
- UNSUPPORTED: any Books write action or payment-state change
