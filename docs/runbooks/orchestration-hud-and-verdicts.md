# Orchestration HUD And Verdicts Runbook

Use this runbook to interpret parent-session orchestration status and verification verdicts.

## HUD Layout

The HUD appears on parent sessions and summarizes the child tree. Counts should match the agent tree state: active, waiting, failed, stale, and idle.

## Child State Badges

- `active`: child is currently working.
- `waiting`: child is blocked on input or dependency.
- `failed`: child failed or exhausted retries.
- `stale`: child has not reported recent progress.
- `idle`: child is available but not actively running a turn.

## Churn And Heartbeat

Churn count and turn count help distinguish healthy activity from repeated respawns or loops. Heartbeat timestamps should advance for active children; stale badges indicate the heartbeat is no longer fresh.

## Quick Actions

Quick actions include focusing a child, copying the spawn prompt hash, opening the diagnostic bundle, and summarizing children. Copy hash must route through `ClipboardService`, not direct browser clipboard calls.

## Verification Verdicts

Verdict statuses are pass, pass-with-notes, needs-changes, blocked, and inconclusive. Read confidence, required actions, risk areas, and evidence together; a high-confidence `needs-changes` verdict still requires follow-up.

## Raw Responses

Raw responses remain attached to verdict payloads for audit. If a rendered panel looks truncated, fetch the underlying verification result before assuming the source evidence was dropped.
