---
name: copilot-studio-headless-test
description: >-
  Test Copilot Studio agents from the terminal or authenticated portal and prove a tool really fired. Use this skill whenever the user asks to test, smoke-test, invoke, or debug an agent; verify a flow/connector/MCP tool call; diagnose plausible but false agent answers; handle CopilotStudio.Copilots.Invoke device-code auth; or inspect flow runs and Dataverse side effects - even if they do not name the skill. Includes a Playwright fallback for unattended CLI authentication.
---

# Copilot Studio Headless and Portal Testing

Test real agent behavior and require durable evidence that the intended tool executed.

## Prerequisites

- Published Copilot Studio agent schema name and environment GUID.
- One of:
  - Public-client Entra app with `CopilotStudio.Copilots.Invoke`, or
  - Authenticated Copilot Studio browser session through Playwright.
- Access to the tool's side-effect system: Power Automate run history, Dataverse, email, files,
  or MCP endpoint telemetry.

## Core Principle

**An agent's natural-language response is not proof.** The model can claim it saved, emailed, or
called a tool without doing so. A test passes only when independent evidence exists.

## Workflow A: Node Conversation Client

1. Use `@microsoft/agents-copilotstudio-client`.
2. Obtain a delegated token with
   `https://api.powerplatform.com/CopilotStudio.Copilots.Invoke`.
3. Use device-code sign-in with the target tenant account.
4. Start a conversation and send a prompt containing every required input.
5. Capture every streamed activity with `--verbose` when diagnosing.

> Azure CLI's own application normally cannot request the Invoke scope. Use a dedicated public
> client registration. Device codes expire; do not start this route if no user can complete sign-in.

## Workflow B: Authenticated Portal Fallback

Use Playwright when device-code authentication would block unattended execution:

1. Navigate to the agent overview.
2. Select the already-signed-in target tenant account.
3. Open **Test**.
4. Start a fresh test session after every publish or flow-definition change.
5. Send an explicit prompt.
6. Read the agent response only as preliminary evidence.
7. Verify the external side effect separately.

## Proving Tool Execution

### Power Automate Agent Flow

Require:

- A new run with start time matching the test
- Correct bot schema/channel correlation
- `status: Succeeded`
- Each required action succeeded

### Dataverse Write

Query the target EntitySetName and confirm the exact input/output values and timestamp.

### Email

Confirm the email connector action exists in the flow and succeeded. An email input or reviewer
email column does **not** imply an email was sent. If possible, also verify Sent Items or message
trace.

Use this evidence ladder:

1. `Send_an_email_(V2)` exists in `workflow.clientdata`.
2. The matching run action has `status: Succeeded`.
3. Search the recipient mailbox for the exact subject and timestamp.
4. If absent, inspect junk/quarantine, recipient spelling, mailbox licensing, and message trace.

Connector success proves Outlook accepted the operation; mailbox search proves delivery to the
expected account.

### MCP or Knowledge Tool

Require citation/entity URLs, server telemetry, or another tool-specific artifact. Plain answer
text is insufficient.

## Diagnostic Sequence

1. **No flow run:** tool was not selected. Inspect description, enabled state, and agent
   instructions.
2. **Flow run failed:** inspect the first failed action and its complete inner error.
3. **Flow succeeded but no side effect:** verify action configuration and destination.
4. **Side effect exists but user did not receive it:** inspect connector delivery status, recipient,
   mailbox availability, junk/quarantine, and message trace.

## Known Failure Modes

| Symptom | Cause | Recovery |
| --- | --- | --- |
| Device-code timeout | User did not complete sign-in | Restart test or use authenticated portal |
| Agent claims save but no flow run | Model hallucinated success | Fix tool discovery; require run evidence |
| Connection-manager card | `connectionProperties.mode: Invoker` | Use Maker mode for headless/private tools |
| Tool never selected | Empty/vague model description | Use a specific single-line description |
| Flow test button does nothing | Agent-only `Skills` trigger | Invoke through the agent |
| Email not received, no email action run | Flow never included send-email action | Add explicit connector action and reference |
| Email action succeeds but inbox is empty | Delivery/routing issue after connector acceptance | Search Sent Items, junk/quarantine, and message trace |

## Output Format

Use:

```text
Agent response: ...
Tool execution: PASS/FAIL
Evidence:
- Flow run ID/status
- Action status
- Side-effect record/message/file
False-positive risks checked: ...
```

## Post-Run Reflection

When the agent answer and durable evidence disagree, update this skill with the detection rule that
would have caught the false positive sooner.
