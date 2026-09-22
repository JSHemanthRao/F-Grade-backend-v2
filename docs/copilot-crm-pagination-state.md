# Copilot Studio CRM Pagination State

The CRM backend pagination algorithm is already stateful and token based. Copilot Studio must not ask the user for pagination state and must not rely on generative slot filling for state values.

## Internal Variables

Create these Copilot Studio variables:

| Variable | Purpose | User-facing |
| --- | --- | --- |
| `CRM_ContinuationToken` | Stores the latest `continuation_token` returned by Ask Zoho CRM. | No |
| `CRM_ConversationId` | Stores the first `conversation_id` returned by Ask Zoho CRM. | No |

Do not configure either variable as "Dynamically fill with AI".

## Action Input Binding

Configure the Ask Zoho CRM action inputs like this:

| Tool input | Binding |
| --- | --- |
| `question` | The user's exact CRM message. This can be dynamically filled from the user message. |
| `continuation_token` | `CRM_ContinuationToken` only. Never user-filled. |
| `conversation_id` | `CRM_ConversationId` only. Never user-filled. |

For a first query such as `Give me deals created this month`, clear `CRM_ContinuationToken` before calling the action. The request body should contain only the natural-language question unless `CRM_ConversationId` is already being used as a stable session key by the topic.

For a continuation such as `next 20`, `continue`, `show more`, `another 20`, or `yes fetch the next set`, call Ask Zoho CRM with:

```json
{
  "question": "next 20",
  "continuation_token": CRM_ContinuationToken,
  "conversation_id": CRM_ConversationId
}
```

Copilot Studio must never calculate `offset`. The backend calculates it from the stored token state and requested page size.

## Response Handling

After every successful Ask Zoho CRM response:

1. Set `CRM_ConversationId` from `response.conversation_id` if it is empty.
2. Replace `CRM_ContinuationToken` with `response.continuation_token`.
3. Send only `response.answer` to the user.

Token rotation is required:

```text
Page 1 response -> CRM_ContinuationToken = T1
Page 2 request  -> continuation_token = T1
Page 2 response -> CRM_ContinuationToken = T2
Page 3 request  -> continuation_token = T2
```

## New Query Reset

When the user starts a new CRM query, such as switching from deals to leads, clear `CRM_ContinuationToken` before calling Ask Zoho CRM. Do not send an old deals token with a new leads query.

Keep `CRM_ConversationId` only as the current Copilot conversation/session identifier. Do not let the LLM generate or rewrite it.

## Debug Checklist

Use Copilot Studio test traces to inspect the actual Ask Zoho CRM action inputs:

| Turn | Expected action inputs |
| --- | --- |
| `Give me deals created this month` | `question = Give me deals created this month` |
| `next 20` | `question = next 20`, `continuation_token = T1`, `conversation_id = C1` |
| `next 20` | `question = next 20`, `continuation_token = T2`, `conversation_id = C1` |

If a continuation action shows only `question`, the state variables are not bound to the connector action. If `continuation_token` and `conversation_id` are present but blank, the variables are not being populated from the previous CRM response.

## Acceptance Conversation

Run this exact conversation:

```text
1. Give me deals created this month
2. next 20
3. next 20
4. next 20
5. next 20
```

Expected backend offsets:

```text
0, 20, 40, 60, 80
```

Expected connector token inputs:

```text
Page 2 -> T1
Page 3 -> T2
Page 4 -> T3
Page 5 -> T4
```
