# Maintained rolling handoff state — implementation plan (spec item 5)

**Status:** COMPLETED (code) 2026-07-17 — `handoff-state-service.ts` (incremental cursor
ingest, 24-turn verbatim ring, fold-by-8 into a `generateLocalSummary` rolling summary with
prior-summary anchoring, `redactSecrets` on fold AND render, bounded document, LRU +
instance-removed cleanup, stateless from-messages sibling for archive consumers); fed from
the turn-completion seam (setting-gated, fail-soft); consumed at the two ladder bottom-rung
seams (`restart-policy-helpers.buildReplayContinuityMessage`, history-restore coordinator
preambles) with fall-through, DEFAULT OFF ⇒ byte-identical (spec-proven). Native resume and
`buildFallbackHistory` remain the untouched upper rungs; compaction recovery keeps its own
compactor-maintained state (as-built ladder membership, documented). Default-ON decision is
explicitly deferred to livetest check 5:
[`2026-07-17-rolling-handoff-state-plan_livetest.md`](2026-07-17-rolling-handoff-state-plan_livetest.md).
**Date:** 2026-07-17
**Spec:** [`2026-07-16-runtime-reconciler-migration_spec_planned.md`](../specs/2026-07-16-runtime-reconciler-migration_spec_planned.md), scope item 5 (the last open item).

> For agentic workers: execute inline with test-first cycles. Do not commit or push.

## Investigated seams (2026-07-17)

- **The spec's named target** is the swap-time `buildReplayContinuityMessage` construction.
  The single lifecycle choke point is `restart-policy-helpers.ts:buildReplayContinuityMessage`
  (provider/model swaps, yolo toggles, agent-mode changes, interrupt replay all route there);
  history restore + session forks use the message-based
  `session/replay-continuity.ts:buildReplayContinuityMessage` directly.
- **The hydration ladder already has its upper rungs**: native resume (rung 1) and
  `buildFallbackHistory` — the token-budgeted full-history injection (rung 2, 40 recent turns /
  200-char tool results). The handoff document is rung 3, replacing today's bottom rung (the
  swap-time replay preamble rebuilt from the raw output buffer at swap time). It must NOT
  replace `buildFallbackHistory`.
- **Compaction recovery** maintains its own rolling summary state via the compactor
  (`context-compactor` + `compaction-recovery`) — it is already "maintained handoff state" for
  its consumer and stays untouched; noted as as-built ladder membership rather than rewired.
- **Building blocks reused**: `generateLocalSummary` (deterministic compaction-style summary,
  no LLM), `redactSecrets` from `context-compaction-prompt.ts` (the spec's named redaction
  rules), the unresolved-items extraction family from `replay-continuity.ts`,
  `extractFileOperationsFromTurns` for workspace facts.

## Design

`src/main/session/handoff-state-service.ts` (singleton, `_resetForTesting`):

- **Incremental maintenance** — `noteTurnCompleted(instance)` from the turn-completion seam in
  `instance-communication.ts` (same spot that feeds cost + cache analytics; fail-soft): ingests
  conversational messages the service has not yet seen (cursor per instance), keeps a bounded
  verbatim ring (24 turns × 800 chars); on overflow folds the oldest 8 turns into a rolling
  summary via `generateLocalSummary(folded, priorSummary)` with `redactSecrets` applied — prior
  decisions survive folds via the anchor section, matching compaction semantics.
- **Rendering** — `buildHandoffDocument(instance, reason)`: compaction-style rolling summary +
  unresolved items + recent verbatim turns + key workspace facts (cwd, provider/model, file
  operations observed), bounded overall, `redactSecrets` over the final text, wrapped in the
  same `<conversation_history>` envelope consumers already expect. Stateless sibling
  `buildHandoffDocumentFromMessages(messages, meta)` for archive-backed consumers (history
  restore) where no live rolling state exists.
- **Consumption (gated)** — setting `sessionHandoffStateEnabled` (default **OFF** — behavior
  preservation first; the spec's own trigger to lean on this item is provider-swap livetest
  evidence, which has not run yet): when ON, `restart-policy-helpers.buildReplayContinuityMessage`
  and the history-restore coordinator's two preamble sites prefer the handoff document and fall
  through to today's builders when the service returns null. When OFF, byte-identical behavior.
- **Hygiene** — LRU-bounded per-instance state, cleared on `instance:removed` (same hook as
  browser-tool scoping); no persistence in v1 (the document is rebuildable from the transcript;
  the incremental state is a quality/latency optimization, honestly noted).

## Tasks

- [x] Service + maintenance + rendering + `_resetForTesting`; exhaustive spec (cursor ingest,
      ring bound, fold-with-anchor, unresolved extraction, workspace facts, redaction, budget,
      from-messages parity, LRU/removal).
- [x] Feed seam in `instance-communication.ts` (setting-gated, fail-soft) + removal hook in
      `instance-manager`.
- [x] Setting: types + defaults(OFF) + control policy `open(z.boolean())` + metadata row.
- [x] Consumers: `restart-policy-helpers` + history-restore coordinator (both fall-through,
      gated); specs proving OFF ⇒ byte-identical and ON ⇒ handoff preferred with fallback.
- [x] Canonical verification checklist (tsc ×2 clean, lint clean, LOC clean, targeted suites 1273 green: history 11-test coordinator incl. handoff-ON case, service 8/8, gating 3/3; full suite as final gate — loop record).
- [x] Livetest doc: flip the setting ON, provider-swap a session with real context, compare
      carried context vs the replay preamble; compaction-recovery and restore sanity passes.

## Acceptance

- OFF by default with byte-identical current behavior (spec-proven).
- ON: swap/restore preambles come from the maintained document (summary anchored across folds,
  secrets redacted, bounded); fallback rungs intact when state is absent.
- Canonical checklist green; livetest written; plan renamed `_completed` last; spec item 5
  marked complete → spec eligible for `_completed` rename (all items resolved).
