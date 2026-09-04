---
name: copilot-studio-agent-flow
description: >-
  Create, attach, troubleshoot, and verify Copilot Studio agent flows from the CLI and APIs. Use this skill whenever the user asks for an agent flow, "When an agent calls the flow", Power Automate tool, InvokeFlowTaskAction, AI Builder action, flow input/output, or a flow that writes to Dataverse - even if they do not name the skill. Covers solution-aware workflow clientdata, embedded connector bindings, Maker-mode tools, publishing, and proof that the flow actually ran.
---

# Copilot Studio Agent Flows from the CLI

Build solution-aware Power Automate agent flows and attach them to Copilot Studio agents without
depending on the portal designer.

## Prerequisites

- Power Platform CLI (`pac`) authenticated to the target environment.
- Azure CLI authenticated to the same tenant.
- Dataverse org URL and environment GUID.
- `dataverse` MCP for targeted metadata/table work.
- Existing `copilot-studio-agent` skill for agent creation and publishing.
- Playwright MCP as a fallback when an undocumented designer-generated shape must be captured.

## Golden Rules

1. **Clone before inventing.** Query a working `workflow.clientdata` and flow-tool
   `botcomponent.data` from the same environment when possible.
2. An agent flow must be a **solution flow** with a `Request` trigger using `kind: Skills` and a
   `Response` action using `kind: Skills`.
3. Bind connector references with `runtimeSource: embedded`. `invoker` can send an empty bearer
   token when the agent calls Dataverse-backed AI Builder actions.
4. In the agent tool YAML, use `connectionProperties.mode: Maker` for headless/private agents.
5. Write `modelDescription` as a **single-line scalar**. A folded `>-` description can deploy but
   render as empty in Copilot Studio, causing the orchestrator to skip the tool.
6. Never trust the chat answer as proof. Verify a flow run and its expected side effect.

## Workflow

### 1. Preflight

```powershell
pac auth who
az account show --query "{tenant:tenantId,user:user.name}" -o json
```

Confirm both commands point to the target tenant and environment.

### 2. Inspect Working Shapes

Query:

- `workflow`: `workflowid`, `name`, `clientdata`, `category`, `statecode`
- `botcomponent`: `schemaname`, `data`, filtered to an existing flow action

Use the returned JSON/YAML shape exactly. Do not guess connector operation IDs.

### 3. Create Connector References

For every connector used by the flow:

1. Confirm a live user connection exists.
2. Create a solution-aware `connectionreference` row.
3. Add this shape to `clientdata.properties.connectionReferences`:

```json
"shared_connector": {
  "api": { "name": "shared_connector" },
  "connection": { "connectionReferenceLogicalName": "prefix_reference_name" },
  "runtimeSource": "embedded"
}
```

An action does not exist merely because an email address or another input exists. If the flow must
send email, create an explicit Office 365 Outlook action and connection reference.

#### Email notification pattern

Add `shared_office365` to `connectionReferences` with `runtimeSource: embedded`, then add:

```json
"Send_an_email_(V2)": {
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": {
      "emailMessage/To": "@triggerBody()?['Reviewer_Email']",
      "emailMessage/Subject": "Your review sentiment analysis",
      "emailMessage/Body": "<p>...</p>",
      "emailMessage/Importance": "Normal"
    },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365",
      "operationId": "SendEmailV2",
      "connectionName": "shared_office365"
    }
  },
  "runAfter": { "Previous_action": ["Succeeded"] }
}
```

Run `Respond_to_the_agent` only after the email action succeeds if the agent is going to claim the
email was sent.

### 4. Author the Agent Flow

Required trigger shape:

```json
"manual": {
  "type": "Request",
  "kind": "Skills",
  "inputs": { "schema": { "type": "object", "properties": {}, "required": [] } }
}
```

Required response shape:

```json
"Respond_to_the_agent": {
  "type": "Response",
  "kind": "Skills",
  "inputs": {
    "schema": { "type": "object", "properties": {} },
    "statusCode": 200,
    "body": {}
  }
}
```

Use `runAfter` to ensure the response only runs after all required side effects succeed.

### 5. Create and Activate the Workflow

Create a `workflow` row with:

- `category: 5` (Modern Flow)
- `type: 1`
- `primaryentity: "none"`
- `clientdata`: the serialized definition
- `MSCRM.SolutionUniqueName`: target unmanaged solution

Create it in Draft, patch the definition while Draft, then activate with:

```json
{"statecode":1,"statuscode":2}
```

### 6. Attach It to the Agent

Create `agents/topic.<flow-name>.mcs.yml`:

```yaml
kind: TaskDialog
modelDescription: Call this tool to perform the specific flow operation and persist the result.
action:
  kind: InvokeFlowTaskAction
  flowId: <workflow-guid>
  connectionProperties:
    $kind: ConnectionProperties
    diagnostics:
    mode: Maker

outputMode: All
```

Then:

```powershell
pac copilot push
pac copilot publish --bot <agent-guid>
```

### 7. Verify

1. Start a fresh agent test session.
2. Use a prompt that explicitly supplies every required input.
3. Query flow runs and require `status: Succeeded`.
4. Verify the expected side effect: Dataverse row, email action success, file creation, or other
   durable output.
5. Inspect each failed action before changing the definition.

## Error Handling

| Symptom | Cause | Recovery |
| --- | --- | --- |
| Agent claims success but no flow run exists | Tool was not selected | Check single-line `modelDescription`, tool enabled state, and instructions |
| Connection-manager card | Tool uses `mode: Invoker` | Change to `Maker`, push, and publish |
| AI Builder returns Dataverse 401 | Connection reference uses `runtimeSource: invoker` | Change to `embedded`, publish the flow |
| Tool page shows no description | Folded/multiline YAML was not parsed | Use a single-line `modelDescription` |
| Flow runs but a connector action is absent | The action was never authored | Add the explicit action plus its connection reference |
| Reviewer email is stored but no email arrives | Email input was treated only as data | Add `SendEmailV2`; verify its run status and the mailbox |
| Standalone flow test does nothing | `Skills` trigger requires an agent caller | Test through the agent |

## Output Format

Report:

- Environment, solution, flow ID, agent ID/schema
- Connector references and binding mode
- Published status
- Test prompt
- Flow run status
- Durable side-effect evidence
- Any portal fallback used and the reusable shape captured from it

## Post-Run Reflection

After a multi-step run, identify any undocumented schema, connector, or verification friction.
Update this skill when a repeatable rule would prevent the failure in future runs.
