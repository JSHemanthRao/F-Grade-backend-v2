---
description: Defines how CRM Activity tool responses must be formatted as formal management reports.
trigger: always_on
---

# CRM Activity Report Response Format

When the CRM Activity tool returns activity data, present the result as a formal management report using the rules below.

## 1. Report Header

- Default header (no specific employee requested):
  ```
  CRM Daily Activity Report
  <Date>
  ```
- When a specific employee is requested:
  ```
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

```
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
