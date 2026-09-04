---
name: copilot-studio-agent-test
description: >-
  Verify a Microsoft Copilot Studio agent actually works at runtime by holding a real conversation
  with it from the terminal, and prove that a specific tool (MCP server, connector, or knowledge
  source) genuinely fired rather than the model answering from its own knowledge. Generates a
  ready-to-run Node test script that performs an Entra ID device-code sign-in and talks to the
  authenticated Copilot Studio conversation API via Microsoft's official agents-copilotstudio-
  client, including the one-time app registration that grants CopilotStudio.Copilots.Invoke. Also
  diagnoses common failure modes: connection-manager blocking, Integrated-auth channel errors, and
  empty responses. Use when the user wants to test, verify, smoke-test or chat with a Copilot
  Studio agent from the CLI, confirm a tool is being called, or debug an agent that returns
  nothing. Triggers: test my copilot studio agent, did the tool fire, agent returns nothing, smoke
  test agent.
---

# Testing a Copilot Studio agent from the CLI

Always produce a **standalone test script** alongside any agent you build, so the agent can be
re-verified later without redoing this research. Start from `assets/test-agent.mjs`.

## Why Node and not PowerShell/curl

The authenticated conversation endpoint streams **Server-Sent Events**, and the request body is
a strict Activity envelope. Hand-rolled REST calls fail:

| Attempt | Result |
| --- | --- |
| `POST /conversations/{id}` with a naive JSON body | **400**, empty error body |
| `POST /conversations/{id}/activities` | **404 RouteNotFound** |
| Anonymous Direct Line against an Integrated-auth agent | `IntegratedAuthenticationNotSupportedInChannel` |

Use `@microsoft/agents-copilotstudio-client`. It handles the envelope, SSE parsing, and
conversation headers.

```powershell
cd <project>
npm init -y
npm pkg set type=module
npm install @microsoft/agents-copilotstudio-client
```

## Step 1 — one-time app registration

Agents with `authenticationMode: Integrated` need a **delegated user token** with scope
`https://api.powerplatform.com/CopilotStudio.Copilots.Invoke`.

The Azure CLI's own client app **cannot** obtain this scope:
`AADSTS65002: Consent between first party application ... must be configured via
preauthorization`. Creating an `oauth2PermissionGrant` for the Azure CLI SP does not help.
Register your own public client:

```powershell
$app = az ad app create --display-name "cs-agent-invoker" `
        --is-fallback-public-client true --public-client-redirect-uris "http://localhost" `
        -o json | ConvertFrom-Json
az ad app permission add --id $app.appId `
        --api 8578e004-a5c6-46e7-913e-12f58912df43 `
        --api-permissions "204440d3-c1d0-4826-b570-99eb6f5e2aeb=Scope"
az ad app permission admin-consent --id $app.appId
$app.appId
```

- Power Platform API app id: `8578e004-a5c6-46e7-913e-12f58912df43`
- `CopilotStudio.Copilots.Invoke` scope id: `204440d3-c1d0-4826-b570-99eb6f5e2aeb`

The script then runs a **device-code** flow, so it works from any terminal and does not depend
on which account `az` happens to be logged into. Warn the user to sign in with the **agent's
tenant account**, which is often not their corporate account.

## Step 2 — generate the script

Copy `assets/test-agent.mjs` into the project and fill the `CONFIG` block:

```js
const CONFIG = {
  tenantId:      '<TENANT_GUID>',
  clientId:      '<APP_REGISTRATION_CLIENT_ID>',
  environmentId: '<ENVIRONMENT_GUID>',
  schemaName:    'cr123_LearnDocsAgent',
  signInAs:      'user@tenant.onmicrosoft.com',
  expectCitations: ['learn.microsoft.com'],
  defaultQuestion: '...'
}
```

`schemaName` comes from `pac copilot list` or `settings.mcs.yml`.
Environment host is derived automatically by the client from `environmentId`.

Run it:

```powershell
node test-agent.mjs
node test-agent.mjs "a different question"
node test-agent.mjs "question" --verbose     # dump every activity
```

## Step 3 — interpret the result

**Proving a tool fired is the whole point.** Copilot Studio renders citations as private-use
anchor glyphs inside `activity.text`; the real source URLs live in the activity's `entities` /
`channelData`. So checking `text` for a URL gives false negatives — the script scans the entire
serialized activity instead.

- Answer + expected citation host -> the tool fired. **PASS**
- Answer but zero URLs anywhere -> the model answered from its own knowledge; the tool did not
  fire. Check `modelDescription` (too vague?) and that generative orchestration is on.
- No answer at all -> re-run with `--verbose`.

## Failure modes

### Connection-manager card — blocks EVERY turn

```
"name": "connectors/connectionManagerCard"
"Let's get you connected first ... Open connection manager to verify your credentials."
```

The tool's `connectionProperties.mode` is `Invoker`. Per the Copilot Studio schema:

| mode | meaning |
| --- | --- |
| `Invoker` | **End user credentials** — each invoking user must authorize their own connection |
| `Maker` | **Maker-provided credentials** — uses the connection the maker already created |

A CLI-created connection is not registered as any user's authorized connection, so `Invoker`
stalls the orchestrator before it reaches your tool — even unrelated questions like "tell me a
joke" return the card. Fix:

```yaml
  connectionProperties:
    mode: Maker
```

then `pac copilot push` and `pac copilot publish`. Use `Maker` for single-user/private agents
and for anything built headlessly.

### Other

| Symptom | Cause |
| --- | --- |
| `IntegratedAuthenticationNotSupportedInChannel` | Anonymous Direct Line against an Integrated-auth agent. Use this skill's authenticated path; don't downgrade the agent's auth to test it. |
| `AuthenticationNotConfigured` | `authenticationmode` set to None while `authenticationtrigger` is still Always / access policy still requires auth. |
| 400 with empty body on send | Hand-rolled Activity payload — use the official client. |
| `InsufficientDelegatedPermissions` | Token lacks `CopilotStudio.Copilots.Invoke` — see Step 1. |
| Sign-in succeeds but 403 | Signed in with the wrong tenant account. |

## Related

- **`copilot-studio-agent`** — create, configure, and publish agents.
- **`copilot-studio-mcp-tool`** — attach an MCP server as a tool.
- **`copilot-studio-connected-agent`** — have one agent call another agent.
