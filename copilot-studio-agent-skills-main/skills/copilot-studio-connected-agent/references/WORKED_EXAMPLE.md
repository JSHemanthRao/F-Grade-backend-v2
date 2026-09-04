# Worked example — a two-agent connected setup built entirely from the CLI

Representative values from a verified build in the environment `11111111-1111-1111-1111-111111111111`
("Contoso Dev", org `https://contoso-dev.crm.dynamics.com`), pac CLI 2.9.3. Environment-specific
identifiers are illustrative examples — substitute your own.

Goal: an orchestrator agent (`orchestrator-agent`) that delegates Microsoft-documentation
questions to an independent agent (`learn-docs-agent`), which in turn calls two MCP servers.
The parent additionally carries a connector tool, two cloud flows, and an AI Builder prompt.

```
orchestrator-agent  (cr123_orchestratoragent)
├── action.LearnDocsAgent          InvokeConnectedAgentTaskAction -> cr123_learndocsagent
├── action.MSNWeather-Getcurrentweather InvokeConnectorTaskAction      -> shared_msnweather
├── action.ResumeScreenMailSendFlow     InvokeFlowTaskAction           -> cloud flow
├── action.Sentinmentanalysis           InvokeFlowTaskAction           -> agent flow
└── action.ResumeScreeningPromptAction  InvokeAIBuilderModelTaskAction -> AI Builder prompt

learn-docs-agent  (cr123_learndocsagent)
├── topic.microsoft-learn-mcp           InvokeExternalAgentTaskAction  -> MCP
└── topic.rel-comms-mcp                 InvokeExternalAgentTaskAction  -> MCP
```

## 0. Prerequisites

```powershell
pac auth who            # confirm the target environment
az account show         # same tenant, for Dataverse Web API tokens
```

```powershell
$org = "https://contoso-dev.crm.dynamics.com"
$env = "11111111-1111-1111-1111-111111111111"
$tok = az account get-access-token --resource "$org/" --query accessToken -o tsv
$h   = @{ Authorization = "Bearer $tok"; Accept = "application/json" }
```

## 1. Child agent first

```powershell
New-Item -ItemType Directory -Force -Path .\learn-docs-agent | Out-Null
Set-Location .\learn-docs-agent
$ins = "You are Learn Docs Agent. ... single line only ..."
pac copilot init --name "learn-docs-agent" --publisher-prefix cr123 --instructions $ins --environment $env
```

Output records what everything downstream binds to:

```
Agent ID:    aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
Schema name: cr123_learndocsagent
```

Attach its MCP tools (see `copilot-studio-mcp-tool`), then **publish** — the parent cannot bind
to an unpublished child:

```powershell
pac copilot push
pac copilot publish --bot aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
```

Confirm connectability:

```powershell
$b = Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/bots(aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)?`$select=configuration"
($b.configuration | ConvertFrom-Json).isAgentConnectable      # True
```

## 2. Parent agent

```powershell
New-Item -ItemType Directory -Force -Path ..\orchestrator-agent | Out-Null
Set-Location ..\orchestrator-agent
pac copilot init --name "orchestrator-agent" --publisher-prefix cr123 --instructions "<single line>" --environment $env
# Agent ID:    bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
# Schema name: cr123_orchestratoragent
```

## 3. The connected-agent tool

`agents/action.LearnDocsAgent.mcs.yml` — note the **absence** of a `response:` block:

```yaml
mcs.metadata:
  componentName: LearnDocsAgent
  description: Connected agent - learn-docs-agent
kind: TaskDialog
modelDisplayName: learn-docs-agent
modelDescription: A documentation-first Microsoft expert that retrieves and analyzes official
  Microsoft Learn content before answering questions about Azure, Microsoft 365, Power Platform
  and Copilot, cites the Learn articles used, and flags preview/GA/deprecated status.
action:
  kind: InvokeConnectedAgentTaskAction
  botSchemaName: cr123_learndocsagent
  historyType:
    kind: ConversationHistory
```

```powershell
pac copilot push
pac copilot publish --bot bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
```

## 4. Wire it into the parent's instructions

Read the real component schema name back first:

```powershell
(Invoke-RestMethod -Headers $h -Uri `
  "$org/api/data/v9.2/botcomponents?`$select=schemaname&`$filter=_parentbotid_value eq bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").value.schemaname
# cr123_orchestratoragent.InvokeConnectedAgentTaskAction.action.LearnDocsAgent
```

`agent.mcs.yml`:

```yaml
instructions: |-
  You are a helpful AI assistant that acts as the orchestrator agent, or parent agent, in a
  multi-agent workflow.

  Make use of the {System.Bot.Components.Agents.'cr123_orchestratoragent.InvokeConnectedAgentTaskAction.action.LearnDocsAgent'.DisplayName}
  whenever a user query deals with the MS Learn platform or Microsoft product documentation.
gptCapabilities:
  webBrowsing: true
aISettings:
  model:
    modelNameHint: Sonnet46
```

Push and publish again.

## 5. What went wrong along the way

**Emit-mode failure on the original UI-built agent.** Its connected-agent component was:

```yaml
response:
  activity:
  mode: Generated
```

with no `outputs:`, producing `AgentpluginActionNoOutputSetInEmitMode` on every turn while the
user still saw a correct answer. The CLI rebuild simply omits `response:`.

**Namespace bleed.** The first attempt named the file
`InvokeConnectedAgentTaskAction.LearnDocsAgent.mcs.yml`. pac treated the leading segment as
a namespace and renamed *every* tool in the bot to
`cr123_orchestratoragent.InvokeConnectedAgentTaskAction.action.<name>`, then blew the 100-char
`schemaname` limit. Recovery: delete the bad rows and re-push.

```powershell
$bad = (Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/botcomponents?`$select=schemaname,botcomponentid&`$filter=_parentbotid_value eq <parentAgentId> and contains(schemaname,'InvokeConnectedAgentTaskAction')").value
$bad | ForEach-Object { Invoke-RestMethod -Method Delete -Headers $h -Uri "$org/api/data/v9.2/botcomponents($($_.botcomponentid))" }
```

**`pull` eats connection references.** `pac copilot pull` rewrote
`connectionreferences.mcs.yml` from the server's view, dropping the MSN Weather entry; the next
push then deleted the matching Dataverse row, and the push after that failed with
`A record with the specified key values does not exist in connectionreference entity`. Re-add the
entry to the YAML **and** re-create the Dataverse row before pushing.

**One connection per connector.** `shared_msnweather` allows a single connection per user
(`ApiConnectionLimitExceeded`). Reuse the existing connection GUID in a new
`connectionreference` whose logical name is prefixed with the *new* agent's schema name:

```
cr123_orchestratoragent.shared_msnweather.ffffffffffffffffffffffffffffffff
```

**`mode: Invoker` stalls a CLI-built agent.** Copying the original's
`connectionProperties.mode: Invoker` onto the connector and flow tools reproduced the documented
failure exactly: the first weather question returned a `connectors/connectionManagerCard`
("Let's get you connected first") and no answer, even though the Learn delegation on the same
agent worked. Switching all three tools to `mode: Maker`, pushing and republishing returned real
weather data on the next turn. Use `Maker` for anything built headlessly.

**AI Builder prompt tools return a consent card.** `InvokeAIBuilderModelTaskAction` produces an
"Agent needs your permission to use your data and proceed with generating a response" card
before running. That is correct behaviour, not a wiring fault — the verbose transcript still
shows the tool selected and its input bound. A non-interactive test harness should report this
as *paused*, not *failed*.

## 6. Cloning the non-agent dependencies (for full parity)

**Cloud flows** — copy `clientdata` and re-create, then activate:

```powershell
$w  = Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/workflows(<srcFlowId>)?`$select=clientdata"
$cd = $w.clientdata.Replace("<oldPromptId>", "<newPromptId>")     # if the flow calls a prompt
$body = @{ name="<name> (copy)"; category=5; type=1; primaryentity="none"; clientdata=$cd; statecode=0; statuscode=1 } | ConvertTo-Json
$new = Invoke-RestMethod -Method Post -ContentType "application/json" -Body $body -Headers ($h + @{Prefer="return=representation"}) -Uri "$org/api/data/v9.2/workflows"
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers ($h + @{"If-Match"="*"}) `
  -Uri "$org/api/data/v9.2/workflows($($new.workflowid))" -Body '{"statecode":1,"statuscode":2}'
```

**AI Builder prompts** — direct `statecode` writes are blocked by an AI Builder plugin
(`Unexpected parameter(s) statecode, statuscode`). Use the unbound **`AIModelPublish`** action,
passing a **fresh GUID** for `RunConfigurationId`; it creates the training + serving
configurations and activates the model in one call:

```powershell
$m = Invoke-RestMethod -Method Post -ContentType "application/json" -Headers ($h + @{Prefer="return=representation"}) `
  -Uri "$org/api/data/v9.2/msdyn_aimodels" `
  -Body (@{ msdyn_name="<new prompt name>"; "msdyn_TemplateId@odata.bind"="/msdyn_aitemplates(<templateId>)" } | ConvertTo-Json)

$src = Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/msdyn_aiconfigurations(<srcServingCfgId>)?`$select=msdyn_customconfiguration,msdyn_modelrundataspecification"

Invoke-RestMethod -Method Post -ContentType "application/json" -Headers $h -Uri "$org/api/data/v9.2/AIModelPublish" -Body (@{
  ModelId             = $m.msdyn_aimodelid
  RunConfigurationId  = [guid]::NewGuid().ToString()
  ModelName           = "<new prompt name>"
  RunConfiguration    = $src.msdyn_modelrundataspecification
  TemplateId          = "<templateId>"
  CustomConfiguration = $src.msdyn_customconfiguration
  Source              = "CopilotStudio"
} | ConvertTo-Json -Depth 5)
```

Verify: the model reaches `statecode 1 / statuscode 1` with
`_msdyn_activerunconfigurationid_value` set to the GUID you supplied.

## 7. Runtime proof

See `copilot-studio-agent-test`. Assert three things: the parent answers, `learn.microsoft.com`
citations from the child's MCP tool come back through the parent, and
`AgentpluginActionNoOutputSetInEmitMode` never appears in any returned activity.
