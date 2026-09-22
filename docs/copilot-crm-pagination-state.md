# Copilot Studio CRM Pagination State

The CRM backend pagination algorithm is already stateful and token based. Copilot Studio must not ask the user for pagination state and must not rely on generative slot filling for state values.

## Internal Variables

Create these global Copilot Studio variables:

| Variable | Purpose | User-facing |
| --- | --- | --- |
| `bot.CRMContinuationToken` | Stores the latest `continuation_token` returned by Ask Zoho CRM. | No |
| `bot.CRMConversationId` | Stores the latest `conversation_id` returned by Ask Zoho CRM. | No |

Both variables must be String variables and must be available across CRM topics and tool calls. Do not configure either value as "Dynamically fill with AI", and never ask the user to provide either value.

## Action Input Binding

Configure the Ask Zoho CRM action inputs like this:

| Tool input | Binding |
| --- | --- |
| `question` | The user's exact CRM message. This can be dynamically filled from the user message. |
| `continuation_token` | Custom value: `bot.CRMContinuationToken`. Never dynamically filled by AI and never user-filled. |
| `conversation_id` | Custom value: `bot.CRMConversationId`. Never dynamically filled by AI and never user-filled. |

For a first query such as `Give me deals created this month`, clear `bot.CRMContinuationToken` before calling the action. Do not send an old continuation token or an old pagination conversation ID for a genuinely new CRM query.

For a continuation such as `next 20`, `continue`, `show more`, `another 20`, or `yes fetch the next set`, call Ask Zoho CRM with:

```json
{
  "question": "next 20",
  "continuation_token": "<VALUE OF bot.CRMContinuationToken>",
  "conversation_id": "<VALUE OF bot.CRMConversationId>"
}
```

Copilot Studio must never calculate `offset`. The backend calculates it from the stored token state and requested page size.

## Response Handling

After every successful Ask Zoho CRM response:

1. Set `bot.CRMConversationId` from `response.conversation_id`.
2. Replace `bot.CRMContinuationToken` with `response.continuation_token`.
3. Send only `response.answer` to the user.

Token rotation is required:

```text
Page 1 response -> bot.CRMContinuationToken = T1
Page 2 request  -> continuation_token = T1
Page 2 response -> bot.CRMContinuationToken = T2
Page 3 request  -> continuation_token = T2
```

Do not keep using an old token after a newer page returns a replacement token.

If `response.pagination.more_records = false` or `response.continuation_token` is empty, clear `bot.CRMContinuationToken`. A later `next 20` should not send an expired token; the agent should tell the user there are no more records.

## New Query Reset

When the user starts a new CRM query, such as switching from deals to leads, clear `bot.CRMContinuationToken` and `bot.CRMConversationId` before calling Ask Zoho CRM. Do not send an old deals token with a new leads query.

Do not clear the token merely because the tool returned or because a user turn ended. Clear or replace it only when:

1. A new CRM query starts.
2. The backend says pagination is exhausted.
3. The backend says the pagination state is expired or invalid.

Do not let the LLM generate, rewrite, decode, or summarize either state value.

## Continuation Topic Fallback

If the Ask Zoho CRM tool UI does not allow direct selection of `bot.CRMContinuationToken` and `bot.CRMConversationId` as custom values, create a dedicated CRM Pagination topic instead of switching those inputs to dynamic AI filling.

The topic should:

1. Trigger on CRM continuation phrases such as `next`, `next 20`, `next 50`, `next page`, `continue`, `show more`, `show me the next 20`, `give me the next set`, and `fetch the next batch`.
2. Read `bot.CRMContinuationToken` and `bot.CRMConversationId`.
3. Call Ask Zoho CRM with the user's continuation text plus both stored values.
4. Store the returned `continuation_token` and `conversation_id` back into the global variables.
5. Clear `bot.CRMContinuationToken` when the backend reports no more records or invalid pagination state.

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

Then run a new-query reset test:

```text
1. Give me deals created this month
2. next 20
3. next 20
4. Give me leads created this month
5. next 20
```

Expected behavior:

```text
Deals page 1 -> offset 0
Deals page 2 -> offset 20
Deals page 3 -> offset 40
Leads page 1 -> new pagination state, offset 0
Leads page 2 -> Leads continuation token, offset 20
```

No Deals token should be sent with the Leads query. Do not declare the Copilot Studio fix complete until the Activity Map proves that the second CRM call contains the previous page's `continuation_token` and `conversation_id`.
