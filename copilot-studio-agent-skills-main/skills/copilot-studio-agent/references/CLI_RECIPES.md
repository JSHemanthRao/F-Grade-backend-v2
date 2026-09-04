# CLI recipes for Copilot Studio agents

## Environment / token bootstrap

```powershell
pac auth who                                  # user, env id, org url, schema info
Get-Content .mcs\conn.json | ConvertFrom-Json # org url + env id + agent id from a workspace

$org   = "https://<org>.crm.dynamics.com"
$envId = "<env-guid>"

# Dataverse (tables: bot, botcomponent, connector, connectionreference, systemuser, team)
$dvTok = az account get-access-token --resource "$org/" --query accessToken -o tsv
$dvH   = @{ Authorization = "Bearer $dvTok"; Accept = "application/json" }

# Power Apps (connections, connectors)
$paTok = az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv

# Power Platform (Direct Line token, Copilot Studio APIs)
$ppTok = az account get-access-token --resource "https://api.powerplatform.com/" --query accessToken -o tsv
```

Environment host for `*.environment.api.powerplatform.com`:

```powershell
$e = $envId -replace '-',''
$envHost = $e.Substring(0,30) + "." + $e.Substring(30,2)
```

## Create an agent

```powershell
New-Item -ItemType Directory -Force -Path .\workspace | Out-Null
Set-Location .\workspace
$ins = "Single line instructions."
pac copilot init --name "My Agent" --publisher-prefix cr123 --instructions $ins --environment $envId
```

## Inspect an agent

```powershell
pac copilot list

Invoke-RestMethod -Headers $dvH -Uri `
  "$org/api/data/v9.2/bots(<agentId>)?`$select=name,schemaname,authenticationmode,authenticationtrigger,accesscontrolpolicy,statecode,publishedon,configuration"

# components (topics + tools)
Invoke-RestMethod -Headers $dvH -Uri `
  "$org/api/data/v9.2/botcomponents?`$select=schemaname,componenttype,data&`$filter=_parentbotid_value eq <agentId>"
```

## Change auth mode / trigger / channels

```powershell
$patchH = $dvH + @{ "If-Match" = "*" }
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers $patchH `
  -Uri "$org/api/data/v9.2/bots(<agentId>)" `
  -Body '{"authenticationmode":2,"authenticationtrigger":1}'
pac copilot publish --bot <agentId>
```

Enable the Teams + Microsoft 365 Copilot channel (equivalent to "Add channel" in the UI):

```powershell
$c = (Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/bots(<agentId>)?`$select=configuration").configuration | ConvertFrom-Json
$c | Add-Member -NotePropertyName channels -Force -NotePropertyValue @(
      [pscustomobject]@{ channelId = "MsTeams" },
      [pscustomobject]@{ channelId = "Microsoft365Copilot" })
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers $patchH `
  -Uri "$org/api/data/v9.2/bots(<agentId>)" `
  -Body (@{ configuration = ($c | ConvertTo-Json -Depth 8 -Compress) } | ConvertTo-Json)
pac copilot publish --bot <agentId>
```

Set the agent icon (CLI-created agents have none):

```powershell
$icon = (Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/bots(<sourceAgentId>)?`$select=iconbase64").iconbase64
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers $patchH `
  -Uri "$org/api/data/v9.2/bots(<agentId>)" -Body (@{ iconbase64 = $icon } | ConvertTo-Json)
pac copilot publish --bot <agentId>
```

Option set values:
- `authenticationmode`: 0 Unspecified, 1 None, 2 Integrated, 3 Custom Entra ID, 4 Generic OAuth2
- `authenticationtrigger`: 0 As Needed, 1 Always

Read any option set's labels:

```powershell
Invoke-RestMethod -Headers $dvH -Uri `
 "$org/api/data/v9.2/EntityDefinitions(LogicalName='bot')/Attributes(LogicalName='authenticationmode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$expand=OptionSet"
```

## Confirm an agent is private

```powershell
$b = Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/bots(<agentId>)?`$select=name,_ownerid_value"
Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/systemusers($($b._ownerid_value))?`$select=fullname,domainname"

$p = Invoke-RestMethod -Headers $dvH -Uri `
  "$org/api/data/v9.2/RetrieveSharedPrincipalsAndAccess(Target=@t)?@t={'@odata.id':'bots(<agentId>)'}"
$p.PrincipalAccesses

# the single expected team share:
Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/teams(<teamId>)?`$select=name,description"
Invoke-RestMethod -Headers $dvH -Uri "$org/api/data/v9.2/teams(<teamId>)/teammembership_association?`$select=fullname,domainname"
```

## Device-code token for the authenticated conversation API

One-time app registration:

```powershell
$app = az ad app create --display-name "cs-invoker" --is-fallback-public-client true `
        --public-client-redirect-uris "http://localhost" -o json | ConvertFrom-Json
az ad app permission add --id $app.appId --api 8578e004-a5c6-46e7-913e-12f58912df43 `
        --api-permissions "204440d3-c1d0-4826-b570-99eb6f5e2aeb=Scope"
az ad app permission admin-consent --id $app.appId
```

Then:

```powershell
$tenant = "<tenant-guid>"; $client = $app.appId
$scope  = "https://api.powerplatform.com/CopilotStudio.Copilots.Invoke offline_access openid profile"
$dc = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/devicecode" `
       -Body @{ client_id = $client; scope = $scope }
Write-Host "Open https://microsoft.com/devicelogin and enter $($dc.user_code)"

$token = $null
while (-not $token) {
  Start-Sleep -Seconds ([int]$dc.interval)
  try {
    $t = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" `
          -Body @{ grant_type = "urn:ietf:params:oauth:grant-type:device_code"; client_id = $client; device_code = $dc.device_code }
    $token = $t.access_token
  } catch { if ($_.ErrorDetails.Message -notmatch "authorization_pending") { throw } }
}
```

Converse:

```powershell
$h    = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$base = "https://$envHost.environment.api.powerplatform.com/copilotstudio/dataverse-backed/authenticated/bots/<schemaName>"
$conv = Invoke-RestMethod -Method Post -Headers $h -Body "{}" -Uri "$base/conversations?api-version=2022-03-01-preview"
$msg  = @{ type = "message"; text = "your question"; from = @{ id = "user" } } | ConvertTo-Json -Depth 5
$resp = Invoke-RestMethod -Method Post -Headers $h -Body $msg -Uri "$base/conversations/$($conv.conversationId)?api-version=2022-03-01-preview"
$resp.activities | Where-Object { $_.type -eq "message" -and $_.text } | ForEach-Object { $_.text }
```

## Anonymous Direct Line (only for authenticationmode = None)

```powershell
$r = Invoke-RestMethod -Headers @{ Authorization = "Bearer $ppTok" } -Uri `
  "https://$envHost.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview"
$h = @{ Authorization = "Bearer $($r.token)" }
$c = Invoke-RestMethod -Method Post -Headers $h -Uri "https://directline.botframework.com/v3/directline/conversations"
$m = @{ type = "message"; from = @{ id = "user" }; text = "hello" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $h -ContentType "application/json" -Body $m `
  -Uri "https://directline.botframework.com/v3/directline/conversations/$($c.conversationId)/activities"
Invoke-RestMethod -Headers $h -Uri "https://directline.botframework.com/v3/directline/conversations/$($c.conversationId)/activities"
```

## Diagnosing pac failures

```powershell
$log = "$env:LOCALAPPDATA\Microsoft\PowerAppsCLI\Microsoft.PowerApps.CLI.2.9.3\tools\logs\pac-log.txt"
$i = (Select-String -Path $log -Pattern "Exception" | Select-Object -Last 1).LineNumber
Get-Content $log | Select-Object -Skip ([Math]::Max(0,$i-25)) -First 40
```

The useful line is the `FTL | bolt.Session ::` entry containing the Dataverse JSON error.

## Known pac 2.9.3 issues

- `pac copilot status --bot-id` throws `componentstate_Property` — use `pac copilot list`.
- `pac copilot init --project-dir` is ignored — `cd` into an empty dir instead.
- `pac copilot push` ignores `settings.mcs.yml` entirely.
- `pac connection create` only supports service principals (app id + secret), not user connections.
- `pac copilot publish` sometimes appears to hang; it is idempotent, just re-run.
