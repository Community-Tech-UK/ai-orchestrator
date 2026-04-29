# Workflow Transitions And Resume Runbook

Use this runbook when workflow transitions, history search, or resume actions need investigation.

## Transition Policy Results

Workflow transition previews resolve to deterministic outcomes:

- `allow`: the transition can start now.
- `overlap`: a compatible transition can overlap an active execution.
- `auto-complete`: a prior phase can be completed automatically before the next starts.
- `deny`: the transition is blocked; use the reason and suggested action before retrying.

## Advanced History Search

Advanced search supports project scope, time range, source filters, pagination, and snippets. If results look incomplete, confirm the search source and project path first, then expand snippets for the selected rows.

## Resume Picker Actions

- `latest`: resume the newest eligible session in scope.
- `by-id`: restore a selected history entry.
- `switch-to-live`: focus an already-running session instead of creating another one.
- `fork-new`: create a forked continuation.
- `restore-fallback`: replay from fallback state after native resume is known to have failed.

## Interrupt Boundary Items

Interrupt boundaries are top-level transcript items. Phases progress through requested, cancelling, escalated, respawning, and completed. Outcomes identify whether the interruption cancelled, cancelled for edit, resumed natively, or fell back to replay.

## Compaction Summary Items

Compaction summaries are top-level transcript items with reason, before/after counts, optional tokens reclaimed, and fallback mode. They must not be folded into system-event groups.
