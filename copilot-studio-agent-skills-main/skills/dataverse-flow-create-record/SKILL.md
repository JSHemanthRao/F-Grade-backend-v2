---
name: dataverse-flow-create-record
description: >-
  Build and debug Power Automate Dataverse CreateRecord/Add a new row actions from table metadata. Use this skill whenever a flow must create a Dataverse row, map custom columns, use entityName, fix "Invalid property" OData errors, handle Boolean/date/decimal fields, or translate display/schema names into connector parameters - even if the user does not name the skill. Enforces exact entity-set names and lowercase logical column names.
---

# Dataverse Create Record Actions in Power Automate

Generate correct `shared_commondataserviceforapps` `CreateRecord` parameters from Dataverse
metadata and diagnose runtime payload errors.

## Prerequisites

- Dataverse Web API or `dataverse` MCP access.
- Flow definition available as `workflow.clientdata`.
- A valid Dataverse connection reference.

## Golden Rules

1. `entityName` is the table's **EntitySetName**, not its logical name or display name.
2. Each `item/<column>` key uses the exact **LogicalName**, normally all lowercase.
3. Dataverse Web API property names are case-sensitive. `prefix_ReviewDate` and
   `prefix_reviewdate` are different.
4. Never derive connector keys from `SchemaName`; read metadata.
5. Verify the actual Dataverse row after the flow succeeds.

## Workflow

### 1. Read Table Metadata

Query:

```text
EntityDefinitions(LogicalName='<table>')?
$select=MetadataId,LogicalName,SchemaName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute
```

Then query custom attributes:

```text
EntityDefinitions(LogicalName='<table>')/Attributes?
$select=LogicalName,SchemaName,AttributeType,Format
```

Record the exact `EntitySetName` and every required `LogicalName`.

### 2. Build the Connector Action

```json
"Add_a_new_row": {
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": {
      "entityName": "prefix_tables",
      "item/prefix_textcolumn": "@triggerBody()?['TextInput']",
      "item/prefix_decimalcolumn": "@outputs('Previous')?['body/score']",
      "item/prefix_booleancolumn": "@triggerBody()?['BooleanInput']",
      "item/prefix_datecolumn": "@triggerBody()?['DateInput']"
    },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "operationId": "CreateRecord",
      "connectionName": "shared_commondataserviceforapps"
    }
  }
}
```

Use direct Boolean values for Yes/No columns. Use ISO `yyyy-MM-dd` for Date Only columns.

### 3. Validate Before Activation

Parse the authored JSON and list every key under
`actions.<scope>.actions.Add_a_new_row.inputs.parameters`.

Compare each `item/` suffix byte-for-byte with metadata. Do not use broad string replacements;
overlapping names can produce partially lowercased keys such as `reviewDate`.

### 4. Test and Diagnose

After an agent invokes the flow:

1. List flow runs.
2. Open the failed `Add_a_new_row` action.
3. Read the complete inner OData error.
4. Correct only the named property/type issue.
5. Reactivate and rerun.

### 5. Verify the Row

Query the table's EntitySetName, order by `createdon desc`, and check:

- Input fields
- Calculated/model output fields
- Date and Boolean values
- Reviewer/customer identifiers
- Creation timestamp matching the test

## Error Handling

| Error | Cause | Recovery |
| --- | --- | --- |
| `Invalid property 'X'` | Schema/display name or wrong casing | Replace with exact attribute `LogicalName` |
| Resource not found for segment | Wrong `entityName` | Use `EntitySetName` |
| Date conversion failure | Non-ISO input or DateTime/DateOnly mismatch | Normalize to ISO and inspect DateTimeBehavior |
| Boolean conversion failure | Passed `"Yes"`/`"No"` text | Pass JSON Boolean `true`/`false` |
| Flow succeeds but row values are null | Wrong expression path | Inspect prior action output and use the exact JSON path |
| Multiple rows for one review | CreateRecord is inside a sentence loop | Decide intentionally whether row grain is document or sentence |

## Output Format

Provide a mapping table:

| Dataverse display name | Logical name | Type | Flow expression |
| --- | --- | --- | --- |

Then report flow run ID/status and the verified created row.

## Post-Run Reflection

Capture any connector serialization or metadata edge case that required repeated debugging, then
add the smallest preventive rule to this skill.
