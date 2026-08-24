# Implementation Plan: Codex Usage Monitor MVP

## Overview

Build a local-only, read-only dashboard that attributes cumulative Codex rollout token snapshots to individual subagent turns, persists derived records in SQLite, and streams updates to a Chinese web interface.

## Architecture Decisions

- Observe `.codex` files without modifying Codex configuration or resuming live threads.
- Treat `total_token_usage` as cumulative and derive task usage from boundary deltas; never sum `last_token_usage`.
- Store usage metadata indefinitely, but load task instruction previews directly from source logs only when requested.
- Use Node.js built-ins only: `node:http`, `node:sqlite`, filesystem watching, SSE, and static browser assets.
- Bind only to loopback and require a per-launch session token exchanged for a strict cookie.

## Task List

### Phase 1: Foundation

- [x] Create the project, SQLite schema, parser types, and health model.
- [x] Index root sessions and subagent lineage from Codex state plus rollout metadata.

### Checkpoint: Foundation

- [x] Project syntax checks pass.
- [x] A real session and its descendants can be discovered without changing `.codex`.

### Phase 2: Usage slices

- [x] Parse task boundaries and cumulative token snapshots into durable per-task deltas.
- [x] Add live tailing, quota snapshots, and idempotent persistence.
- [x] Expose authenticated snapshot, SSE, preview, quota, and health APIs.

### Checkpoint: Core Features

- [x] The five-turn real sample matches the known token totals.
- [x] Duplicate snapshots and partial lines do not double-count.

### Phase 3: Interface and verification

- [x] Build the responsive Chinese session, agent-tree, and task-detail interface.
- [x] Add parser, persistence, security, and live-update tests.
- [x] Run browser-based visual and end-to-end verification.

### Phase 4: Delivery and repository governance

- [x] Establish a Git `main` baseline and exclude runtime databases, logs, and tool caches.
- [x] Add project-level multi-agent ownership, integration, Git, and handoff rules.
- [x] Document delivery, architecture, API, operations, verification, roadmap, and contribution workflow.
- [x] Record the observer, attribution, persistence, security, live-update, and runtime-stack decisions as ADRs.
- [x] Make the developer-only real-history test explicitly report `skipped` when its source sample is absent.

### Checkpoint: Delivery

- [x] Documentation links and required ADR sections are covered by automated tests.
- [x] Runtime SQLite files, `.codex` source data, and tool caches are absent from the Git baseline.
- [x] The final commit is created only after tests, syntax checks, diff checks, and an independent read-only review.

### Independent review remediation

- [x] Preserve derived sibling tasks when an original rollout disappears and recompute durable subtree totals.
- [x] Migrate to schema v5 cursors with line numbers, parser diagnostics, cumulative usage, and restore/replay validation.
- [x] Restrict previews to provable parent-to-child instruction envelopes.
- [x] Surface unknown/skipped rollout formats as parser warnings.
- [x] Remove CSP-incompatible inline styles and add a static UI security contract test.
- [x] Expand HTTP tests for Cookie attributes, one-time token exchange, Host, CSP, Origin, and write-method rejection.

### Phase 5: Per-task model strength and USD cost visibility

- [x] Preserve the existing task-level `turn_context.model` and `turn_context.effort` contract through parser snapshots, SQLite restore, and the authenticated session API.
- [x] Show model, model strength, and a USD cost estimate on every subagent task row, with explicit unknown states when rollout metadata is absent.
- [x] Calculate cost from each audited token field with a versioned official standard API rate card; label it as an API-equivalent estimate rather than Codex subscription billing.
- [x] Update the public behavior documentation and changelog, then verify desktop and narrow-screen layouts in a real browser.

#### Task 1: Lock the metadata and cost contract

**Description:** Extend deterministic tests around the already-persisted `model`, `effort`, and per-field `deltaUsage` so replay and SQLite restore cannot silently drop the data used by the interface or pricing estimator.

**Acceptance criteria:**

- [x] A fixture task retains `model` and `effort` after parsing and database reopen.
- [x] The same task retains its boundary-derived token breakdown and quality label.
- [x] Missing model or effort remains `null` and is never guessed from agent role or model family.

**Verification:** `npm test`

**Dependencies:** None.

**Files likely touched:** `test/parser.test.js`, `test/database-server.test.js`.

**Estimated scope:** Small.

#### Task 2: Calculate a versioned API-equivalent cost

**Description:** Add a deterministic, offline price catalog and attach a structured cost estimate to each API task without persisting a mutable dollar amount.

**Acceptance criteria:**

- [x] Supported models use official per-field rates with GPT-5.6 cache writes and output reasoning accounted exactly once.
- [x] Unknown models, incomplete fields, inconsistent totals, and stale catalogs remain explicit.
- [x] The session API exposes per-task estimates, catalog metadata, and subagent coverage totals.

**Verification:** `npm test`, `npm run check`.

**Dependencies:** Task 1.

**Files likely touched:** `src/pricing.js`, `src/monitor.js`, `test/pricing.test.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

#### Task 3: Expose the fields in each task row

**Description:** Add model, strength, and estimated USD columns to the task table, preserving the detailed input/cache/output/reasoning breakdown and horizontal narrow-screen access.

**Acceptance criteria:**

- [x] Every task row renders model, strength, and API-equivalent USD cost from its own task record.
- [x] Null metadata is shown as an explicit unknown marker rather than a blank or inherited value.
- [x] Table semantics, preview row span, escaping, and responsive overflow remain correct.

**Verification:** `npm run check`, `npm test`, desktop browser check, narrow-screen browser check.

**Dependencies:** Task 2.

**Files likely touched:** `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

#### Task 4: Document the user-visible contract

**Description:** Document where model and strength come from, define USD cost as a versioned standard API short-context equivalent, and record the delivered behavior and verification evidence.

**Acceptance criteria:**

- [x] README and API docs describe the three displayed values and their unknown-state behavior.
- [x] Documentation prohibits quota-to-currency conversion and distinguishes the estimate from actual Codex subscription billing.
- [x] Changelog and verification evidence match the implemented and actually executed checks.

**Verification:** `npm test`, `npm run check`.

**Dependencies:** Task 3.

**Files likely touched:** `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/decisions/0007-versioned-api-equivalent-cost.md`, `docs/decisions/README.md`.

**Estimated scope:** Medium.

### Checkpoint: Model strength and cost

- [x] Parser/database/UI contract tests pass.
- [x] Full tests and syntax checks pass.
- [x] Desktop and narrow-screen task tables show model, strength, and USD estimate without obscuring quality or preview controls.
- [x] Source rollout hashes are unchanged whenever a real-history check is executed.

## Phase 6: Agent and session cost rollups

### Goals

- [x] Summarize each agent's own API-equivalent USD cost and the cost of its full descendant subtree.
- [x] Summarize the entire session cost across the root agent and every descendant, while retaining a separate subagent-only total.
- [x] Preserve partial and unavailable coverage instead of presenting incomplete estimates as exact totals.

#### Task 1: Add cost-summary aggregation to the snapshot API

**Description:** Reuse the same agent lineage already used for token rollups to calculate own-agent, descendant-inclusive, session-total, and subagent-only API-equivalent cost summaries.

**Acceptance criteria:**

- [x] Every agent exposes `ownCostEstimate` and `subtreeCostEstimate`.
- [x] Session summary exposes `totalCostEstimate` and `subagentCostEstimate`.
- [x] Known amounts remain summable when some tasks are unavailable, with counts and `partial` status preserved.

**Verification:** `npm test`, `npm run check`.

**Dependencies:** Phase 5 pricing contract.

**Files likely touched:** `src/pricing.js`, `src/monitor.js`, `test/pricing.test.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

#### Task 2: Show session and agent totals in the dashboard

**Description:** Add a session cost metric and agent-card own/subtree cost statistics, with responsive visibility and clear partial or unavailable labels.

**Acceptance criteria:**

- [x] The overview shows the session-wide API-equivalent USD total and coverage.
- [x] Each agent card shows its own and descendant-inclusive totals.
- [x] Partial totals use a lower-bound marker and unavailable totals remain explicit on desktop and narrow screens.

**Verification:** `npm test`, `npm run check`, desktop browser check, narrow-screen browser check.

**Dependencies:** Task 1.

**Files likely touched:** `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

#### Task 3: Record the expanded cost contract and evidence

**Description:** Update the accepted pricing decision, public documentation, changelog, and verification record to match the delivered rollups.

**Acceptance criteria:**

- [x] Documentation distinguishes task, own-agent, subtree, subagent-only, and complete-session cost scopes.
- [x] Partial rollups are documented as known lower bounds, never billing-grade totals.
- [x] Verification evidence reports only checks actually executed.

**Verification:** `npm test`, `npm run check`.

**Dependencies:** Tasks 1 and 2.

**Files likely touched:** `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/decisions/0007-versioned-api-equivalent-cost.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Medium.

### Checkpoint: Cost rollups

- [x] Agent own/subtree and session total/subagent-only API fields pass regression coverage.
- [x] Full tests and syntax checks pass.
- [x] Desktop and narrow-screen views expose the new totals without obscuring existing usage details.
- [x] Source rollout hashes are unchanged whenever a real-history check is executed.

## Phase 7: Project-grouped sessions and cache visibility

### Task 1: Persist the observed project directory

**Description:** Promote the observed root `session_meta.cwd` field into session locator metadata so sessions can be grouped by exact project directory even after restart, without reading or persisting conversation content.

**Acceptance criteria:**

- [x] Repository sessions expose the root session `cwd` as nullable `projectPath`; child working directories never override the root project.
- [x] SQLite schema migration preserves `projectPath`, and the authenticated session list/snapshot APIs return it.
- [x] Search includes project path while absent paths remain an explicit ungrouped state.

**Verification:** `npm test`, `npm run check`.

**Dependencies:** Phase 6.

**Files likely touched:** `src/repository.js`, `src/database.js`, `src/monitor.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 2: Group sessions and expose cache efficiency

**Description:** Group the sidebar by exact project path and surface audited input, output, and cache-hit ratios at session, agent, and task scopes while removing the temporary instruction-preview column from the task table.

**Acceptance criteria:**

- [x] Sidebar groups sessions by normalized exact project path, labels each group with its directory name and full path, and keeps unknown projects separate.
- [x] Session overview exposes input, output, and total cache-hit ratio; every agent summary and task row exposes its own cache-hit ratio using `cachedInputTokens / inputTokens`.
- [x] The task table no longer renders an instruction column or preview row, while the protected backend preview contract remains unchanged for a future complete-conversation flow.

**Verification:** `npm test`, `npm run check`, desktop browser check, narrow-screen browser check.

**Dependencies:** Task 1.

**Files likely touched:** `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Checkpoint: Project grouping and cache visibility

- [x] Full tests and syntax checks pass.
- [x] Desktop and narrow-screen session navigation remains usable with several project groups.
- [x] Input/output/cache ratios match deterministic fixtures and no instruction preview appears in the UI.
- [x] Commit the complete Phase 7 slice with an explicit Conventional Commit message.

## Phase 8: Claude-inspired editorial observability workspace

### Design brief and token plan

**Subject and job:** A private observability ledger for one developer who needs to move between project-scoped Codex sessions, distinguish agent responsibilities, and audit token flow without visual fatigue.

**Palette:** parchment `#F4F1EA`, paper `#FBFAF7`, ink `#2D2A26`, muted graphite `#6F6A63`, Claude clay `#C15F3C`, sage `#667A68`, and hairline `#D8D1C7`. Dark cyan is retired; color communicates selection, lineage, role, quality, and quota rather than filling cards.

**Typography:** restrained editorial serif (`Charter`, `Iowan Old Style`, Chinese serif fallbacks) for session and section titles; calm system sans for navigation and prose; `Cascadia Code`/system monospace with tabular numerals for paths, IDs, token values, and aligned tables. No remote font dependency is introduced under the self-only CSP.

**Layout:** treat the sidebar as a project index, the overview as a ruled ledger rather than a card grid, and the agent area as one continuous nested activity document.

```text
┌ project index ─────┬──────────────── selected session / project ───────────────┐
│ PROJECT A          │ title                                      live status    │
│  session           │ input · output · cache · cost · agents · tasks            │
│  session           ├──────────────── quota strip ───────────────────────────────┤
│ PROJECT B          │ role ─ agent ───────── own / subtree / cache               │
│  session           │   └ role ─ child agent                                    │
│                    │       aligned task ledger                                  │
└────────────────────┴─────────────────────────────────────────────────────────────┘
```

**Signature:** a continuous clay-colored lineage ledger with depth gutters and elbow connectors; prominent role labels sit on the rail like index tabs, making `reviewer`, `test-worker`, and related responsibilities scannable before agent names.

**Self-critique before build:** Warm paper, serif type, and clay accent are common generative defaults, but the user explicitly requested Claude's design language. To keep the result product-specific, decorative cream/terracotta cards are rejected: the clay accent is spent only on project selection and the lineage ledger, while topology depth, role, table alignment, and data quality drive every structural device.

### Task 1: Recompose the application shell and overview

**Description:** Replace the dark control-room shell and card grid with a warm editorial workspace that gives project navigation, session identity, token flow, and quota a clear typographic hierarchy.

**Acceptance criteria:**

- [ ] Desktop, narrow, empty, loading, live, stale, and focus states share the documented type scale and palette.
- [ ] Overview metrics use aligned ruled groups with substantially fewer card containers.
- [ ] Project navigation remains searchable, readable, and operable by keyboard and mobile drawer.

**Verification:** `npm run check`, desktop browser check, narrow-screen browser check, keyboard focus check.

**Dependencies:** Phase 7.

**Files likely touched:** `public/index.html`, `public/styles.css`.

**Estimated scope:** Medium.

### Task 2: Rebuild topology and task hierarchy

**Description:** Turn the agent stream into a nested lineage ledger with explicit parent/child connectors, highly visible role badges, and a disciplined task table whose text and numeric columns align.

**Acceptance criteria:**

- [ ] Parent/child nesting remains visible at every supported depth without relying on card indentation alone.
- [ ] Known agent roles receive conspicuous, accessible labels with a neutral fallback for unknown roles.
- [ ] Task headers and values align consistently, numeric cells use tabular figures, and horizontal overflow remains discoverable on narrow screens.

**Verification:** `npm test`, `npm run check`, desktop and narrow-screen browser screenshots.

**Dependencies:** Task 1.

**Files likely touched:** `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 3: Record the visual decision and delivery evidence

**Description:** Capture the project-specific design rationale, alternatives, responsive/accessibility consequences, public behavior, and actual verification evidence.

**Acceptance criteria:**

- [ ] An accepted ADR records why the editorial ledger and lineage rail were chosen over cards, a graph canvas, and the existing dark dashboard.
- [ ] README, architecture/API notes, changelog, and verification record match shipped behavior.
- [ ] Final full test, syntax, diff, desktop, and narrow-screen checks pass before the second feature commit.

**Verification:** `npm test`, `npm run check`, documentation tests, `git diff --check`.

**Dependencies:** Tasks 1 and 2.

**Files likely touched:** `docs/decisions/0009-editorial-lineage-interface.md`, `docs/decisions/README.md`, `README.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Medium.

### Checkpoint: Editorial redesign

- [ ] Full tests and syntax checks pass.
- [ ] Desktop and narrow-screen visual QA confirms comfortable typography, clear project grouping, direct nesting, visible role identity, and aligned task data.
- [ ] Reduced-motion and keyboard-focus behavior remain intact.
- [ ] Commit the complete Phase 8 redesign and documentation with an explicit Conventional Commit message.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rollout wire format changes | High | Capability-based parsing, CLI version display, unknown-record counters, quality labels |
| Copied paginated history is counted twice | High | Respect `subagent_history_start_ordinal` and deduplicate tasks by thread/turn |
| Cumulative counters reset | High | Mark discontinuities and never synthesize a precise delta |
| Windows file notifications are dropped | Medium | Combine file watching with one-second stat reconciliation |
| Prompt text leaks into the archive | High | Never persist previews; serve them only after authenticated, explicit expansion |

## Open Questions

None. The user explicitly requested USD cost; ADR-0007 bounds it to a versioned official standard API short-context equivalent rather than billing-grade Codex subscription cost.

## Decision Log

Long-lived decisions are indexed in [`docs/decisions/README.md`](../docs/decisions/README.md). This plan remains the implementation history; ADRs are the source of truth for architectural rationale and consequences.
