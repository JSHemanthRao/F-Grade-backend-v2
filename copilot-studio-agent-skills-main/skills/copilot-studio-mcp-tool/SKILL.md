---
name: copilot-studio-mcp-tool
description: >-
  Attach a remote MCP (Model Context Protocol) server to a Microsoft Copilot Studio agent entirely
  from the command line - no Copilot Studio web UI, no browser automation. Covers authoring the
  OpenAPI/swagger definition with x-ms-agentic-protocol mcp-streamable-1.0, creating the Power
  Platform custom connector with `pac connector create`, creating a no-auth connection via the
  Power Apps REST API, creating the required Dataverse connectionreference row, and writing the
  TaskDialog / InvokeExternalAgentTaskAction / ModelContextProtocolMetadata action YAML into the
  agent workspace so `pac copilot push` succeeds. Also covers restricting which MCP tools the
  agent may call. Use when the user wants to add an MCP server or MCP tool to a Copilot Studio
  agent, wire up a custom MCP connector, or script MCP tool onboarding. Triggers: add mcp server
  to copilot studio, mcp tool copilot studio, mcp custom connector, x-ms-agentic-protocol, copilot
  studio mcp, streamable mcp connector.
---

# Adding an MCP server to a Copilot Studio agent from the CLI

Copilot Studio reaches MCP servers through **Power Platform custom connectors**. There are
four objects to create, in this order. Skipping any one produces a confusing failure.

```
1. custom connector      (pac connector create)              -> connectorinternalid
2. connection            (Power Apps REST API)               -> connectionGuid
3. connectionreference   (Dataverse Web API)                 <- REQUIRED, easy to miss
4. tool action YAML      (agents/topic.<name>.mcs.yml + push)
```

**The #1 failure:** pushing the action YAML without step 3 gives
`A record with the specified key values does not exist in connectionreference entity`
(surfaced as an unhelpful `DataverseBadRequestException`; the real message is only in
`%LOCALAPPDATA%\Microsoft\PowerAppsCLI\Microsoft.PowerApps.CLI.<ver>\tools\logs\pac-log.txt`).

Generative orchestration is **required** for MCP. `pac copilot init` enables it by default
(`configuration.settings.GenerativeActionsEnabled: true` + `recognizer.kind: GenerativeAIRecognizer`).

## Shortcut: clone a working example first

If the environment already has an agent with an MCP tool, clone it and copy the shapes
verbatim — far more reliable than guessing:

```powershell
pac connector list                                   # find an existing MCP connector
pac copilot clone --bot <thatAgentId> --output-dir <dir>
```

## Step 1 — Custom connector

`apiDefinition.json` (Swagger 2.0). `host` + the path must together form the MCP endpoint,
e.g. `https://learn.microsoft.com/api/mcp`:

```json
{
  "swagger": "2.0",
  "info": { "title": "microsoft-learn-mcp", "description": "<what this server does>", "version": "1.0.0" },
  "host": "learn.microsoft.com",
  "basePath": "/",
  "schemes": ["https"],
  "paths": {
    "/api/mcp": {
      "post": {
        "responses": { "200": { "description": "Immediate Response" } },
        "x-ms-agentic-protocol": "mcp-streamable-1.0",
        "operationId": "InvokeServer",
        "summary": "microsoft-learn-mcp",
        "description": "<what this server does>"
      }
    }
  },
  "securityDefinitions": {},
  "security": []
}
```

`apiProperties.json` for a **no-auth** server (verified working):

```json
{ "properties": { "connectionParameters": {}, "iconBrandColor": "", "capabilities": [],
  "scriptOperations": [], "publisher": "", "stackOwner": "", "policyTemplateInstances": [] } }
```

For authenticated servers generate a starting point with
`pac connector init --connection-template ApiKey|OAuthGeneric|OAuthAAD|BasicAuth`.

Only **Streamable HTTP** is supported. SSE was dropped after August 2025.

```powershell
pac connector create -df apiDefinition.json -pf apiProperties.json
pac connector list      # note the Connector ID (GUID)
```

Then read back the generated internal id — you cannot predict its hash suffix:

```powershell
$tok = az account get-access-token --resource "https://<org>.crm.dynamics.com/" --query accessToken -o tsv
$h = @{ Authorization = "Bearer $tok"; Accept = "application/json" }
Invoke-RestMethod -Headers $h -Uri `
  "https://<org>.crm.dynamics.com/api/data/v9.2/connectors(<connectorGuid>)?`$select=name,connectorinternalid"
# -> shared_new-5fmicrosoft-2dlearn-2dmcp-5f0123456789abcdef
```

Use the **lowercase** form of `connectorinternalid` everywhere downstream.

## Step 2 — Connection

No `pac` command creates a user connection (`pac connection create` is service-principal only).
Use the Power Apps REST API with token audience `https://service.powerapps.com/`.
The environment must be supplied as a **`$filter` query parameter** — the
`/environments/{env}/apis/...` route returns 404.

```powershell
$tok = az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
$api  = "shared_<connectorApiId>"          # full connectorinternalid, lowercase
$name = [guid]::NewGuid().ToString("N")    # 32 hex chars, no dashes
$body = @{ properties = @{ displayName = "<connector display name>"
           environment = @{ id = "/providers/Microsoft.PowerApps/environments/$envId"; name = $envId } } } | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Put -Headers @{Authorization="Bearer $tok"} -ContentType "application/json" -Body $body -Uri `
 "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/$api/connections/$name`?api-version=2016-11-01&`$filter=environment eq '$envId'"
```

Expect `properties.statuses[0].status = "Connected"`. `$name` is your **connectionGuid**.

List connections in an environment:
`GET https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/{envId}/connections?api-version=2016-11-01`

## Step 3 — connectionreference row (do not skip)

Naming contract — this exact string is used in **three** places and must match byte-for-byte:

```
{agentSchemaName}.shared_{connectorApiId}.{connectionGuid}
```

e.g. `cr123_LearnDocsAgent.shared_new-5fmicrosoft-2dlearn-2dmcp-5f0123456789abcdef.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`

```powershell
$ln = "<the string above>"
$body = @{
  connectionreferencelogicalname = $ln
  connectionreferencedisplayname = $ln
  connectorid  = "/providers/Microsoft.PowerApps/apis/shared_<connectorApiId>"
  connectionid = "<connectionGuid>"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -ContentType "application/json" -Body $body `
  -Headers ($h + @{ Prefer = "return=representation" }) `
  -Uri "https://<org>.crm.dynamics.com/api/data/v9.2/connectionreferences"
```

The logical name must start with a valid publisher prefix (the agent schema name already does).

## Step 4 — Tool action YAML

`agents/topic.<connector-display-name>.mcs.yml` (create the `agents/` folder if absent):

```yaml
mcs.metadata:
  componentName: microsoft-learn-mcp
  description: <what this server does>
kind: TaskDialog
modelDisplayName: microsoft-learn-mcp
modelDescription: <rich description — the orchestrator uses THIS to decide when to call the server>
action:
  kind: InvokeExternalAgentTaskAction
  connectionReference: cr123_LearnDocsAgent.shared_new-5f....eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
  connectionProperties:
    mode: Invoker

  operationDetails:
    kind: ModelContextProtocolMetadata
    operationId: InvokeServer
```

`connectionreferences.mcs.yml` in the workspace root:

```yaml
connectionReferences:
  - connectionReferenceLogicalName: cr123_LearnDocsAgent.shared_new-5f....eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
    connectorId: /providers/Microsoft.PowerApps/apis/shared_new-5f...
```

Rules:
- `kind: TaskDialog` — **not** `ConnectorTool`, `MCPTool`, or `AgentAction`.
- `action.kind: InvokeExternalAgentTaskAction` is MCP-specific (plain connector actions use
  `InvokeConnectorTaskAction`).
- `operationId` must equal the `operationId` in the swagger.
- Omit `inputs`/`outputs` — MCP tools are discovered at runtime via `tools/list`.
- Omitting `tools:`/`knownTools:` means **use all tools**.
- **`connectionProperties.mode` matters enormously — see below.**

### `mode: Maker` vs `mode: Invoker` (critical)

| mode | Copilot Studio label | Behaviour |
| --- | --- | --- |
| `Maker` | Maker-provided credentials | Uses the connection the maker created. Works headlessly. |
| `Invoker` | End user credentials | **Each invoking user must authorize their own connection first.** |

A connection created from the CLI is not registered as any user's authorized connection, so
`Invoker` makes the agent return a `connectors/connectionManagerCard` — *"Let's get you
connected first"* — and this **blocks every turn**, including questions unrelated to the tool.
It looks like a broken MCP server but the tool is never reached.

**Use `mode: Maker` for CLI-built and single-user/private agents.** Only use `Invoker` when each
end user genuinely must authenticate to the backend with their own identity, and expect them to
complete a consent step in the Copilot Studio UI.

Restrict which tools the agent may call:

```yaml
  operationDetails:
    kind: ModelContextProtocolMetadata
    operationId: InvokeServer
    tools:
      kind: UseSpecificTools
      tools:
        - microsoft_docs_search
    knownTools:
      - kind: McpToolDefinition
        name: microsoft_docs_search
```

Then:

```powershell
pac copilot push
pac copilot publish --bot <agentId>
```

## Verify

```powershell
# tool component landed
Invoke-RestMethod -Headers $h -Uri "https://<org>.crm.dynamics.com/api/data/v9.2/botcomponents?`$select=schemaname,data&`$filter=_parentbotid_value eq <agentId>"
```

Look for `<agentSchema>.topic.<toolName>` and confirm its `data` matches your YAML.

Sanity-check the MCP endpoint itself before blaming Copilot Studio:

```powershell
Invoke-WebRequest -Uri "https://learn.microsoft.com/api/mcp" -Method Post -UseBasicParsing `
  -ContentType "application/json" -Headers @{Accept="application/json, text/event-stream"} `
  -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

For conversational testing of the finished agent, see the **`copilot-studio-agent`** skill.
To wire one agent to another as a connected agent, see **`copilot-studio-connected-agent`**.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `A record with the specified key values does not exist in connectionreference entity` | Step 3 missing, or the logical-name string doesn't match the action YAML exactly |
| `DataverseBadRequestException` with no detail | Read `pac-log.txt`; search for the last `DataverseBadRequestException` |
| 404 creating the connection | Used the `/environments/{env}/apis/...` route — use `/apis/{api}/connections/{name}?...&$filter=environment eq '{env}'` |
| Agent never calls the tool | Generative orchestration off, or `modelDescription` too vague |
| Agent returns a `connectionManagerCard` on **every** turn | `connectionProperties.mode: Invoker` — switch to `Maker`, push, publish |
| Tool calls fail at runtime | Connection status not `Connected`, or `operationId` mismatch with the swagger |

## Verifying it actually fires

Structural checks prove the tool is wired, not that it works. To confirm the MCP server is
really being called at runtime, use the **`copilot-studio-agent-test`** skill — it generates a
Node test script that holds a real conversation and detects the citation URLs Copilot Studio
returns in the activity entities.

## References

- `references/WORKED_EXAMPLE.md` — full end-to-end Microsoft Learn MCP walkthrough with real values.
