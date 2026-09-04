---
name: copilot-studio-agent
description: >-
  Create, edit, publish, and manage Microsoft Copilot Studio agents entirely from the
  command line using the Power Platform CLI (`pac copilot`) plus the Dataverse Web API,
  with no Copilot Studio web UI and no browser automation. Covers scaffolding a live agent
  in one step, cloning an existing agent to a local YAML workspace, the pull/push sync loop,
  publishing, controlling authentication mode and access control, verifying that an agent is
  private to its owner, and testing an agent conversationally via Direct Line or the
  authenticated Copilot Studio conversation API. Use whenever the user asks to create a
  Copilot Studio agent, build an agent from the CLI, clone/edit/push/publish an agent,
  change agent auth or sharing, script agent creation, or test a Copilot Studio agent.
  Triggers: create copilot studio agent, pac copilot, copilot studio cli, agent as code,
  clone agent, push agent, publish agent, copilot studio yaml, agent definition, copilot
  studio automation, share agent, private agent.
---

# Copilot Studio agents from the CLI

Build and manage Copilot Studio agents as code with `pac copilot`. Everything here is
verified working against pac CLI **2.9.3**.

## Golden rules

1. **`pac copilot push` only syncs component files** — `agents/`, `topics/`, `knowledge/`.
   It does **NOT** sync `settings.mcs.yml`. Editing `settings.mcs.yml` and pushing prints
   *"No local changes detected"* and a later `pull` silently reverts your edit.
   Change agent-level settings (auth mode, access control) via the **Dataverse Web API**.
2. **Clone before you invent.** If the environment already has a working agent that does
   what you need, `pac copilot clone` it and copy the exact YAML shape. This beats guessing
   at undocumented schemas every time.
3. `--project-dir` on `pac copilot init` is unreliable — **`cd` into an empty target
   directory** and omit the flag.
4. Multi-line `--instructions` can break argument parsing. Pass a **single-line string**.

## Prerequisites

```powershell
pac auth who          # confirm user + target environment
az account show       # Azure CLI, same tenant — needed for Dataverse Web API tokens
```

Get a Dataverse token (org URL comes from `pac auth who` / `.mcs/conn.json`):

```powershell
$tok = az account get-access-token --resource "https://<org>.crm.dynamics.com/" --query accessToken -o tsv
$h = @{ Authorization = "Bearer $tok"; Accept = "application/json" }
```

## Create a live agent in one step

`pac copilot init --environment` scaffolds, packs, imports the solution, and connects the
workspace. Takes ~3-5 minutes.

```powershell
New-Item -ItemType Directory -Force -Path C:\path\to\workspace | Out-Null
Set-Location C:\path\to\workspace

$ins = "You are ... Single line only."
pac copilot init --name "My Agent" --publisher-prefix cr123 --instructions $ins `
                 --environment <envGuid>
```

Output gives the **Agent ID** and **Schema name** (`{prefix}_{SanitizedName}`). Record both.

Omit `--environment` to scaffold locally only. Use `--authoring-mode cli-copilot` for the
CliCopilot shape (`agent.mcs.yml` becomes `kind: GptComponentMetadata` instead of `kind: Bot`).

## Workspace layout

```
workspace/
├── agent.mcs.yml                 # instructions, model hints, capabilities
├── settings.mcs.yml              # display name, auth, orchestration  (NOT pushable)
├── connectionreferences.mcs.yml  # connection references for connectors/MCP tools
├── agents/                       # tools (MCP servers, connector actions) - topic.<name>.mcs.yml
├── topics/                       # conversation topics - kind: AdaptiveDialog
├── connectors/<connector>/       # custom connector payload (appears after clone)
└── .mcs/                         # sync metadata: conn.json, changetoken.txt (do not edit)
```

`.mcs/conn.json` holds the Dataverse org URL, environment id, and agent id — handy for scripting.

## The sync loop

```powershell
pac copilot clone --bot <schemaNameOrId> --output-dir <dir>   # dir must be empty
pac copilot pull      # merge remote -> local  (run before editing)
pac copilot push      # local -> remote        (component files only)
pac copilot publish --bot <agentId>
pac copilot list      # agents in the environment
```

`pac copilot status --bot-id` is **broken in 2.9.3** (`'bot' entity doesn't contain attribute
with Name = 'componentstate_Property'`). Use `pac copilot list` or query Dataverse instead.

`publish` can take several minutes and occasionally appears to hang — re-run it; it is idempotent.

## Agent-level settings must go through Dataverse

The `bot` table holds the real values. Option sets:

| Column | Values |
| --- | --- |
| `authenticationmode` | 0 Unspecified, 1 None, 2 Integrated, 3 Custom Entra ID, 4 Generic OAuth2 |
| `authenticationtrigger` | 0 As Needed, 1 Always |
| `accesscontrolpolicy` | 2 = GroupMembership (default for Integrated) |

```powershell
$h2 = $h + @{ "If-Match" = "*" }
Invoke-RestMethod -Uri "https://<org>.crm.dynamics.com/api/data/v9.2/bots(<agentId>)" `
  -Method Patch -Headers $h2 -ContentType "application/json" `
  -Body '{"authenticationmode":2,"authenticationtrigger":1}'
```

Republish after changing these.

### Teams / Microsoft 365 Copilot channel (no UI needed)

A `channels:` block in `settings.mcs.yml` is **not** accepted by `pac copilot push` and gets
reverted on the next `pull`. But the channel list lives in the `bot.configuration` JSON, which
you **can** patch directly — then publish, and Copilot Studio provisions the real Azure Bot
Service channel registration.

```powershell
$cur = (Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/bots(<agentId>)?`$select=configuration").configuration
$c = $cur | ConvertFrom-Json
$c | Add-Member -NotePropertyName channels -Force -NotePropertyValue @(
      [pscustomobject]@{ channelId = "MsTeams" },
      [pscustomobject]@{ channelId = "Microsoft365Copilot" })
$body = @{ configuration = ($c | ConvertTo-Json -Depth 8 -Compress) } | ConvertTo-Json
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers ($h + @{"If-Match"="*"}) `
  -Uri "$org/api/data/v9.2/bots(<agentId>)" -Body $body

pac copilot publish --bot <agentId>       # REQUIRED - this provisions the channel
```

Verify it worked — `applicationmanifestinformation.teams` gains a `botChannelRegistrationAppId`:

```powershell
$b = Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/bots(<agentId>)?`$select=configuration,applicationmanifestinformation"
($b.configuration | ConvertFrom-Json).channels
($b.applicationmanifestinformation | ConvertFrom-Json).teams   # expect botChannelRegistrationAppId
```

An agent with no Teams channel has empty `channels` and **no** `botChannelRegistrationAppId`.
This produces the identical result to clicking **Add channel** in the Copilot Studio UI.

`configuration.isAgentConnectable: true` (default) and `authenticationmode: Integrated` are
also expected for Teams/M365 Copilot. Installing the app to your own Teams profile
("See agent in Teams") is still a UI action.

### Agent icon

`pac copilot init` leaves `bot.iconbase64` **empty**, so a CLI-created agent shows a generic
placeholder in the Copilot Studio agent list while UI-created agents show the default icon.
Copy the icon from any existing agent (or supply your own PNG):

```powershell
$icon = (Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/bots(<sourceAgentId>)?`$select=iconbase64").iconbase64
Invoke-RestMethod -Method Patch -ContentType "application/json" -Headers ($h + @{"If-Match"="*"}) `
  -Uri "$org/api/data/v9.2/bots(<agentId>)" -Body (@{ iconbase64 = $icon } | ConvertTo-Json)
pac copilot publish --bot <agentId>
```

Also drop the PNG in the workspace root as `icon.png` so clones/packs carry it.

## Verify an agent is private to its owner

```powershell
# owner
$b = Invoke-RestMethod -Uri ".../bots(<agentId>)?`$select=name,_ownerid_value" -Headers $h
Invoke-RestMethod -Uri ".../systemusers($($b._ownerid_value))?`$select=fullname,domainname" -Headers $h

# shares
Invoke-RestMethod -Headers $h -Uri `
  ".../RetrieveSharedPrincipalsAndAccess(Target=@t)?@t={'@odata.id':'bots(<agentId>)'}"
```

Expect exactly **one** share: a system team named `<agentIdNoDashes>_1`
("Internal power virtual agents Chatbotmanager team for botId ..."). Confirm its
`teammembership_association` contains only the owner. That is a private agent — this team is
created automatically, not a real share with other people.

## Testing an agent conversationally

**Always generate a standalone test script when you build an agent**, so it can be re-verified
later. Use the **`copilot-studio-agent-test`** skill — it covers the one-time Entra app
registration for `CopilotStudio.Copilots.Invoke`, a ready-made Node script built on
Microsoft's official `@microsoft/agents-copilotstudio-client`, how to prove a tool actually
fired, and the common failure modes.

Key point: the conversation API streams **Server-Sent Events** and needs a strict Activity
envelope — raw `Invoke-RestMethod`/`curl` calls return HTTP 400. Anonymous Direct Line only
works for `authenticationmode: None` agents; never weaken a private agent's auth just to test it.
## Adding tools

To attach an MCP server as a tool, use the **`copilot-studio-mcp-tool`** skill.

To have one agent call another agent (multi-agent / orchestrator setups), use the
**`copilot-studio-connected-agent`** skill.

## References

- `references/CLI_RECIPES.md` — copy-paste scripts for every operation above.
