# Copilot Studio CRM JSON Pagination

The CRM pagination contract is now deterministic and structured. Copilot Studio must send a complete CRM JSON request on every CRM call.

Do not use:

- `continuation_token`
- `conversation_id`
- Redis pagination state
- user-provided internal IDs

## Request Shape

Use this shape for every CRM record page:

```json
{
  "schema_version": "1.0",
  "request": {
    "module": "Deals",
    "operation": "list"
  },
  "query": {
    "fields": ["Deal_Name", "Account_Name", "Stage", "Amount", "Created_Time"],
    "filters": {
      "Created_Time": {
        "operator": "this_month"
      }
    },
    "sort": [
      { "field": "Created_Time", "order": "desc" },
      { "field": "id", "order": "desc" }
    ]
  },
  "pagination": {
    "limit": 20,
    "offset": 0
  }
}
```

## Continuation Rules

For `next`, preserve the previous query exactly and use the previous limit.

For `next N`, preserve the previous query exactly and set `pagination.limit = N`.

Always set the next offset from the previous backend response:

```text
next offset = previous pagination.next_offset
```

Do not calculate the next offset as `previous offset + previous limit`. Use `previous returned`, which the backend already exposes through `next_offset`.

## Query Preservation

On continuation, preserve:

- `request.module`
- `request.operation`
- `query.fields`
- `query.filters`
- `query.sort`
- `query.grouping`

Only `pagination.limit` and `pagination.offset` may change.

## Query Fingerprint

The backend returns:

```json
{
  "query": {
    "fingerprint": "sha256..."
  }
}
```

Copilot may send that value back as:

```json
{
  "query_context": {
    "fingerprint": "sha256..."
  }
}
```

This is an integrity check only. It is not a continuation token.

## Acceptance Trace

Run this conversation and inspect the actual Ask Zoho CRM inputs:

```text
Give me deals created this month
next 20
next 20
next 20
Give me leads created this month
next 20
```

Expected CRM JSON pagination:

```text
Deals page 1: offset 0, limit 20
Deals page 2: offset 20, limit 20
Deals page 3: offset 40, limit 20
Deals page 4: offset 60, limit 20
Leads page 1: offset 0, limit 20
Leads page 2: offset 20, limit 20
```

The Activity Map must show no `continuation_token`, no `conversation_id`, no manual state ID, and no repeated page-one request for continuation turns.
