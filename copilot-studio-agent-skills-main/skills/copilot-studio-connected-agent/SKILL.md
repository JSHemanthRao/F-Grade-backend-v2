---
name: copilot-studio-connected-agent
description: >-
  Wire one Microsoft Copilot Studio agent to another as a connected agent (multi-agent / agent-to-
  agent orchestration) from the command line - no Copilot Studio web UI, no browser automation.
  Covers the InvokeConnectedAgentTaskAction tool YAML, child-first build order, referencing a
  connected agent from the parent agent's instructions, passing inputs and outputs across the
  agent boundary with inputType / outputType and global variables, and pac CLI quirks that mangle
  or over-length component schema names. Leads with the AgentpluginActionNoOutputSetInEmitMode
  failure seen when a connected-agent tool is left in emit mode with no declared outputs. Use when
  the user wants an agent to call another agent, build a parent/orchestrator agent, add a
  connected or child agent, or debug an agent-calls-agent error. Triggers: connected agent copilot
  studio, multi agent copilot studio, orchestrator agent, InvokeConnectedAgentTaskAction,
  NoOutputSetInEmitMode, botSchemaName.
---

# Connecting one Copilot Studio agent to another from the CLI

A **connected agent** is an independent, standalone agent that another agent calls as a tool.
A **child agent** is owned by, and lives inside, its parent. This skill covers connected agents,
built with `pac copilot` — see `copilot-studio-agent` for creating the agents themselves and
`copilot-studio-mcp-tool` for attaching MCP servers.

Verified against pac CLI **2.9.3**.

## Golden rules

1. **Build the child first, and publish it.** The parent's tool YAML binds by
   `botSchemaName`, so the child's schema name must already exist when you push the parent.
2. **Do not set an output mode you cannot satisfy.** A connected-agent tool with
   `response.mode: Generated` and no `outputs:` fails every turn with
   `AgentpluginActionNoOutputSetInEmitMode`. Either declare outputs or omit the `response:`
   block entirely. **Omitting it is the right default** — the parent orchestrator then writes
   the final answer, exactly like a working MCP tool.
3. **Name tool files `action.<Name>.mcs.yml` or `topic.<Name>.mcs.yml`.** Any other leading
   segment is treated as a namespace and gets prepended to *every* component in the bot.
4. The child needs `configuration.isAgentConnectable: true` (the `pac copilot init` default)
   and generative orchestration on both sides.

## The tool YAML (parent side)

`agents/action.<Name>.mcs.yml` in the **parent** workspace:

```yaml
mcs.metadata:
  componentName: LearnDocsAgent
  description: Connected agent - learn-docs-agent
kind: TaskDialog
modelDisplayName: learn-docs-agent
modelDescription: <rich description — the orchestrator uses THIS to decide when to delegate>
action:
  kind: InvokeConnectedAgentTaskAction
  botSchemaName: cr123_learndocsagent
  historyType:
    kind: ConversationHistory
```

- `kind: TaskDialog` — same wrapper as MCP and connector tools.
- `action.kind: InvokeConnectedAgentTaskAction` — connected agents only. (MCP servers use
  `InvokeExternalAgentTaskAction`, connectors `InvokeConnectorTaskAction`, flows
  `InvokeFlowTaskAction`, AI Builder prompts `InvokeAIBuilderModelTaskAction`.)
- `botSchemaName` is the **child agent's** schema name, e.g. from `pac copilot list` or the
  child's `settings.mcs.yml`.
- `historyType.kind: ConversationHistory` passes the conversation so far to the child.
- **No connection, no connector, no `connectionreference`** — unlike every other tool kind.
  That is the whole appeal: agent-to-agent needs no plumbing.

Then:

```powershell
pac copilot push
pac copilot publish --bot <parentAgentId>
```

## Referencing the connected agent from the parent's instructions

Copilot Studio addresses tool components from instructions with a component path:

```yaml
instructions: |-
  You are the orchestrator agent in a multi-agent workflow.

  Make use of the {System.Bot.Components.Agents.'cr123_orchestratoragent.InvokeConnectedAgentTaskAction.action.LearnDocsAgent'.DisplayName}
  whenever a user query deals with Microsoft product documentation.
```

The quoted string is the component's **`botcomponent.schemaname`**, not the file name. Push the
tool first, read the real schema name back from Dataverse, then write the instructions:

```powershell
Invoke-RestMethod -Headers $h -Uri `
  "$org/api/data/v9.2/botcomponents?`$select=schemaname&`$filter=_parentbotid_value eq <parentAgentId>"
```

Plain English ("use the Learn Docs agent") also works and is less brittle; the component path
just gives the orchestrator an unambiguous handle.

## Inputs and outputs across the agent boundary

Only needed when the parent must pass a specific value in, or read a specific value out. For
plain "delegate the question, return the answer", skip this entirely.

**Parent side** — `inputType` / `outputType` go **inside `action:`** (for child agents they sit
at the root instead):

```yaml
kind: TaskDialog
inputs:
  - kind: AutomaticTaskInput
    propertyName: userEmail
    description: The email address of the user to look up
modelDisplayName: HR Specialist
modelDescription: Helps with HR information, including user role
outputs:
  - propertyName: userRole
action:
  kind: InvokeConnectedAgentTaskAction
  inputType:
    properties:
      userEmail:
        displayName: userEmail
        isRequired: true
        type: String
  outputType:
    properties:
      userRole:
        displayName: userRole
        description: The role of the user in the organization
        type: String
  botSchemaName: cr123_hrSpecialist
  historyType:
    kind: ConversationHistory
```

**Child side** — values cross the boundary through **global variables**, not the topic
`outputType`. In the child, make the variable global and tick *External source can set the
value* (inputs) / *External source can receive the value* (outputs). A child typically has an
`OnRecognizedIntent` topic for standalone use and an `OnRedirect` topic that fires when another
agent calls it; both should set `Global.<name>`.

## Component schema-name traps in pac 2.9.3

The `agents/` folder is not a free-form directory. Two failures show up immediately:

**Namespace bleed.** A file named `InvokeConnectedAgentTaskAction.LearnDocsAgent.mcs.yml`
causes pac to treat `InvokeConnectedAgentTaskAction` as a namespace and prepend it to every
component in the bot:

```
cr123_orchestratoragent.InvokeConnectedAgentTaskAction.action.MSNWeather-Getcurrentweather
```

**Over-length schema name.** `botcomponent.schemaname` is capped at 100 characters. Namespace
bleed plus a long agent schema name blows through it:

```
[0x80044331:StringLengthTooLong] The length of the 'schemaname' attribute of the
'botcomponent' entity exceeded the maximum allowed length of '100'.
```

Keep every file in `agents/` named `action.<ShortName>.mcs.yml` or `topic.<ShortName>.mcs.yml`.
The schema-name segment is cosmetic — a connected agent behaves identically whether its
component is called `...action.LearnDocsAgent` or `...InvokeConnectedAgentTaskAction.LearnDocsAgent`
(the latter is what the Copilot Studio UI produces).

**`pac copilot pull` rewrites `connectionreferences.mcs.yml`** from what the server knows, and a
push then deletes any Dataverse `connectionreference` row that is not listed in the file. If the
parent also has connector/MCP tools, re-add their entries after every pull, and re-create the
row if it disappeared, before pushing.

## Fixing `AgentpluginActionNoOutputSetInEmitMode`

```
<Connected agent name> — Failed
AgentpluginActionNoOutputSetInEmitMode
The action '<name>' with output mode 'Generate a Message' must have at least one output set.
```

The tool runs, the user sees a plausible answer (the parent orchestrator composes its own
reply), but the tool step is marked Failed on every turn.

Cause: `response.mode: Generated` with no `outputs:`.

```yaml
kind: TaskDialog
response:
  activity:
  mode: Generated     # emit mode - REQUIRES outputs
modelDisplayName: Learn Docs Agent
action:
  kind: InvokeConnectedAgentTaskAction
  botSchemaName: cr123_LearnDocsAgent
  historyType:
    kind: ConversationHistory
```

Two fixes:

| Fix | What to do | When |
| --- | --- | --- |
| **Drop emit mode** (recommended) | Delete the whole `response:` block; push; publish. In the portal: the tool's **Outputs** section → **Output mode** → anything other than *Generate a message*. | Almost always. The child already produces a natural-language answer. |
| **Declare an output** | Add `outputs: - propertyName: <name>` plus `action.outputType`, and populate a global variable in the child. | Only when the parent genuinely needs a structured value back. |

Republish after either change. The portal's connected-agent pane does not fully expose
inputs/outputs, so the second fix generally has to be done in YAML.

## Verify

```powershell
# tool component landed and points at the right child
Invoke-RestMethod -Headers $h -Uri `
  "$org/api/data/v9.2/botcomponents?`$select=schemaname,data&`$filter=_parentbotid_value eq <parentAgentId>"

# child is connectable and published
$b = Invoke-RestMethod -Headers $h -Uri "$org/api/data/v9.2/bots(<childAgentId>)?`$select=name,publishedon,configuration"
($b.configuration | ConvertFrom-Json).isAgentConnectable      # expect True
```

Structural checks do not prove delegation happens. Use the **`copilot-studio-agent-test`** skill
to hold a real conversation, and assert both that the child's own tool citations come back
through the parent **and** that `AgentpluginActionNoOutputSetInEmitMode` never appears in the
returned activities.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `AgentpluginActionNoOutputSetInEmitMode` while answers still look right | `response.mode: Generated` with no `outputs:` — see above |
| `StringLengthTooLong` on `botcomponent.schemaname` | Namespace bleed from a tool file not named `action.*` / `topic.*` |
| Every component suddenly renamed with an extra segment | Same cause; delete the bad `botcomponents` rows and re-push with corrected file names |
| `A record with the specified key values does not exist in connectionreference entity` | A *sibling* connector/MCP tool lost its `connectionreference` row after a pull rewrote `connectionreferences.mcs.yml` |
| Push fails with `Improper response, not implemented` | Generic pac wrapper error; read `%LOCALAPPDATA%\Microsoft\PowerAppsCLI\Microsoft.PowerApps.CLI.<ver>\tools\logs\pac-log.txt` for the real message |
| Parent never delegates | `modelDescription` too vague, generative orchestration off, or the child not published |
| Child answers but ignores passed values | Child reads `Topic.` variables instead of `Global.` ones, or *External source can set the value* is unticked |

## Related

- **`copilot-studio-agent`** — create, configure, publish, and share agents from the CLI.
- **`copilot-studio-mcp-tool`** — attach an MCP server as a tool.
- **`copilot-studio-agent-test`** — prove the whole chain works at runtime.

## References

- `references/WORKED_EXAMPLE.md` — a real two-agent build with every value used.
