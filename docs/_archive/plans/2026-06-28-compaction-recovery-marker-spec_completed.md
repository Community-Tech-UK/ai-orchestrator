# Compaction Recovery Marker — spec (completed)

Status: **completed / marker persistence and operator recovery affordance shipped.**
Date: 2026-06-28
Owner: TBD

## Current implementation reconciliation (2026-07-01)

This spec is no longer "not started":

- `session_compaction_markers` exists via migration `039_add_session_compaction_markers`.
- `src/main/persistence/rlm/rlm-compaction-markers.ts` records and lists marker rows.
- `src/main/app/compaction-runtime.ts` records provider-managed `thread/compacted` markers and orchestrator compaction boundaries.
- `src/main/app/instance-event-forwarding.ts` forwards normalized provider compaction metadata into the marker recorder.
- Renderer transcript formatting already labels compaction summaries from message metadata.

The spec is now complete: the operator-facing **recover context** action queues bounded wake/verbatim context as a continuity preamble for the next turn, and the transcript UI exposes a per-marker recovery control for compaction summary and provider boundary messages.

## Problem

When this spec was drafted, a CLI compaction event (Codex emits
`thread/compacted`) only showed a one-line system message and reset the context
bar to 0%. The durable marker portion has since been implemented. The remaining
gap is operator visibility plus an on-demand way to pull relevant
pre-compaction context back into view.

This is **not a data-loss bug** — see "What is already true" — it is a missing
operator-visibility + on-demand-recovery affordance.

## What is already true (verified 2026-06-28, do not re-litigate)

- **Conversation content is already preserved**, independent of compaction, in
  RLM `verbatim_segments` (64k+ rows, importance-scored, indexed by wing/room)
  and `conversation_imports`. These are current and continuous (2.5 months of
  data) and feed wake context + the project startup brief. So compaction does not
  lose content from AIO's memory — only from the CLI's active window.
- **Codex's native compaction is a black box.** The `thread/compacted`
  notification carries only `threadId` — no dropped turns, no summary, no token
  detail (`src/main/cli/adapters/codex-cli-adapter.ts:~1894`). The client cannot
  enumerate what was dropped from the event alone.
- **`session_compaction_summaries` / `session_archived_turns` are unwired by
  design.** They belong to `SessionCompactor` →
  `SmartCompactionManager.checkAndCompact()`, which is never called in production
  (`src/main/rlm/session-compactor.ts`, `src/main/rlm/smart-compaction.ts`).
  That is AIO's own rolling-window compaction strategy, unused because CLIs
  self-manage context. **Do not reuse these tables for this feature** — they
  model per-turn archival the native event cannot supply.

## Goal

A lightweight, additive **compaction marker** + an on-demand **"recover context"**
action. No interception of the CLI's internal compaction, no per-turn archival.

Current state: marker recording and "recover context" are implemented.

## Non-goals

- Archiving the specific turns Codex dropped (impossible from the event;
  redundant with `verbatim_segments`).
- Wiring `SessionCompactor` / `SmartCompactionManager`.
- Generating a summary of dropped content at compaction time (data unavailable).

## Design sketch

### 1. Record a marker on compaction

Status: **implemented in current code** for provider-managed and orchestrator
compaction boundaries.
On `thread/compacted` (and the equivalent for other self-managing providers),
write one lightweight row:

- `id`, `instance_id` / `thread_id`, `project_key`
- `created_at`
- `utilization_before`, `utilization_after` (the adapter already has
  `lastTurnTokens` before it clears it — capture before reset)
- `ledger_anchor`: pointer to the live conversation range at that moment
  (a `conversation_messages` / `verbatim_segments` cursor or timestamp), so
  recovery knows "what was in context up to here"

New table (do NOT reuse the SessionCompactor tables), e.g.
`session_compaction_markers`. Keep it provider-agnostic.

### 2. Surface it in the transcript

Status: **implemented.** Compaction summaries are labelled in the transcript and
show a marker-scoped recovery affordance when a compaction marker id is present.
Render the existing "context compacted" system message as an anchor the operator
can expand: "Compacted at 00:17 (86% → 0%) — recover context".

### 3. "Recover context" action (on demand)

Status: **implemented.**
When invoked, retrieve the most relevant prior turns for the current goal from
`verbatim_segments` / wake context (importance- and recency-ranked, bounded by a
token budget) and queue them as a continuity context block for the next turn.
Reuse the existing wake-context / retrieval machinery rather than building new retrieval.

## Touchpoints (from investigation)

- Detection: `src/main/cli/adapters/codex-cli-adapter.ts` (`thread/compacted`
  handler, ~line 1894 — capture utilization before clearing `lastTurnTokens`).
- Provider-agnostic seam: `src/main/cli/adapters/base-cli-adapter.types.ts`
  documents `self-managed auto-compaction`; add the marker emit here.
- Persistence: new table via the RLM migration path
  (`src/main/persistence/rlm/…`); new read/write methods alongside existing RLM
  accessors. Do not touch `session-compactor.ts`.
- Recovery retrieval: reuse `verbatim_segments` / wake-context builder
  (`src/main/memory/wake-context-builder.ts`).
- Renderer: transcript system-message rendering + a "recover context" affordance.

## Risks / open questions

- The CLI session/compaction path is fragile (50-hour-loop concerns). Keep all
  writes best-effort and off the turn-decision path.
- Token budget + ranking for re-injection needs tuning so recovery doesn't itself
  cause a re-compaction.
- Multi-provider: confirm which other adapters self-manage compaction and whether
  they expose before/after utilization.
- UX: is "recover context" per-compaction, or a general "pull relevant history"
  action? The latter may subsume this.

## Decision

Completed. Marker persistence has shipped, provider/manual compaction events
carry marker ids into transcript metadata, and the recovery action queues
bounded wake/verbatim context through the existing continuity preamble path.
