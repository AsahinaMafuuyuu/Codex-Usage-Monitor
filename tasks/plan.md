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

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rollout wire format changes | High | Capability-based parsing, CLI version display, unknown-record counters, quality labels |
| Copied paginated history is counted twice | High | Respect `subagent_history_start_ordinal` and deduplicate tasks by thread/turn |
| Cumulative counters reset | High | Mark discontinuities and never synthesize a precise delta |
| Windows file notifications are dropped | Medium | Combine file watching with one-second stat reconciliation |
| Prompt text leaks into the archive | High | Never persist previews; serve them only after authenticated, explicit expansion |

## Open Questions

None. Product form, persistence, quota semantics, privacy, and project location were approved before implementation.

## Decision Log

Long-lived decisions are indexed in [`docs/decisions/README.md`](../docs/decisions/README.md). This plan remains the implementation history; ADRs are the source of truth for architectural rationale and consequences.
