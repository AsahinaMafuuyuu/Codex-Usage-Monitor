# Implementation Plan: Codex Usage Monitor MVP

## Overview

Build a local-only, read-only dashboard that attributes cumulative Codex rollout token snapshots to individual subagent turns, persists derived records in SQLite, and streams updates to a Chinese web interface.

## Architecture Decisions

- Observe `.codex` files without modifying Codex configuration or resuming live threads.
- Treat `total_token_usage` as cumulative and admit `last_token_usage` only when adjacent cumulative snapshots verify it; aggregate task usage exclusively from verified Request Ledger events.
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

- [x] Desktop, narrow, empty, loading, live, stale, and focus states share the documented type scale and palette.
- [x] Overview metrics use aligned ruled groups with substantially fewer card containers.
- [x] Project navigation remains searchable, readable, and operable by keyboard and mobile drawer.

**Verification:** `npm run check`, desktop browser check, narrow-screen browser check, keyboard focus check.

**Dependencies:** Phase 7.

**Files likely touched:** `public/index.html`, `public/styles.css`.

**Estimated scope:** Medium.

### Task 2: Rebuild topology and task hierarchy

**Description:** Turn the agent stream into a nested lineage ledger with explicit parent/child connectors, highly visible role badges, and a disciplined task table whose text and numeric columns align.

**Acceptance criteria:**

- [x] Parent/child nesting remains visible at every supported depth without relying on card indentation alone.
- [x] Known agent roles receive conspicuous, accessible labels with a neutral fallback for unknown roles.
- [x] Task headers and values align consistently, numeric cells use tabular figures, and horizontal overflow remains discoverable on narrow screens.

**Verification:** `npm test`, `npm run check`, desktop and narrow-screen browser screenshots.

**Dependencies:** Task 1.

**Files likely touched:** `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 3: Record the visual decision and delivery evidence

**Description:** Capture the project-specific design rationale, alternatives, responsive/accessibility consequences, public behavior, and actual verification evidence.

**Acceptance criteria:**

- [x] An accepted ADR records why the editorial ledger and lineage rail were chosen over cards, a graph canvas, and the existing dark dashboard.
- [x] README, architecture/API notes, changelog, and verification record match shipped behavior.
- [x] Final full test, syntax, diff, desktop, and narrow-screen checks pass before the second feature commit.

**Verification:** `npm test`, `npm run check`, documentation tests, `git diff --check`.

**Dependencies:** Tasks 1 and 2.

**Files likely touched:** `docs/decisions/0009-editorial-lineage-interface.md`, `docs/decisions/README.md`, `README.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Medium.

### Checkpoint: Editorial redesign

- [x] Full tests and syntax checks pass.
- [x] Desktop and narrow-screen visual QA confirms comfortable typography, clear project grouping, direct nesting, visible role identity, and aligned task data.
- [x] Reduced-motion and keyboard-focus behavior remain intact.
- [x] Commit the complete Phase 8 redesign and documentation with an explicit Conventional Commit message.

## Phase 9: Dense observability refinement

Phase 9 不再更换整体视觉语言，而是以可独立回退的设计决策逐步提升长期使用体验。每一项决策按 `AGENTS.md` 单独验证并提交，避免把字体、谱系、表格和交互密度混在同一轮修改中。

### Task 1: Establish the typography hierarchy

**Description:** Reassign serif, sans, and monospace by information role, remove 8–9px UI text, and reduce oversized editorial headings so dense monitoring remains readable without losing the Phase 8 identity.

**Acceptance criteria:**

- [x] Display serif is limited to entity/section titles; UI labels and semantic chips use system sans; machine values and identifiers use monospace.
- [x] Reusable typography tokens cover identifier, utility, label, body, data, and entity sizes.
- [x] `public/styles.css` contains no `8px` or `9px` font declarations.
- [x] Session and section headings are reduced to workstation-appropriate maximum sizes while token/USD/tabular alignment is preserved.
- [x] ADR-0010 records the long-lived typography contract.

**Verification:** `npm test`, `npm run check`, `git diff --check`, desktop browser check, narrow-screen browser check.

**Dependencies:** Phase 8.

**Files likely touched:** `public/styles.css`, `test/ui-security.test.js`, `docs/decisions/0010-typography-hierarchy.md`, `tasks/plan.md`, `tasks/todo.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Medium.

### Planned follow-up decisions

- [x] Reduce deep-lineage horizontal width loss without weakening parent/child readability. Desktop lineage depth now consumes 32px per level (`18px` rail offset + `14px` elbow) instead of 54px; narrow screens use 18px per level (`10px` + `8px`) while preserving the continuous rail and task-table overflow boundary.
- [x] Improve the task ledger with sticky context and clearer horizontal-scroll affordance. Task and Status remain pinned at `0px` / `160px`; after the later audit-presentation refinement the visible ledger is 13 columns / 1314px, omits the redundant reasoning display column, and centers every header/value pair while retaining reasoning in the underlying data contract.
- [x] Rebalance overview metrics into activity, token-flow, and cost information groups. The overview now uses three semantic ruled groups instead of seven equal-weight cells; cost is visually isolated without returning to rounded cards, and session USD shows the stored known amount without a lower-bound prefix while coverage text still discloses unavailable tasks.
- [x] Harmonize page and ledger scrollbars with the editorial palette. Vertical scroll regions use an 8px warm-taupe thumb; the task ledger uses an 8px muted-clay horizontal thumb, keeping discoverability without the heavier original treatment.
- [x] Add restrained interaction motion without adding a frontend dependency. Native details transitions animate project/date/agent expansion, View Transitions cover session and navigation state changes when supported, and reduced-motion remains authoritative.
- [ ] Define an agent expansion policy that avoids fully expanding large descendant trees by default.

## Phase 10: Calendar usage ledger and daily reconciliation

### Goals

- [x] Provide a complete local-date usage ledger across every discovered root session, including sessions that have not been opened in the dashboard.
- [x] Add a sidebar time view that expands from month to day to the contributing sessions while preserving the existing project view.
- [x] Make the daily total and its quality coverage explicit so it can be compared with the Codex profile without claiming identical billing semantics.

### Task 1: Build the all-session calendar aggregate

**Description:** Reuse `SessionRolloutParser` and the existing cumulative boundary-delta contract to parse all discovered sessions into an in-memory month/day/session aggregate. The aggregate uses the host local timezone for date keys and retains quality counts and partial totals.

**Acceptance criteria:**

- [x] Every discovered rollout is eligible for the calendar aggregate regardless of whether its session was selected first.
- [x] Usage is derived only from task boundary `deltaUsage` and `total_token_usage`, with `subagent_history_start_ordinal` and quality states preserved.
- [x] A deterministic fixture proves that an unselected session appears under the correct local day and its total is not double-counted.

**Verification:** `npm test -- --test-name-pattern "calendar aggregate"`, `npm run check`.

**Dependencies:** None.

**Files likely touched:** `src/monitor.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 2: Expose the authenticated timeline API

**Description:** Add a read-only authenticated endpoint returning ordered months, expandable days, session metadata, token totals, and quality coverage. Refresh the aggregate when rollout files change without changing the existing session snapshot or SSE contracts.

**Acceptance criteria:**

- [x] `GET /api/timeline` returns months descending, days descending within each month, and sessions descending by usage/date.
- [x] The payload contains input, cached input, output, reasoning, and total tokens plus complete/partial/estimated/discontinuity counts.
- [x] HTTP security tests cover authentication, method, and response shape.

**Verification:** `npm test -- --test-name-pattern "timeline API"`, `npm run check`.

**Dependencies:** Task 1.

**Files likely touched:** `src/server.js`, `src/monitor.js`, `test/database-server.test.js`, `docs/API.md`.

**Estimated scope:** Medium.

### Task 3: Add the month/day/session sidebar view

**Description:** Add a mode control to switch between project and time navigation. The time mode renders month details containing day details, each day showing its total and quality state, with session buttons selecting the existing dashboard session.

**Acceptance criteria:**

- [x] Project grouping remains unchanged and search filters both modes.
- [x] Time mode is keyboard-operable, defaults to the current month/day when present, and works on desktop and narrow-screen layouts without page-level horizontal overflow.
- [x] Labels distinguish audited token usage from account quota and do not imply Codex billing equivalence.

**Verification:** `npm test`, `npm run check`, `git diff --check`, desktop browser check, narrow-screen browser check.

**Dependencies:** Task 2.

**Files likely touched:** `public/index.html`, `public/app.js`, `public/styles.css`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 4: Record the reconciliation contract and local evidence

**Description:** Document the calendar grouping, local timezone, coverage states, and the observed 2026-08-24 total, including why it may differ from the profile total. Record the design decision and actual verification commands.

**Acceptance criteria:**

- [x] ADR, API docs, README, changelog, and verification evidence describe the new timeline behavior and its limitations.
- [x] The observed local rollout audit reports `170,393,639` total tokens for 2026-08-24 with one discontinuous task, and source files remain unchanged.
- [x] No documentation describes the daily total as Codex subscription billing or converts quota to tokens.

**Verification:** `npm test`, `npm run check`, `git diff --check`.

**Dependencies:** Tasks 1–3.

**Files likely touched:** `docs/decisions/0012-calendar-usage-ledger.md`, `docs/decisions/README.md`, `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Medium.

### Checkpoint: Calendar usage ledger

- [x] Full tests and syntax checks pass.
- [x] Timeline API includes all sessions and preserves quality coverage.
- [x] Desktop and narrow-screen browser checks confirm month/day/session navigation and existing project navigation.
- [x] Real-history total is reported with its exact date, timezone, quality counts, and source-hash check.

## Phase 11: Incremental calendar index and bounded SQLite memory

### Goals

- [x] Replace the all-history Timeline replay with a durable SQLite-derived calendar index so opening the time view does not reread the full rollout archive.
- [x] Reuse persisted parser cursors so historical sessions are imported once and later refreshes process only new or invalidated rollout bytes.
- [x] Keep SQLite memory bounded and make WAL growth observable/controlled without weakening the read-only `.codex` boundary.

### Task 1: Persist normalized task usage and session-day aggregates

**Description:** Advance the SQLite schema with normalized integer task-usage columns plus a compact `session_day_usage` materialized aggregate keyed by local date and root session. Rebuild a session's affected calendar rows transactionally whenever its derived task ledger is persisted.

**Acceptance criteria:**

- [x] Existing databases migrate without losing sessions, tasks, cursors, quota snapshots, or source-locator metadata.
- [x] Six normalized usage counters preserve `NULL` when no precise task delta exists, while `session_day_usage` preserves task counts, active counts, six token totals, and all quality counters.
- [x] Calendar rows contain no prompt/response text and can be rebuilt solely from derived task metadata.

**Verification:** `npm test -- --test-name-pattern "calendar index|schema v7"`, `npm run check`.

**Dependencies:** Phase 10.

**Files likely touched:** `src/database.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 2: Incrementally synchronize all sessions before Timeline queries

**Description:** Replace `buildTimeline()` full replay with cursor-aware session synchronization. Imported sessions restore their persisted task/cursor state and tail only changed bytes; never-imported or invalidated threads replay once. The timeline itself is then materialized from SQLite calendar rows.

**Acceptance criteria:**

- [x] A second Timeline request with unchanged rollouts performs no rollout replay and returns the same aggregate.
- [x] Appending to one rollout updates only that root session's derived ledger/calendar rows; unrelated sessions are not replayed.
- [x] A source file shrink, stale cursor, or missing durable task state falls back to the parser's existing safe replay path rather than trusting stale data.

**Verification:** `npm test -- --test-name-pattern "incremental timeline|calendar aggregate"`, `npm run check`.

**Dependencies:** Task 1.

**Files likely touched:** `src/monitor.js`, `src/database.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 3: Bound SQLite cache/WAL behavior and measure the hot path

**Description:** Explicitly configure a small SQLite page cache, enable incremental auto-checkpointing appropriate for this local workload, and expose enough storage diagnostics to verify that the timeline hot path stays SQL-bound instead of rollout-bound.

**Acceptance criteria:**

- [x] SQLite page cache remains approximately 2 MiB and mmap is not expanded implicitly for this workload.
- [x] WAL auto-checkpointing prevents unbounded steady-state WAL growth while preserving current transaction semantics.
- [x] Verification records database size, calendar-index size, Timeline cold migration cost, subsequent hot-query latency, and process RSS delta on the real local dataset.

**Verification:** `npm test`, `npm run check`, `git diff --check`, local performance harness.

**Dependencies:** Tasks 1–2.

**Files likely touched:** `src/database.js`, `docs/VERIFICATION.md`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 4: Supersede the full-replay calendar decision

**Description:** Record that ADR-0012's user-facing local-date semantics remain, but its in-memory full-history rebuild/cache strategy is superseded by a durable derived calendar index with cursor-aware synchronization.

**Acceptance criteria:**

- [x] A new ADR documents the performance evidence, schema choice, invalidation model, memory bounds, and fallback replay semantics.
- [x] Architecture/API/README/changelog documentation no longer claims that every Timeline cache invalidation rereads all rollout files.
- [x] Documentation retains the distinction between audited local deltas and Codex subscription/billing semantics.

**Verification:** `npm test`, `npm run check`, `git diff --check`.

**Dependencies:** Tasks 1–3.

**Files likely touched:** `docs/decisions/0012-calendar-usage-ledger.md`, `docs/decisions/0013-incremental-calendar-index.md`, `docs/decisions/README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Medium.

### Checkpoint: Incremental calendar index

- [x] Full tests and syntax checks pass.
- [x] First migration/backfill is one-time; unchanged subsequent Timeline requests do not scan rollout history.
- [x] Real-history hot Timeline latency and additional RSS are materially below the Phase 10 full-replay baseline (~16–24 s and ~156 MiB additional RSS).
- [x] SQLite main/WAL sizes and page-cache settings are recorded after the migration.

## Phase 12: Windows portable storage and source rebinding

### Goals

- [x] Make persisted rollout identity independent from Windows usernames, drive letters, and the current `.codex` absolute location.
- [x] Keep the monitor SQLite database project-local by default while allowing the project directory itself to move across Windows drives.
- [x] Rebind an existing database to the current user's `.codex` tree without replaying unchanged rollout history solely because the machine path changed.
- [x] Fail safely when a stored locator cannot be rebound, and preserve the existing read-only `.codex` security boundary.

### Task 1: Introduce a portable Codex source-locator seam

**Description:** Add one source-locator module that converts runtime absolute rollout paths to canonical `.codex`-relative source keys and resolves those keys against the currently selected Codex home. Repository entries carry both forms, but only source keys are eligible for durable identity.

**Acceptance criteria:**

- [x] `sessions/...` and `archived_sessions/...` source keys use stable `/` separators and reject traversal/out-of-root paths.
- [x] Legacy Windows absolute rollout paths can recover a source key even when their old username or drive no longer exists.
- [x] Repository runtime reads continue to use canonical absolute paths under the current Codex home.

**Verification:** `npm test -- --test-name-pattern "portable source|source key"`, `npm run check`.

**Dependencies:** Phase 11.

**Files likely touched:** `src/source-locator.js`, `src/repository.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 2: Migrate schema v8 away from absolute rollout identities

**Description:** Replace path-keyed ingest cursors with `source_key` identity and add portable source-key columns for sessions, agents, tasks, and quota snapshots. The migration derives keys from legacy `.codex` paths, clears machine-bound rollout locators, and drops only locator rows that cannot be converted safely.

**Acceptance criteria:**

- [x] `ingest_cursors` is keyed by `source_key`, not an absolute filesystem path.
- [x] Existing v7 task/calendar/usage data survives migration; convertible legacy rollout/task/quota paths become source keys and absolute `.codex` locator columns are cleared.
- [x] Quota payload JSON no longer persists an absolute rollout path.

**Verification:** `npm test -- --test-name-pattern "schema v8|portable migration"`, `npm run check`.

**Dependencies:** Task 1.

**Files likely touched:** `src/database.js`, `src/rollout-parser.js`, `test/database-server.test.js`, `test/parser.test.js`.

**Estimated scope:** Medium.

### Task 3: Rebind startup, cursor restore, and task preview to the current Codex home

**Description:** Detect the current Windows Codex home from explicit configuration or the current user profile, tolerate a stale configured path by falling back to the standard current-user location, and make cursor restore plus on-demand task preview resolve source keys through the active repository.

**Acceptance criteria:**

- [x] Moving the same `.codex` tree and monitor database to a different absolute root resumes unchanged cursors without replay caused only by path inequality.
- [x] A task preview still opens the current rollout after `.codex` rebinding and never trusts a stale persisted absolute path.
- [x] The default database remains `<project>/data/usage.sqlite` regardless of process working directory or project drive.

**Verification:** `npm test -- --test-name-pattern "rebind|relocat|preview"`, `npm run check`.

**Dependencies:** Tasks 1–2.

**Files likely touched:** `src/server.js`, `src/monitor.js`, `src/repository.js`, `src/rollout-parser.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 4: Record portability contract and migration evidence

**Description:** Add an accepted ADR and operational documentation describing project-local storage, source-key rebinding, Windows-only scope, safe fallback/replay behavior, and the distinction between historical project CWD metadata and active rollout locators.

**Acceptance criteria:**

- [x] README/architecture/operations document moving the project + SQLite + `.codex` between Windows users or drives.
- [x] ADR records why relative source keys are durable identity while absolute paths remain runtime-only locators.
- [x] Full verification and `git diff --check` pass before the portability feature commit.

**Verification:** `npm test`, `npm run check`, `git diff --check`.

**Dependencies:** Tasks 1–3.

**Files likely touched:** `docs/decisions/0014-portable-source-locators.md`, `docs/decisions/README.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Medium.

### Checkpoint: Windows portability

- [x] Full tests, syntax checks, and diff checks pass.
- [x] A relocation regression proves source-key cursor reuse across different absolute `.codex` roots.
- [x] A legacy v7 migration regression proves absolute rollout locators are removed without losing derived usage/calendar data.
- [x] The final Git commit contains only the reviewed portability slice.

## Phase 13: Verified Request Ledger and dual-ledger reconciliation

### Evidence baseline

2026-08-26 的只读历史实验扫描 `412` 个 rollout / `42,159` 条 `token_count`。兼容历史 schema 后，`1,726` 条累计值不变的事件可明确分类为 duplicate，`40,388` 个新增 usage 单元可由 `total_token_usage` 的逐字段增量验证，已有前序累计值的增长事件未观察到真实 `Δtotal != last` 异常；另有 `45` 条文件首记录仅凭单文件无法证明。实验 Request Ledger 对 2026-08-22 / 08-23 / 08-24 得到 `60,289,305` / `64,066,930` / `175,486,562`，与此前人工 generation-reset recovery 结果一致。

### Goals

- [x] 把“经累计快照验证的新增模型 usage”建模为一等审计事件，同时保留现有 Task Boundary Ledger 作为迁移期独立校验器。
- [x] 用 `total_token_usage` 做 cumulative verifier / deduplicator / generation detector，而不是继续依赖跨任务永远单调的假设。
- [x] 可靠处理 duplicate broadcast、generation reset、missing baseline、历史缺字段和跨 rollout 文件 continuation，不裸累加 `last_token_usage`。
- [x] 在没有损失审计质量的前提下，从 Request Ledger 聚合 Task / Agent / Session / Day，并提供模型请求数、tokens/request 等后续指标的数据基础。
- [x] 保持 Profile / 订阅额度与本地可审计 usage 分离；不得通过补偿系数追平 Profile。

### Task 1: Freeze the verified usage-event classifier

**Description:** 在独立分类层规范化 `total_token_usage` / `last_token_usage`，逐字段判断新增 usage、重复广播、generation 起点和无法证明的记录。历史记录缺少 `cache_write_input_tokens` 时仅跳过该缺失字段的一致性断言，不把兼容缺字段误判为 anomaly。

**Acceptance criteria:**

- [x] `current.total == previous.total` 分类为 `duplicate`，不产生新增 usage。
- [x] 所有可比较字段满足 `current.total - previous.total == current.last` 时分类为 `verified_increment`。
- [x] 累计值回退且新快照满足可证明的新 generation 条件时分类为 `generation_start`，不再把已解释 rollback 计入 parser discontinuity counter；旧 Task Boundary Ledger 若跨 generation 仍会独立保持 `discontinuity`，直到 Task 4/5 完成双账本切换。
- [x] 无法建立可证明 baseline、`total=0 && last>0`、字段矛盾或无法解释的 rollback 保持 `unverified/anomaly`，不得猜测计量；`total == last` 可证明零 baseline 时允许分类为 `generation_start`。
- [x] 全历史只读回归复现原 `412 / 1,726 / 40,388 / 45` 核心分类基线；当前总 `token_count` 已增至 `42,183`，新增 24 条全部是缺少 `total_token_usage` 的 `unverified`，未改变 verified/duplicate/原 missing-baseline 计数，源 SHA-256 全部不变。

**Verification:** parser fixture tests, read-only historical classifier harness, `npm run check`, source SHA-256 comparison.

**Dependencies:** Phase 12.

**Files likely touched:** `src/usage.js`, `src/rollout-parser.js`, `test/parser.test.js`, optional read-only verification harness under `test/` or `scripts/` if repository conventions permit.

**Estimated scope:** Medium.

### Task 2: Persist a privacy-safe model usage event ledger

**Description:** Advance SQLite with a compact request-level derived ledger (recommended internal name `model_usage_events`) containing stable source identity, thread/turn attribution when known, event ordinal/timestamp, normalized usage fields, generation/classification and quality. Do not persist prompt/response/tool content. The durable identity must use portable `source_key`, not absolute paths.

**Acceptance criteria:**

- [x] Duplicate replay / cursor restore is idempotent and cannot insert the same usage event twice; durable identity is `(source_key, line_number)` and session replacement rebuilds the same deterministic event set.
- [x] Stored events contain only derived usage and locator metadata permitted by existing privacy rules; schema tests reject prompt/content/message and absolute source-path columns.
- [x] Existing schema v8 task/calendar data migrates without loss; v8 sessions remain `requestLedgerReady=false` until one safe replay backfills the ledger, after which normal cursor restore resumes without repeat replay.
- [x] Database size and migration/backfill cost are measured on the real local history before accepting the schema: 412 rollout / 42,183 events backfill in about 22.7 s to a temporary ~31.4 MB SQLite database with the existing ~2 MiB page-cache bound.

**Verification:** schema migration tests, replay/idempotency tests, `npm test`, `npm run check`, database-size measurement.

**Dependencies:** Task 1.

**Files likely touched:** `src/database.js`, `src/rollout-parser.js`, `test/database-server.test.js`, `test/parser.test.js`.

**Estimated scope:** Large.

### Task 3: Preserve usage continuity across rollout files and generations

**Description:** Carry the latest verified cumulative state by `thread_id` across portable rollout source keys so a new file does not automatically create an unverifiable first event. Explicit generation changes remain visible in the ledger; file boundaries and generation boundaries are separate concepts.

**Acceptance criteria:**

- [x] A continuation file whose first cumulative snapshot can be validated against the prior file produces the correct new usage exactly once.
- [x] `total == last` at a validated generation start may establish a zero baseline; `total=0 && last>0` remains unverified unless other evidence proves it.
- [x] The historical file-first special cases do not cause double counting when files are replayed, reordered by discovery, or restored from cursors.
- [x] Truncation/shrink/stale cursor falls back to the existing safe replay path and rebuilds request-derived state deterministically.

**Verification:** multi-file fixtures, cursor restore/tail tests, historical first-event sample replay, `npm test`, `npm run check`.

**Dependencies:** Tasks 1–2.

**Files likely touched:** `src/rollout-parser.js`, `src/monitor.js`, `src/database.js`, `test/parser.test.js`, `test/database-server.test.js`.

**Estimated scope:** Large.

**Delivered evidence (2026-08-26):** Same-thread multi-file fixtures prove chronological replay even when discovery order is reversed, cursor restore preserves the terminal cumulative baseline, only the terminal source may be tailed incrementally, growth in a non-terminal source invalidates the entire thread cursor chain, and a newly discovered older source requests deterministic rebuild instead of consuming a future baseline. A real-history temporary backfill still produces 42,183 events with 40,389 verified / 1,726 duplicate / 68 unverified / 0 anomaly, confirming the one additional cross-file verified event observed after Task 2 without introducing extra historical anomalies.

### Task 4: Run both ledgers and produce a reconciliation report

**Description:** During the migration period, derive per-task usage independently from Request Ledger and the existing boundary-delta algorithm. Expose an internal/test reconciliation report that explains matches and differences by quality instead of silently preferring one result.

**Acceptance criteria:**

- [x] Every task currently classified `complete` must satisfy exact per-field equality between `Σ verified request usage` and existing `deltaUsage`, unless a documented schema limitation makes a field unavailable.
- [x] Known 2026-08-22 and 2026-08-24 reset cases are recovered by Request Ledger without manual special-case IDs.
- [x] 2026-08-22 / 08-23 / 08-24 day totals reproduce `60,289,305` / `64,066,930` / `175,486,562` for the audited historical snapshot.
- [x] Duplicate broadcasts add exactly zero usage; unverified events are counted in coverage/quality metrics but do not silently enter precise totals.
- [x] Reconciliation output distinguishes local parser differences from Profile differences and never treats Profile as a test oracle.

**Verification:** full-history reconciliation harness, targeted parser/database tests, `npm test`, `npm run check`, `git diff --check`, source-hash verification.

**Dependencies:** Tasks 1–3.

**Files likely touched:** `src/usage.js`, `src/rollout-parser.js`, `src/database.js`, `src/monitor.js`, tests, `docs/VERIFICATION.md`.

**Estimated scope:** Large.

**Delivered evidence (2026-08-26):** `npm run reconcile:request-ledger` replays the current 412 rollout / 267 session history into a temporary schema v9 database and compares both ledgers. After fixing a migration-audit bug where a proven generation reset had stopped marking the old boundary task as `discontinuity`, all 1,335 currently complete tasks reconcile with exact per-field equality (`mismatch=0`). Four discontinuity tasks are independently recoverable from verified request events. The historical 2026-08-22 / 08-23 / 08-24 totals reproduce exactly, duplicate events remain excluded, 68 unverified events remain coverage-only, and the separate read-only classifier audit reports `hashChangedFiles=0`.

### Task 5: Promote Request Ledger only after migration gates pass

**Description:** Once dual-ledger equality and incremental behavior are proven, switch Task / Agent / Session / Timeline aggregation to verified request events. Retain the old boundary ledger for at least the migration release as a reconciliation/checking path, then decide separately whether it can be retired.

**Acceptance criteria:**

- [x] Session dashboard and Timeline preserve existing API semantics unless an ADR explicitly versions the contract.
- [x] Task totals, cost estimates and cache-hit calculations consume the same normalized request-derived token fields without double-counting reasoning or cached input.
- [x] Model request count and tokens/request may be exposed only from verified usage events; documentation states that these are model-usage units and not guaranteed one-to-one HTTP requests.
- [x] Incremental tail, restart restore, full replay and calendar materialization return identical totals for the same rollout state.
- [x] A new ADR supersedes the relevant part of ADR-0002 while preserving the prohibition on naked `last_token_usage` summation and the separation from Codex Profile/billing semantics.

**Verification:** `npm test`, `npm run check`, `git diff --check`, real-history reconciliation, restart/tail/browser regression if UI metrics change.

**Dependencies:** Task 4.

**Files likely touched:** `src/usage.js`, `src/rollout-parser.js`, `src/database.js`, `src/monitor.js`, `public/**` only if request metrics are surfaced, `docs/decisions/0015-*.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md`, `CHANGELOG.md`, `docs/VERIFICATION.md`.

**Estimated scope:** Large.

**Delivered evidence (2026-08-26):** schema v10 materializes Task / Agent / Session / Timeline usage from verified Request Ledger events while retaining `tasks.delta_usage/quality` as untouched Boundary Ledger evidence. Targeted tests prove request-derived cost/usage, verified-unit counts, partial lower-bound behavior, restart/tail identity and v9→v10 aggregate promotion without rollout replay. Full-history schema v10 reconciliation remains `1,335 exact / 0 mismatch / 4 recovered`, and the primary Timeline reproduces 2026-08-22 / 08-23 / 08-24 as `60,289,305 / 64,066,930 / 175,486,562` with `636 / 550 / 1,439` verified model usage units respectively. ADR-0015 records the promotion and preserves the prohibition on naked `last_token_usage` summation and Profile calibration.

### Checkpoint: Request Ledger migration

- [x] Classifier has no unexplained mismatch on the audited historical dataset; any new anomaly is retained and documented, not force-classified.
- [x] Complete-task dual-ledger reconciliation is exact per field.
- [x] Known reset/missing-baseline recoveries are reproduced without session/turn-specific hacks.
- [x] SQLite migration, incremental tail and restart recovery are idempotent and bounded.
- [x] Request Ledger becomes the primary aggregation source only after the above gates pass and the ADR is accepted.

## Phase 14: Retire the Boundary Ledger

**Goal:** 迁移门槛已经通过后，删除旧 Boundary Ledger 的运行时、SQLite、API 和 CLI 维护面，只在 Git 历史保留可复核基线，使 Request Ledger 成为唯一统计实现。

### Task 1: Preserve the historical baseline before removal

- [x] 在旧主方案仍可独立运行的 commit `4a38ba6` 创建 annotated tag `usage-boundary-ledger-v1`。
- [x] tag 注释明确其为 Request Ledger promotion 前的 Historical Boundary Ledger aggregation baseline。
- [x] 不通过 reset/rewrite 删除旧实现历史；ADR-0002 和 Phase 13 reconciliation 证据继续保留。

### Task 2: Remove Boundary Ledger from the current runtime

- [x] parser 不再维护 task baseline/end/boundary delta、Boundary task quality 或 generation-reset task discontinuity 状态。
- [x] `src/reconciliation.js` 和 `npm run reconcile:request-ledger` 删除；Request-only 聚合移动到 `src/request-ledger.js`。
- [x] API 不再暴露 `boundaryDeltaUsage` / `boundaryQuality`；UI 质量语义收敛到 `complete/provisional/partial/unknown`。
- [x] Request Ledger 的相邻累计验证、cursor `last_usage`、unverified/anomaly coverage 和 parser health 诊断继续保留。

### Task 3: Retire Boundary persistence with schema v11

- [x] `tasks` 删除 `quality`、baseline/end、`delta_usage` 和所有 `delta_*` token 列，只保存任务身份/定位/展示元数据。
- [x] `session_day_usage` 删除 Boundary 专属 `estimated_count` / `discontinuity_count`。
- [x] v10→v11 迁移在 SQLite 内重建旧表，并从已有 Request Ledger 重算 Agent/Calendar aggregate。
- [x] Request-ready v10 session 升级时 `replayedFiles=0`，不因退役旧方案重读 rollout。

### Task 4: Record and verify the single-ledger architecture

- [x] ADR-0016 接替 ADR-0002 的运行时角色，并结束 ADR-0015 的 Boundary 迁移保留条款。
- [x] README / API / Architecture / Delivery / Changelog / AGENTS 与任务文档只把 Request Ledger 描述为当前统计事实源。
- [x] 定向 parser/database/request-ledger tests 通过；完整测试和 syntax checks 在最终提交前再次执行。
- [x] 对真实历史执行 read-only Request Ledger audit/benchmark，并记录 schema v11 最终证据。
- [x] 删除完成、全量验证通过并提交后，在新 commit 创建 annotated tag `usage-request-ledger-v1`。

**Verification:** `npm test`, `npm run check`, `npm run audit:request-ledger`, `npm run benchmark:request-ledger`, `git diff --check`, schema v10→v11 no-replay regression, final tag/status inspection.

## Phase 15: Preserve interaction state during live updates

### Goals

- [x] Real-time SSE snapshots must not recreate an existing task table or agent `<details>` node when only values change.
- [x] Horizontal task-table scroll, agent expansion state, focusable container identity, and the user's visible vertical anchor remain stable while token/cost/status values update.
- [x] The left session navigator must not be destructively re-rendered for routine selected-session snapshots.
- [x] Structural additions/removals use stable session/agent/task IDs and preserve the user's current visual reading position.

### Task 1: Incrementally reconcile the agent/task ledger

**Description:** Replace `agent-tree.innerHTML = ...` snapshot rendering with keyed reconciliation using `threadId` for agents and `turnId` for tasks. Existing agent branches, `<details>` elements and `.task-table-wrap` containers remain mounted; value cells and structural children are patched in place.

**Acceptance criteria:**

- [x] Existing `.task-table-wrap` elements survive ordinary token/status/cost updates, preserving `scrollLeft` and keyboard focus.
- [x] Existing agent `<details>` open/closed state is not overwritten by subsequent snapshots.
- [x] New/removed/reordered agents or tasks are inserted, removed or moved by stable key rather than rebuilding the whole lineage tree.

**Verification:** `npm test -- --test-name-pattern "static UI|live update"`, `npm run check`, `git diff --check`, browser scroll/expand regression.

**Dependencies:** ADR-0005, ADR-0006, ADR-0011.

**Files likely touched:** `public/app.js`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 2: Preserve the visible anchor for structural live changes

**Description:** Capture the first visible stable agent/task key before structural reconciliation and restore its viewport offset after insertion/removal, so content added above the reader does not move the current reading target.

**Acceptance criteria:**

- [x] Value-only updates do not perform page-scroll correction.
- [x] Structural changes restore the same surviving visible agent/task to its pre-update viewport offset.
- [x] If the anchor itself disappears, reconciliation completes safely without forced scrolling.

**Verification:** `npm test -- --test-name-pattern "static UI|live update"`, `npm run check`, browser structural-update regression.

**Dependencies:** Task 1.

**Files likely touched:** `public/app.js`, `test/ui-security.test.js`.

**Estimated scope:** Small.

### Task 3: Stop selected-session snapshots from rebuilding navigation

**Description:** Decouple selected-session summary refreshes from `renderSessions()`. Patch the currently rendered project-session item in place when its title/update time/agent count changes; only deliberate navigation-mode/search rebuilds or a grouping-key change may rebuild the list.

**Acceptance criteria:**

- [x] Routine SSE snapshots do not replace `#session-list` descendants.
- [x] Project-view session metadata visible in the sidebar still refreshes in place.
- [x] Session selection toggles active state without resetting project/month/day `<details>` state or navigator scroll position.

**Verification:** `npm test -- --test-name-pattern "static UI|live update"`, `npm run check`, browser sidebar-state regression.

**Dependencies:** Task 1.

**Files likely touched:** `public/app.js`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 4: Record the live-interaction rendering contract

**Description:** Add ADR-0017 defining stable DOM identity as the live-rendering invariant, documenting why refresh throttling or scroll-position restoration alone are insufficient, and update the decision index/task checklist with delivered verification evidence.

**Acceptance criteria:**

- [x] ADR-0017 records value updates versus structural updates, stable keys, visual anchoring, and rejected alternatives.
- [x] `docs/decisions/README.md`, `tasks/plan.md`, and `tasks/todo.md` match the implementation state.
- [x] Each independently verifiable frontend interaction slice is committed according to the repository Git rules.

**Verification:** `npm test`, `npm run check`, `git diff --check`, `git status --short`.

**Dependencies:** Tasks 1-3.

**Files likely touched:** `docs/decisions/0017-live-interaction-stable-rendering.md`, `docs/decisions/README.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Small.

### Checkpoint: Live interaction stability

- [x] Full tests, syntax checks, and diff checks pass.
- [x] Horizontal task-table scroll remains unchanged through repeated selected-session snapshots.
- [x] Manually collapsed/expanded agent and sidebar groups stay unchanged through live updates.
- [x] Structural additions above the viewport do not displace the surviving visible anchor.

**Delivered evidence (2026-08-26):** `npm test` reports 52 tests / 51 passed / 0 failed / 1 skipped; the skipped test is the optional real five-task fixture because `CODEX_MONITOR_REAL_FIXTURE` was not configured. `npm run check` and `git diff --check` pass. The Chrome/CDP `verify:live-ui` harness replays the page's real snapshot callback without writing rollout data: an existing task table remains the same DOM with `scrollLeft=354`, focus remains on `.task-table-wrap`, manually collapsed Agent state remains collapsed, and a synthetic task insertion above the visible row causes a 66px scroll compensation while the surviving row's viewport top delta remains exactly 0px.

## Phase 16: Day-scoped Request Ledger snapshots

### Goal

把“工程”与“时间”两种导航正式定义为不同 snapshot scope：工程模式继续展示完整 session；时间模式以 `(sessionId, local day)` 为选择身份，Task / Agent / Session / Cost 全部只统计该本地自然日。token 日归属从 task `startedAt` 更新为 verified Request Ledger event `observedAt`。

**设计事实源：** [`docs/DESIGN-DAY-SCOPED-SNAPSHOT.md`](../docs/DESIGN-DAY-SCOPED-SNAPSHOT.md)

**测试门槛：** [`docs/TEST-DAY-SCOPED-SNAPSHOT.md`](../docs/TEST-DAY-SCOPED-SNAPSHOT.md)
**ADR：** [`ADR-0018`](../docs/decisions/0018-day-scoped-request-ledger-snapshot.md)

### Task 1: Build the day-slice domain seam and schema v12 calendar semantics

**Description:** 建立唯一的本地日期边界与 Task Day Slice 物化语义；`session_day_usage` 改为按 Request Ledger `observedAt` 分日，并通过 schema v12 从已持久化 Request Ledger 重建，避免为语义迁移重放 rollout。

**Acceptance criteria:**

- [x] 跨午夜 verified usage 按本地 event day 分桶，六字段 `day1 + day2 == full`。
- [x] Task 生命周期跨日或当天存在归属 event 时形成 Task Day Slice；usage/request/coverage/quality 按日裁剪，身份/原始时间不伪造。
- [x] v11 -> v12 calendar rebuild 对 Request-ready session `replayedFiles=0`，并建立 `(root_session_id, observed_at, classification)` 查询索引。

**Verification:** TEST-DAY-SCOPED-SNAPSHOT T-DAY-001~043，`npm test`, `npm run check`, `git diff --check`。

**Dependencies:** ADR-0016 Request-only architecture, ADR-0018.

**Files likely touched:** `src/request-ledger.js`, `src/database.js`, `test/request-ledger.test.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 2: Materialize scoped Agent and Session snapshots

**Description:** 让 monitor 通过统一 scope interface 生成 full-session 或 day-scoped snapshot。day scope 从 Task Day Slice 重建 Agent own/subtree usage、request、cost 和 Session summary，不复用完整 session aggregate。

**Acceptance criteria:**

- [x] `snapshot(sessionId, session-scope)` 保持现有完整 session 数值。
- [x] `snapshot(sessionId, day-scope)` 的 task/agent/summary/request/cost 均只来自当天。
- [x] 当日无关 Agent 被省略，必要祖先保留；Timeline 与 day snapshot 对同一 `session + day` 对账一致。

**Verification:** T-DAY-020~054，`npm test`, `npm run check`。

**Dependencies:** Task 1.

**Files likely touched:** `src/request-ledger.js`, `src/database.js`, `src/monitor.js`, `test/database-server.test.js`, `test/pricing.test.js`.

**Estimated scope:** Medium.

### Task 3: Expose day-scoped HTTP and SSE contracts

**Description:** 在现有 session snapshot / SSE endpoint 上增加严格校验的 `?day=YYYY-MM-DD` scope，并确保每个 SSE listener 后续更新持续使用其原始 scope。

**Acceptance criteria:**

- [x] 无 `day` 的 endpoint 行为兼容；合法 day 返回显式 scope metadata；非法 day 返回 400。
- [x] 同一 session 的两个日期请求可连续得到独立 snapshot，不发生 cache/scope 串线。
- [x] day-scoped SSE 不接收其他日期 usage；full-session snapshot 继续得到完整总量。

**Verification:** T-DAY-050~062，`npm test`, `npm run check`。

**Dependencies:** Task 2.

**Files likely touched:** `src/server.js`, `src/monitor.js`, `test/database-server.test.js`.

**Estimated scope:** Medium.

### Task 4: Make time-view selection identity `(sessionId, day)`

**Description:** 前端为时间模式保存 `selectedDay`，按二元组标记 active、发起 snapshot/SSE 请求并处理模式切换；同一 session 在多个日期可分别选择，同时继续遵守 ADR-0017 的稳定交互契约。

**Acceptance criteria:**

- [x] 时间按钮携带 id/day；点击同一 session 的另一日期会重新请求对应 day scope。
- [x] Project -> Time 和 Time -> Project 都会切换正确 snapshot scope，不出现“时间导航 + 完整详情”。
- [x] scoped live updates 不重置 session navigator、task-table horizontal scroll、Agent 展开状态或 visible anchor。

**Verification:** T-DAY-070~073，静态 UI tests，desktop + narrow browser E2E，`npm test`, `npm run check`, `git diff --check`。

**Dependencies:** Task 3, ADR-0017.

**Files likely touched:** `public/app.js`, `public/index.html`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 5: Execute the implementation gate and close delivery

**Description:** 严格执行 `docs/TEST-DAY-SCOPED-SNAPSHOT.md`。任何失败都先回到设计/ADR 分类原因；默认修实现，不通过削弱断言来掩盖设计偏差。最终把实际证据写入 Verification/Delivery/API/Architecture 等当前行为文档。

**Acceptance criteria:**

- [x] T-DAY-001~082 中适用测试全部通过；未配置真实 fixture 的项明确 skipped。
- [x] `npm test`, `npm run check`, `git diff --check` 和 desktop/narrow E2E 全部通过。
- [x] `docs/VERIFICATION.md` 记录 day1/day2/full 六字段对账、Timeline/detail 对账、SSE scope、schema v12 no-replay 证据；Delivery 从“设计已批准”改为“已交付”。

**Verification:** 按 TEST-DAY-SCOPED-SNAPSHOT 第 13~15 节执行。

**Dependencies:** Tasks 1-4.

**Files likely touched:** `docs/VERIFICATION.md`, `docs/DELIVERY.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Medium.

### Checkpoint: Day-scoped snapshot delivered

- [x] 业务需求、数据边界、日期语义和 scope interface 已冻结。
- [x] ADR-0018 已记录为什么从 task-start day 切换为 event-observed day。
- [x] 测试方案已规定跨午夜、迁移、API/SSE、前端二元选择和失败回退流程。
- [x] 开发前已再次阅读 DESIGN + TEST + ADR-0018，并按测试失败回退流程完成实现、迁移与浏览器验收。

**Delivered evidence (2026-08-26):** deterministic T-DAY fixtures validate `full/day1/day2 = 300/100/200`, six-field conservation, DST 23h/25h boundaries, Timeline/detail cost parity, lifecycle-less event-backed task no-double-count, v11→v12 `replayedFiles=0`, invalid-day 400 and scoped SSE isolation. Full `npm test` reports 62 tests / 61 passed / 0 failed / 1 optional real-fixture skip; `npm run check` and `git diff --check` pass. Chrome/CDP verifies a real same-session `2026-08-27 -> 2026-08-26` Time switch, Project full-scope restoration, desktop stable-key/visual-anchor behavior, and 720px narrow horizontal-scroll/focus/Agent-state preservation.

## Phase 17: Subscription Standard-Rate Cost / Request-level Pricing

### Overview

把现有 Task-level “current API short-context equivalent” 重构为 **Subscription Standard-Rate Equivalent**。Request Ledger 的 token classification/usage 保持不变；Pricing 以单个 verified model-usage unit 为基础，按 `model + observedAt + event-level service tier + feature evidence` 选择历史标准价和 multiplier，再向 Task / Agent / Session / Day / Timeline 汇总。

设计事实源：

- [`docs/DESIGN-SUBSCRIPTION-STANDARD-COST.md`](../docs/DESIGN-SUBSCRIPTION-STANDARD-COST.md)
- [`docs/TEST-SUBSCRIPTION-STANDARD-COST.md`](../docs/TEST-SUBSCRIPTION-STANDARD-COST.md)
- [ADR-0019](../docs/decisions/0019-request-level-subscription-standard-cost.md)

### Architecture decisions

- Token Ledger 与 Pricing Ledger 分离；费用重构不得改变 verified token 数。
- Historical Rate Catalog 按有效期选价，禁止今天的价格回算全部历史。
- Sol 临时 token-based USD 促销不切换 subscription-standard policy；Terra/Luna 2026-07-30 是付费订阅 usage 的历史切价点。
- Long context 必须逐 usage unit/request evidence 判断 `input >272K`，不能看 Task aggregate。
- Fast 使用 event 当时有效 `service_tier`；`priority` 与 `fast` 统一为 Fast。
- 当前官方不支持 Fast + long context，冲突时不得叠乘。
- subscription-standard policy 不直接沿用 API cache-write 1.25× surcharge。

### Task 1: Freeze pricing policy, historical catalog, and test gate

**Description:** 把用户确认的订阅标准价等值、历史价、历史模型、长上下文、Fast、cache-write 和 coverage 语义写成实现前事实源，并建立失败回退测试门槛。

**Acceptance criteria:**

- [x] DESIGN 明确 Request-level pricing、historical resolver、272K 边界和 service-tier evidence。
- [x] TEST 定义 `T-COST-001~083` 的单元/迁移/聚合/真实历史验收。
- [x] ADR-0019 记录为什么不继续使用 Task-level API-equivalent estimator。

**Verification:** `git diff --check`；人工核对 DESIGN / TEST / ADR / Delivery 之间术语、边界和官方来源一致。

**Dependencies:** Phase 16 已交付的 Request Ledger + event-observed day scope。

**Files likely touched:** `docs/DESIGN-SUBSCRIPTION-STANDARD-COST.md`, `docs/TEST-SUBSCRIPTION-STANDARD-COST.md`, `docs/decisions/0019-request-level-subscription-standard-cost.md`, `docs/DELIVERY.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Small.

### Task 2: Implement historical catalog and request-cost engine

**Description:** 用不可变有效期目录替代单张当前 rate card，并建立只消费单个 verified Request Ledger usage unit 的 request-cost engine。先实现普通订阅标准价、历史模型/价格和 coverage，再启用 feature policy。

**Acceptance criteria:**

- [ ] `model + observedAt` 唯一选择历史 rate；gap/overlap/unknown model 显式失败。
- [ ] Sol promotion exclusion、Terra/Luna 7/30 切价、GPT-5.5/GPT-5.4 历史 fixture 固定通过。
- [ ] 普通 request cost 正确处理 cached input、reasoning 和 subscription-policy cache-write，不双算。

**Verification:** `T-COST-001~013`；`npm test -- --test-name-pattern="T-COST|cost|pricing"`（实现时按实际测试框架调整精确过滤命令）。

**Dependencies:** Task 1.

**Files likely touched:** `src/pricing.js`, `test/pricing.test.js`，必要时新增只读 catalog module/data file。

**Estimated scope:** Medium.

### Task 3: Prove long-context boundary and persist event pricing context

**Description:** 在不改 Token Ledger 数值的前提下，验证 `last_token_usage`/verified usage unit 是否满足 272K billing-request threshold 的证据门槛；同时按 ordinal 采集 event model/service tier，必要时升级 schema v13 并为已有历史执行只读 metadata enrichment。

**Acceptance criteria:**

- [ ] request-boundary evidence gate 有明确 pass/fail 证据；未通过时只能输出 candidate/partial。
- [ ] `272000` normal / `272001` long、mixed-request Task、Task aggregate false-positive fixtures 全部通过。
- [ ] event model/service tier as-of ordinal 可持久化；v12→v13 前后六字段 usage/classification 完全不变。

**Verification:** `T-COST-020~034`, `T-COST-060~065`；真实 rollout enrichment 前后 SHA-256 一致。

**Dependencies:** Task 2.

**Files likely touched:** `src/rollout-parser.js`, `src/database.js`, `src/pricing.js`, `test/parser.test.js`, `test/database-server.test.js`, `test/pricing.test.js`.

**Estimated scope:** Medium.

### Task 4: Rebuild cost aggregation and public contract

**Description:** Task/Agent/Session/Day/Timeline 不再从 aggregate usage 直接估价，而只汇总 request-cost summaries；API/UI 同步改成 subscription-standard-equivalent 并保留 historical/feature coverage。

**Acceptance criteria:**

- [ ] Task cost = `Σ requestCost`，Agent/Session lineage 汇总和 unavailable count 守恒。
- [ ] Full Session / Day / Timeline 在相同 coverage 下逐项对账一致。
- [ ] 页面仍可简洁显示 `$xx.xx`，但明确不是实际 Plus 扣费，并能解释 partial/unknown feature coverage。

**Verification:** `T-COST-040~052`, `T-COST-070~073`；桌面/窄屏 browser contract（若 UI 有变化）。

**Dependencies:** Tasks 2-3.

**Files likely touched:** `src/pricing.js`, `src/snapshot-scope.js`, `src/monitor.js`, `src/server.js`, `public/**`, `test/database-server.test.js`, `test/ui-security.test.js`.

**Estimated scope:** Medium.

### Task 5: Reconcile real history and close delivery

**Description:** 对真实历史生成可审计的新旧 Cost reconciliation，分别量化 historical-rate、subscription-policy、long-context、Fast 和 unavailable coverage 的贡献；执行全量门槛并更新当前行为文档。

**Acceptance criteria:**

- [ ] reconciliation 不只输出总差额，而能拆分每类 policy adjustment。
- [ ] 真实历史 long-context candidate/request、service-tier coverage 和未知模型均有数量/Token/金额覆盖报告。
- [ ] `npm test`, `npm run check`, `git diff --check`、只读源哈希和适用浏览器验收全部通过后，Delivery/Verification 才标记 Phase 17 implemented。

**Verification:** `T-COST-080~083` + TEST 文档第 12~13 节全部门槛。

**Dependencies:** Tasks 2-4.

**Files likely touched:** `scripts/` reconciliation tool、`docs/VERIFICATION.md`, `docs/DELIVERY.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `CHANGELOG.md`, `tasks/plan.md`, `tasks/todo.md`.

**Estimated scope:** Medium.

### Checkpoint: Phase 17 design frozen

- [x] 用户选择 Subscription Standard-Rate Equivalent，而不是当前 API promotional equivalent。
- [x] 历史模型/历史价格、long context、Fast 与 cache-write 边界已冻结。
- [x] Request-level pricing 与 Token Ledger 不变量已冻结。
- [x] 测试失败必须回到 DESIGN/ADR 的闭环已写入测试门槛。
- [ ] 后续开发智能体在实现前重新阅读 DESIGN + TEST + ADR-0019。
- [ ] 通过全部 T-COST 门槛后再宣称 Phase 17 已交付。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rollout wire format changes | High | Capability-based parsing, CLI version display, unknown-record counters, quality labels |
| Copied paginated history is counted twice | High | Respect `subagent_history_start_ordinal` and deduplicate tasks by thread/turn |
| Cumulative counters reset | High | Request classifier accepts only a validated new generation whose request usage is independently proven by cumulative/last invariants; unexplained rollback remains anomaly/health evidence and cannot enter precise totals |
| Windows file notifications are dropped | Medium | Combine file watching with one-second stat reconciliation |
| Prompt text leaks into the archive | High | Never persist previews; serve them only after authenticated, explicit expansion |
| Task aggregate 被误当成 long-context request | High | Long-context 只允许在 event/request boundary evidence 通过后逐 usage unit 判断；测试锁定多 request false positive |
| 当前价重估导致历史金额漂移 | High | Historical Rate Catalog 使用 immutable effective intervals；gap 不猜最近价 |
| 历史 Fast metadata 未持久化 | Medium | 原 rollout 存在时只读 enrichment；缺源时保持 unknown/partial，不默认 standard |
| Pricing 重构污染 Token Ledger | High | v12→v13 migration test 对 classification + 六字段 usage 做逐行不变量验证 |

## Open Questions

- Phase 17 实现前必须完成 long-context request-boundary evidence gate：现有 verified model usage unit 是否可以严格作为官方 272K billing-request threshold 的边界；证据不足时设计已经规定降级为 candidate/partial，而不是猜测。

## Decision Log

Long-lived decisions are indexed in [`docs/decisions/README.md`](../docs/decisions/README.md). This plan remains the implementation history; ADRs are the source of truth for architectural rationale and consequences.
