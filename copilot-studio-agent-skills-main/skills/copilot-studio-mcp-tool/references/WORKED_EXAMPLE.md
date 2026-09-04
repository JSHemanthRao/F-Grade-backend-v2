# Worked example — Microsoft Learn MCP server on a Copilot Studio agent

Representative values from a verified end-to-end run (pac CLI 2.9.3). Environment-specific
identifiers below are illustrative examples — substitute your own.

| Thing | Value |
| --- | --- |
| Environment | `11111111-1111-1111-1111-111111111111` ("Contoso Dev") |
| Dataverse org | `https://contoso-dev.crm.dynamics.com/` |
| MCP endpoint | `https://learn.microsoft.com/api/mcp` (anonymous, streamable, 3 tools) |
| Connector GUID | `dddddddd-dddd-dddd-dddd-dddddddddddd` |
| Connector name | `new_microsoft-2Dlearn-2Dmcp` |
| connectorinternalid | `shared_new-5fmicrosoft-2dlearn-2dmcp-5f0123456789abcdef` |
| Connection GUID | `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| Agent ID | `cccccccc-cccc-cccc-cccc-cccccccccccc` |
| Agent schema | `cr123_LearnDocsAgent` |
| connectionReference | `cr123_LearnDocsAgent.shared_new-5fmicrosoft-2dlearn-2dmcp-5f0123456789abcdef.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |

## Full script

```powershell
$envId  = "11111111-1111-1111-1111-111111111111"
$org    = "https://contoso-dev.crm.dynamics.com"
$prefix = "cr123"

# --- 0. preflight -----------------------------------------------------------
pac auth who
pac connector list
pac copilot list

# --- 1. connector -----------------------------------------------------------
mkdir connector; cd connector
# write apiDefinition.json + apiProperties.json (see SKILL.md)
pac connector create -df apiDefinition.json -pf apiProperties.json
# -> Connector created with ID <connectorGuid>

$dvTok = az account get-access-token --resource "$org/" --query accessToken -o tsv
$dvH   = @{ Authorization = "Bearer $dvTok"; Accept = "application/json" }
$c = Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/connectors(<connectorGuid>)?`$select=connectorinternalid"
$api = $c.connectorinternalid.ToLower()      # shared_new-5f...

# --- 2. connection ----------------------------------------------------------
$paTok = az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
$connG = [guid]::NewGuid().ToString("N")
$body  = @{ properties = @{ displayName = "microsoft-learn-mcp"
            environment = @{ id = "/providers/Microsoft.PowerApps/environments/$envId"; name = $envId } } } | ConvertTo-Json -Depth 6
$r = Invoke-RestMethod -Method Put -ContentType "application/json" -Body $body `
      -Headers @{ Authorization = "Bearer $paTok" } -Uri `
      "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/$api/connections/$connG`?api-version=2016-11-01&`$filter=environment eq '$envId'"
$r.properties.statuses      # must be Connected

# --- 3. agent ---------------------------------------------------------------
mkdir ..\workspace; cd ..\workspace
$ins = "You are Learn Docs Agent. ... (single line)"
pac copilot init --name "Learn Docs Agent" --publisher-prefix $prefix --instructions $ins --environment $envId
$schema = "cr123_LearnDocsAgent"

# --- 4. connectionreference row (REQUIRED) ----------------------------------
$ln = "$schema.$api.$connG"
$crBody = @{ connectionreferencelogicalname = $ln
             connectionreferencedisplayname = $ln
             connectorid  = "/providers/Microsoft.PowerApps/apis/$api"
             connectionid = $connG } | ConvertTo-Json
Invoke-RestMethod -Method Post -ContentType "application/json" -Body $crBody `
  -Headers ($dvH + @{ Prefer = "return=representation" }) -Uri "$org/api/data/v9.2/connectionreferences"

# --- 5. tool YAML + push ----------------------------------------------------
mkdir agents
# agents/topic.microsoft-learn-mcp.mcs.yml  and  connectionreferences.mcs.yml  (see SKILL.md)
pac copilot push
pac copilot publish --bot <agentId>

# --- 6. verify --------------------------------------------------------------
Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/botcomponents?`$select=schemaname,data&`$filter=_parentbotid_value eq <agentId>"
```

## What went wrong the first time

1. **`pac copilot push` failed** with `DataverseBadRequestException`. The console gave no
   detail. `pac-log.txt` revealed
   `A record with the specified key values does not exist in connectionreference entity`.
   Fix: create the `connectionreference` row (step 4) *before* pushing.

2. **`--project-dir` was ignored** by `pac copilot init` — it complained the *current*
   directory was not empty. Fix: `cd` into an empty folder and omit the flag.

3. **Multi-line `--instructions`** (PowerShell here-string) broke argument parsing.
   Fix: single-line string.

4. **`settings.mcs.yml` edits are not pushable.** Adding a `channels:` block or changing
   `authenticationMode` produced "No local changes detected", and `pac copilot pull`
   reverted the file. Fix: patch the `bot` row via the Dataverse Web API. Specifically,
   the Teams / M365 Copilot channel is enabled by patching `bot.configuration` with
   `"channels":[{"channelId":"MsTeams"},{"channelId":"Microsoft365Copilot"}]` and then
   running `pac copilot publish` — the publish provisions
   `applicationmanifestinformation.teams.botChannelRegistrationAppId`, exactly matching an
   agent that had the channel added through the UI. No browser automation required.

4b. **CLI-created agents have no icon.** `pac copilot init` leaves `bot.iconbase64` empty, so
   the agent shows a generic placeholder in the Copilot Studio list next to UI-created agents.
   Patch `iconbase64` (copy from another agent) and republish.

5. **Connection creation 404'd** on
   `/providers/Microsoft.PowerApps/environments/{env}/apis/{api}/connections/{name}`.
   Fix: use `/providers/Microsoft.PowerApps/apis/{api}/connections/{name}?api-version=2016-11-01&$filter=environment eq '{env}'`.

6. **Anonymous Direct Line could not test the agent** (`IntegratedAuthenticationNotSupportedInChannel`),
   and after temporarily setting `authenticationmode: None` it returned
   `AuthenticationNotConfigured` because `authenticationtrigger` was still `Always` and
   `accesscontrolpolicy` was `GroupMembership`. Lesson: don't weaken a private agent's auth
   to test it — use the authenticated conversation API with a purpose-built app registration.

7. **Azure CLI cannot obtain `CopilotStudio.Copilots.Invoke`** —
   `AADSTS65002: Consent between first party application ... must be configured via
   preauthorization`. Creating an `oauth2PermissionGrant` for the Azure CLI SP does not help.
   Fix: register your own public client app and use device-code flow.

8. **`pac copilot status --bot-id` is broken in 2.9.3**
   (`'bot' entity doesn't contain attribute with Name = 'componentstate_Property'`).
   Use `pac copilot list` or query Dataverse.
