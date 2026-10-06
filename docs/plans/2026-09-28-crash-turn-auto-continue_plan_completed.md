# Auto-continue a turn cut off by a provider crash — plan

Status: completed (2026-09-28) — code complete and verified; live checks pending in
[2026-09-28-crash-turn-auto-continue_livetest.md](2026-09-28-crash-turn-auto-continue_livetest.md).

## Goal

When a provider CLI dies mid-turn and Harness restarts the session, the turn
that was running is lost and the session sits idle until the user sends
"continue" (seen repeatedly in Copilot session `pogg12k15`). James approved
doing that automatically.

## Behaviour

- Trigger: an automatic restart completes (the `autoRespawn` system notice:
  "Session reconnected automatically" / "Session restarted automatically …")
  **and** a turn was in flight when it died:
  - unexpected exit: the instance went `busy → respawning`;
  - stuck-process restart: the notice carries `recoveryCause: 'stuck'`, which
    only fires for an active turn.
- Not triggered by: a user interrupt (`busy → interrupting → respawning`), a
  process that died while idle, a restart that already handed the session a
  new turn (`respawning → busy`), child instances, loop-managed instances, a
  paused orchestrator, pending background async work, non-orchestrated
  (terminal) sessions.
- Send once the session settles, as Harness-authored input
  (`internalSource: 'crash-turn-continuation'`, `autoContinuation: true`), with
  a visible notice "Continuing the interrupted turn automatically (attempt N
  of 2)". After a fresh-session fallback the queued continuity preamble rides
  along with it.
- At most 2 automatic continuations per user turn; the counter resets when the
  user sends input. On the third crash: "…restarted again after two automatic
  continuations. Work is preserved. Send "continue" to try again."
- Any user input, interrupt, cancel, or terminal state cancels a pending
  continuation; the request-count guard stops it if a queued user message won
  the race to dispatch.

## Changes

- [x] `src/main/instance/instance-crash-turn-continuation.ts` (new) — service
      modelled on `instance-announce-then-halt-continuation.ts`.
- [x] `'crash-turn-continuation'` in `InternalInputSource` and
      `INTERNAL_INPUT_SOURCES`.
- [x] Initialization step in `src/main/app/initialization-steps.ts`, registered
      next to the announce-then-halt step.

## Verification

- [x] 18 unit tests (triggers, non-triggers incl. idle crash / interrupt /
      restart-handed-a-turn / stale marker, cap and reset, cancellation,
      request-count race, guard suppressions) plus an initialization-step test.
      Revert checks: removing each of seven guards fails its test. A
      "busy clears the marker" branch had no failing test on removal; it was
      dead code (every notice follows its own `respawning` entry, which resets
      the marker) and was deleted.
- [x] Canonical gates: tsc, typecheck:spec, lint, ts-max-loc, build:main,
      build:renderer; full suite 2249 files / 26895 tests passed.
- [x] Fresh-eyes gate: PASS. Follow-ups: declined the suggestion to check
      `waitReason` when the notice arrives (the unexpected-exit restart's own
      `respawning` wait reason is still set then — would suppress every
      continuation; documented in code); array type style fixed; a second
      review caught an overstated comment (stuck path), fixed and re-reviewed:
      PASS.
- Live checks deferred to the livetest doc (need the rebuilt app).

## As built

As planned. The trigger is the `autoRespawn` system notice seen on
`provider:normalized-event` plus the `busy → respawning` marker (or
`recoveryCause: 'stuck'`), so no restart-path code changed.
