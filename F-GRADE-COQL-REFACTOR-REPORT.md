# COQL Engine Refactoring Report

## 1. Largest Source Files

Measured JavaScript hotspots:

- `src/controllers/crm.controller.js`: natural-language planner, continuation orchestration, canonical state, field/date/filter parsing, answer formatting, and dashboard formatting.
- `src/services/crm.service.js`: request canonicalization, metadata materialization, validation, ordinary records, counts, aggregates, comparisons, conversion analysis, activity analysis, and result shaping.
- `src/services/zohoCrm.service.js`: metadata APIs, module resolution, COQL request construction, HTTP execution/retry boundary, and response extraction.
- `src/validators/crmQuery.validator.js`: canonical request validation and module/field/operator checks.
- `src/services/coql.service.js`: reusable COQL filter formatting and where-clause construction.

## 2. Current Responsibilities and Duplication

- The controller owns both HTTP handling and a large natural-language planner.
- CRM service owns both orchestration and multiple analysis implementations.
- COQL construction exists in `coql.service.js` and dynamic construction in `zohoCrm.service.js`.
- Pagination state and continuation calculation are shared conceptually but currently orchestrated in the controller.
- Metadata resolution is primarily centralized in `materializeMetadataRequest`, with module aliases also present in planner/constants.
- Diagnostics are threaded through business execution and should remain observational.

## 3. Dependency Problems

- The controller directly owns planner parsing and pagination decisions.
- The CRM service calls metadata and Zoho APIs while also normalizing semantic fields and result contracts.
- Zoho service builds query text, coupling transport and query planning.
- Analysis paths are mixed into the ordinary CRM service.

## 4. Proposed Cohesive Destinations

- `src/orchestration/crmAssistant.service.js`: one assistant request coordinator.
- `src/plans/canonicalPlan.js`: canonical plan compatibility facade over the existing query plan.
- `src/metadata/fieldResolver.js`: extracted metadata field lookup/materialization boundary.
- `src/filters/filterNormalizer.js`: unary/value normalization and typed filter cleanup.
- `src/filters/dateResolver.js`: extracted only if planner date helpers can move without behavior drift.
- `src/coql/coqlBuilder.js`: stable facade over the existing tested COQL builder.
- `src/coql/coqlPagination.js`: shared limit/offset validation and suffix generation.
- `src/pagination/paginationManager.js`: conversation state and continuation facade over the existing pagination helper.
- `src/results/crmResultNormalizer.js`: shared response shape for ordinary record results.

No module-specific files are proposed.

## 5. Migration Order

1. Add characterization tests for the current assistant path and COQL output.
2. Extract pure pagination, filter normalization, and COQL builder interfaces.
3. Add the assistant orchestrator and route the controller through it.
4. Move metadata and result normalization behind narrow interfaces.
5. Separate analysis services only where existing tests identify a stable boundary.
6. Remove duplicate compatibility code only after all tests pass.
7. Run syntax checks, focused tests, full tests, diff checks, and health smoke test.

## 6. Risks

- The controller planner is exported and directly tested; moving it must preserve `planQuestion`.
- `CrmService.query` is used by routes, tools, tests, and analysis methods; its public shape must remain stable.
- Meetings resolve to the Zoho `Events` API name and must retain that behavior.
- Existing OpenAPI foundation tests currently depend on repository OpenAPI content; the refactor must not modify that file.
- Live metadata and Zoho behavior cannot be proven without configured credentials.

## 7. Success Criteria

- One assistant orchestration path.
- Canonical typed plan passed downstream.
- One generic pagination manager and COQL pagination component.
- One tested COQL builder boundary.
- Controller remains HTTP-focused for assistant execution.
- Existing public endpoint and test contracts remain unchanged.
