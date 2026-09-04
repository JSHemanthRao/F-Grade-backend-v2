---
name: power-platform-solution-alm
description: >-
  Create and package Power Platform solutions from CLI/API tooling. Use this skill whenever the user asks for a publisher, unmanaged solution, managed solution, solution component membership, pac solution export/import, ALM packaging, connection references, Dataverse tables/flows/agents in one solution, or deployment artifacts - even if they do not name the skill. Covers component type IDs, export verification, and safe managed-vs-unmanaged guidance.
---

# Power Platform Solution ALM from the CLI

Create an editable unmanaged solution, add all dependent components, and export a verified managed
package for deployment.

## Prerequisites

- `pac` authenticated to the target environment.
- Azure CLI token for the Dataverse org.
- Dataverse Web API access.
- Component IDs for tables, flows, connection references, agents, and bot components.

## Managed vs Unmanaged

- **Unmanaged:** editable development copy in the source environment.
- **Managed:** locked deployment package for another environment.

Do not import a managed solution over its own unmanaged source copy in the same environment.

## Workflow

### 1. Create Publisher and Unmanaged Solution

Create a publisher with a unique prefix and option-value prefix. Create the solution with:

- `uniquename`
- `friendlyname`
- semantic `version`
- `publisherid@odata.bind`

Persist publisher ID, solution ID, unique name, and prefix.

### 2. Build Components in the Unmanaged Solution

Prefer `MSCRM.SolutionUniqueName` on create requests. For components created elsewhere, call
`AddSolutionComponent`.

Useful component types:

| Component | Type |
| --- | ---: |
| Entity/table | 1 |
| Workflow/cloud flow | 29 |
| Connection reference | 10163 |
| Copilot Studio bot | 10225 |
| Bot component | 10226 |

For tables and bots, set `DoNotIncludeSubcomponents: false` when the package must include their
attributes/topics/tools.

### 3. Confirm Solution Membership

Query `solutioncomponents` for the solution ID and group by `componenttype`.

Require at minimum:

- Table
- Flow
- Connection reference(s)
- Agent
- Agent topics/tools

Do not assume a component is included because it is referenced by another component.

### 4. Publish and Version

Publish the agent and activate flows before export. Increment the solution version for each
deployable release.

### 5. Export Managed Package

```powershell
pac solution export --name <UniqueName> --managed `
  --path C:\local\artifact\<UniqueName>_managed.zip --overwrite
```

Keep artifacts outside OneDrive when they may include environment metadata.

### 6. Inspect the ZIP

Open the ZIP read-only and verify:

- `solution.xml`
- `customizations.xml`
- `Workflows/<flow>.json`
- `bots/<schema>/...`
- `botcomponents/...`
- Table names and attributes in `customizations.xml`
- Connection reference logical names
- Expected tool YAML/data

Compute SHA-256 and report artifact size.

## Error Handling

| Symptom | Cause | Recovery |
| --- | --- | --- |
| Export succeeds but component is absent | Component was not added to the solution | Query `solutioncomponents`, add it, re-export |
| Agent present but tool absent | Bot subcomponents excluded | Add bot with subcomponents or add type 10226 components |
| Flow imports but connection is broken | Connection reference missing/unbound | Include reference and configure target-environment connection |
| Managed import conflicts in source env | Unmanaged source already exists | Deploy to another environment; do not destructively replace source |
| Table imports without columns | Entity subcomponents excluded | Re-add type 1 with subcomponents |

## Output Format

Report:

- Publisher and prefix
- Solution unique name/version
- Component counts by type
- Managed artifact path, size, and SHA-256
- ZIP evidence for each required component
- Target-environment connection steps still required

## Post-Run Reflection

If component membership or dependency discovery required manual package inspection, add the
specific component type or verification rule to this skill.
