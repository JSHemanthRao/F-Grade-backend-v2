---
description: Defines how CRM Activity tool responses must be formatted as formal management reports.
trigger: always_on
---

# CRM Activity Report Response Format

When the CRM Activity tool returns activity data, present the result as a formal management report using the rules below.

## 1. Report Header

Default header (no specific employee requested):

```text
CRM Daily Activity Report
<Date>
```

When a specific employee is requested:

```text
<Employee Name> - CRM Activity Report
```

## 2. Executive Summary

Provide a short executive summary first.

**Example:**
> "Sanjay Raj recorded 18 CRM activities today, including deal updates, meeting activity, and notes."

## 3. Activity Table

Show a clean table with these columns where data is available:

| Employee | Time | Module | Activity | Record | Change/Outcome |

## 4. Language & Terminology Rules

- Use **business-friendly language only**.
- **DO NOT** expose internal implementation terms such as:
  - Deluge Module names
  - Function names (e.g., `addEventsToZohoBookings`)
  - Internal workflow names
  - API names or field API keys
  - Raw system identifiers or internal record IDs

- **Convert** technical/system activity to understandable business language:
  - `"Function addEventsToZohoBookings called"` → `"Meeting information updated"`
  - `"Deluge Module / Automation"` → `"Automation"`

- For **field changes**, use readable language:
  - `"Stage changed from Proposal to Closed Won"` ✅
  - Raw API field name dump ❌

## 5. Grouping & Deduplication

- Do **not** list repeated identical workflow/system actions individually.
- Group repeated actions:
  - `"addEventsToZohoBookings triggered 8 times"` → `"Meeting automation executed 8 times"`
- If there is a large number of records, group them by employee and activity type.

## 6. Human vs. Automation Activity

Distinguish HUMAN activity from SYSTEM/AUTOMATION activity using categories:

- **User Activity**
- **Automation Activity**

Do **not** attribute an automated workflow action to an employee unless the CRM audit data explicitly identifies that employee as the actor.

## 7. Priority for Human Activity

For human activity, prioritize (in this order):

1. Deals created/updated
2. Meetings created/updated
3. Calls
4. Tasks
5. Notes
6. Leads/Contacts/Accounts changes
7. Field changes

## 8. Record IDs

Do **not** display record IDs unless the user explicitly asks for them.

## 9. Activity Summary Section

After the detailed table, provide an **Activity Summary** section.

**Example format:**

```text
Activity Summary
- Deals created: 2
- Deals updated: 4
- Meetings created: 3
- Notes added: 10
- Calls: 2
- Other CRM changes: 5
```

Only include metrics **supported by the returned CRM data**. Never invent or estimate counts.

## 10. Tone

Use a **professional executive tone**: formal, concise, structured, and easy to scan.

## 11. Edge Cases

- If the user asks for **"everything"** or **"all changes"**: provide the full detailed table, but still translate all technical/system actions into business language.
- Do **not** say "there was no activity" when the Activity tool returned records.
- If the Activity tool **fails**: clearly state that CRM activity could not be retrieved. Do not report zero activity.
- When the user asks for **today's activity**: use the Activity tool and summarize the returned data. Do not use the normal CRM Query tool.

## 12. CRM Query Result Handling

- Display only CRM fields that are present in the API response and were requested by the user.
- Never invent, infer, or populate Account Name, Closing Date, Owner, or any other field unless that field was both requested and returned by the CRM API.
- If a requested field is not returned, clearly state that the field was not available.
- Never invent CRM records or answer from knowledge alone when live CRM data is requested. Use the REST API response as the source of truth, specifically its `data` field.

### Pagination

- For every new CRM request, use `limit: 20` and `offset: 0` unless the user explicitly requests another page.
- When the user asks for **"all"**, **"every"**, **"complete"**, **"entire"**, or **"all records"**, do not assume the first response contains every matching record.
- If `pagination.more_records` is `true`, retrieve the next page through the same CRM API when possible. Set `offset` to the current `offset + limit`, while keeping `module`, `fields`, `filters`, and `sort` unchanged.
- Continue until `pagination.more_records` is `false`, subject to reasonable system limits, then combine the returned `data` records before answering.
- Never claim that all records were retrieved while `pagination.more_records` is `true`. If additional pages cannot be retrieved, explicitly state that the result is partial.
- For a continuation request such as **"give me the next 20"**, **"show me more"**, **"next page"**, **"continue"**, or **"give me the next set"**, reuse the immediately previous CRM query exactly and change only `offset` to the previous `offset + limit`.
- Calculate continuation offsets explicitly: previous `offset 0 + limit 20 = next offset 20`; previous `offset 20 + limit 20 = next offset 40`.
- Never restart an explicit continuation at `offset: 0`.
- Do not remove filters, fields, module, or sort settings for a continuation. Never execute a new unfiltered query for **"next 20"**.
- If the user asks for a continuation but there is no previous CRM query and page context available, ask the user which CRM query to continue instead of guessing.
- If `pagination.more_records` is `false`, state that no more records are available when relevant.

### Query Construction

- Always generate Zoho CRM API field names, never display labels. Before adding a field to the `fields` array, verify that it is supported by the selected module's allowed API field mapping.
- Dynamically select fields based on the user's request; do not hardcode only `Deal_Name`, `Amount`, and `Stage` for every request.
- Determine the module, fields, filters, aggregation, grouping, and ranking from the user's intent and the connector metadata; do not hard-code month names, calendar years, or a fixed module-to-field recipe.
- Use the following display-label translations only when the translated API field is present in the selected module's allowed mapping: `Account Name` -> `Account_Name`, `Closing Date` -> `Closing_Date`, `Deal Name` -> `Deal_Name`, `First Name` -> `First_Name`, `Last Name` -> `Last_Name`, `Lead Status` -> `Lead_Status`, `Lead Source` -> `Lead_Source`, `Created Time` -> `Created_Time`, and `Modified Time` -> `Modified_Time`.
- For Deals, the authoritative allowed API fields are: `id`, `Deal_Name`, `Amount`, `Stage`, `Closing_Date`, `Account_Name`, `Type`, `Probability`, `Owner`, `Created_Time`, and `Modified_Time`.
- For Leads, the authoritative allowed API fields are: `id`, `First_Name`, `Last_Name`, `Company`, `Email`, `Phone`, `Lead_Status`, `Lead_Source`, `Owner`, `Created_Time`, `Modified_Time`, `Converted__s`, and `Converted_Date_Time`. Never use any other field for Leads.
- For Contacts, the authoritative allowed API fields are: `id`, `First_Name`, `Last_Name`, `Account_Name`, `Email`, `Phone`, `Title`, `Owner`, `Created_Time`, and `Modified_Time`.
- For Accounts, the authoritative allowed API fields are: `id`, `Account_Name`, `Account_Type`, `Industry`, `Phone`, `Website`, `Billing_City`, `Billing_State`, `Owner`, `Created_Time`, and `Modified_Time`.
- If a requested field is not in the selected module's allowed mapping, omit it or clearly explain that it is unavailable; never invent an API field name.
- For **"Show me closed won deals above 50000"**, include both requested filters: `Stage equals Closed Won` and `Amount greater_than 50000`.
- Do not apply filters that the user did not request.
- When the user requests records above an amount threshold without specifying another order, sort by `Amount` descending.

### Leads-Specific Rules

- For Leads, only use fields that exist in the module metadata. Never substitute a Deals field such as `Amount`, `Stage`, or `Closing_Date` when the user asked about Leads.
- For count questions, use the module's count operation with `id` and the relevant date filter from the user's wording.
- For "highest day", "top day", "busiest day", or similar date-ranking questions, fetch the relevant records and compute the date grouping in backend memory after retrieval.
- If the needed date dimension cannot be represented with available CRM fields or supported filters, explain the limitation instead of inventing a function or a surrogate field.
- COQL does not support `YEAR()`, `MONTH()`, or `DAY()` functions. Never invent or emit these in a generated query.

### Dynamic Calculation Rules

- Never hard-code a specific month, module, field, stage, metric, or calculation pattern when answering CRM questions.
- Resolve every numerator and denominator from the user's intent, the selected module, and verified metadata before presenting a rate, trend, or ranking.
- If a requested calculation depends on an unsupported relationship or a field that is not present in the selected module, return the available verified metrics and state the missing dependency clearly.

### Dynamic Retrieval Engine Rules

- Never guess the schema. Before generating any query, determine the target module, available fields, field API names, field data types, relationships, supported operators, supported aggregation functions, and supported grouping/sorting capabilities from live CRM metadata.
- Enforce strict module/field isolation. Every field used in a query must belong to the module where it is used, and no field may be copied from one module into another module's query.
- Treat cross-module questions as separate retrieval plans. Identify the required modules, determine the verified relationship, retrieve the necessary records or IDs, and only then join or correlate the results in backend processing.
- Derive the metric from the user's intent at runtime. Distinguish count, sum, average, percentage, conversion, growth, trend, comparison, ranking, distribution, funnel, cohort, lookup, and relationship analysis without assuming a predefined formula.
- For conversion and funnel questions, identify source, transition, and destination dynamically. Do not compute destination records divided by source records unless the populations are logically compatible and the relationship is verified.
- Handle dates dynamically from the user's wording and the available schema. Use the correct date field for created, modified, closed, converted, or scheduled intent, and calculate date boundaries at runtime using the CRM or account timezone.
- Validate every query before execution: module, fields, field ownership, data types, filters, operators, date fields, aggregations, grouping, sorting, relationships, and pagination. If validation fails, do not execute the query.
- Never learn from an error by repeating it. Parse the failure, remove the invalid field, function, or operator, rebuild the plan from schema, and ensure the repaired query is different from the failed query before retrying.
- Keep failed-query context for the current request so that repair attempts do not reproduce the same invalid component. If the request cannot be repaired safely, stop and report the limitation instead of hallucinating a result.
- Separate retrieval from calculation. Retrieve raw CRM data first, then perform joins, grouping, and calculations in the backend processing layer when the CRM query engine cannot safely express them.
- Use live CRM metadata/schema as the highest source of truth, followed by connector capabilities, CRM API/query capabilities, retrieved records, and then the user's request. Never let model assumptions override verified metadata.
- Before returning a result, verify that the query used the correct module, every field belonged to its module, all relationships were verified, the filters and date field were valid, the aggregation was supported, no populations were mixed, no unsupported function was used, and the result is reproducible from the retrieved data.
