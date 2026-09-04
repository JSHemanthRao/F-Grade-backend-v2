# Copilot Studio Agent Skills

A set of **agent skills** for building, wiring, testing, and packaging **Microsoft Copilot Studio**
agents entirely from the command line — no Copilot Studio web UI and no browser automation. They
are written for agentic coding assistants such as the **GitHub Copilot CLI** (and compatible skill
runtimes), and are verified against **Power Platform CLI (`pac`) 2.9.3**.

Everything is driven by `pac copilot`, the **Dataverse Web API**, and the **Power Apps REST API**,
so you can create an agent, attach tools (MCP servers, connectors, flows, connected agents), set
authentication, publish, and prove it actually works — all as repeatable, scriptable steps.

## What's inside

| Skill | What it does |
| --- | --- |
| [`copilot-studio-agent`](skills/copilot-studio-agent/SKILL.md) | Create, clone, edit, publish, and manage Copilot Studio agents as code with `pac copilot`. Covers the sync loop, agent-level settings via the Dataverse Web API, Teams/M365 channels, icons, and privacy verification. |
| [`copilot-studio-mcp-tool`](skills/copilot-studio-mcp-tool/SKILL.md) | Attach a remote **MCP server** to an agent: author the OpenAPI/swagger with `x-ms-agentic-protocol`, create the custom connector, connection, `connectionreference`, and tool YAML. |
| [`copilot-studio-connected-agent`](skills/copilot-studio-connected-agent/SKILL.md) | Wire one agent to another (multi-agent / orchestrator) with `InvokeConnectedAgentTaskAction`, including input/output passing and the common `NoOutputSetInEmitMode` failure. |
| [`copilot-studio-agent-flow`](skills/copilot-studio-agent-flow/SKILL.md) | Build solution-aware Power Automate **agent flows** and attach them to an agent, with embedded connector bindings and Maker-mode tools. |
| [`copilot-studio-agent-test`](skills/copilot-studio-agent-test/SKILL.md) | Hold a real conversation with an agent from the terminal and **prove a tool fired**. Ships a ready-to-run Node script using Microsoft's official `@microsoft/agents-copilotstudio-client`. |
| [`copilot-studio-headless-test`](skills/copilot-studio-headless-test/SKILL.md) | Test agents headlessly (or via an authenticated portal fallback) and require durable evidence — flow runs, Dataverse rows, email, or MCP telemetry — that a tool executed. |
| [`dataverse-flow-create-record`](skills/dataverse-flow-create-record/SKILL.md) | Generate correct Dataverse `CreateRecord` connector parameters from table metadata and debug `Invalid property` / casing / type errors. |
| [`power-platform-solution-alm`](skills/power-platform-solution-alm/SKILL.md) | Create publishers and unmanaged/managed solutions, add every dependent component, and export a verified managed package for deployment. |

## How agent skills work

Each skill is a folder containing a `SKILL.md` file with YAML front matter (`name` + `description`)
followed by task instructions. Compatible agents read the `description` to decide when a skill
applies, then load the full `SKILL.md` (and any `references/` or `assets/` files) on demand.

### Install for the GitHub Copilot CLI

Copy any skill folder into your user skills directory:

```powershell
# Windows
Copy-Item -Recurse .\skills\copilot-studio-agent "$env:USERPROFILE\.copilot\skills\"
```

```bash
# macOS / Linux
cp -R ./skills/copilot-studio-agent ~/.copilot/skills/
```

The same folders work with other skill-aware runtimes (e.g. `~/.claude/skills/`). Restart the
CLI, then ask it to do something the skill covers (for example, *"create a Copilot Studio agent
from the CLI"*).

## Prerequisites

- **Power Platform CLI** (`pac`) authenticated to your target environment (`pac auth who`).
- **Azure CLI** (`az`) signed in to the same tenant — used for Dataverse / Power Apps tokens.
- Your Dataverse **org URL** and **environment GUID**.
- For agent testing: a public-client Entra app with the
  `https://api.powerplatform.com/CopilotStudio.Copilots.Invoke` scope (the test skill walks you
  through the one-time registration).

## A note on the examples

The worked examples use **illustrative, non-real identifiers** — environment GUIDs, org URLs,
publisher prefixes (e.g. `cr123`), agent/connector/connection IDs are all placeholders. Substitute
your own values. Public, tenant-independent identifiers are kept as-is (for example the Microsoft
Learn MCP endpoint `https://learn.microsoft.com/api/mcp`, the `shared_msnweather` connector, and
Microsoft's well-known Power Platform API app/scope IDs).

## Contributing

Issues and pull requests are welcome. If a skill needs a new rule to prevent a repeatable failure,
add the smallest preventive note to the relevant `SKILL.md`.

## License

[MIT](LICENSE) © 2026 Jon Butler ([@jonnybottles](https://github.com/jonnybottles))
