# Sort out keeps its tools after a restart (History route)

## Status

Implemented and verified 17 November 2026; the live recheck is deferred to check 2 of the live-test document below. Defect:
[LT-1185](livetest-remediation-register.md#lt-1185). Follow-up to
[2026-11-15-set-aside-agent-merges-itself_plan_completed.md](2026-11-15-set-aside-agent-merges-itself_plan_completed.md)
change 4, which covered only crash-recovery revival. The live recheck is check 2 of
[2026-11-15-set-aside-agent-merges-itself_plan_livetest.md](2026-11-15-set-aside-agent-merges-itself_plan_livetest.md).

## Problem

A restart archives open sessions into History. Reopening the Sort out session then goes through
`HistoryRestoreCoordinator`, which built it from a History entry with no place for the `planQueueSetAsideFolder`
marker, so every Set aside tool refused it.

## Changes

1. `src/shared/types/history.types.ts`: History entries gain `planQueueSetAsideFolder`.
2. `src/main/history/history-manager.ts`: archiving records it from the session's metadata, or from an earlier entry of
   the same thread when a re-archived copy has lost it.
3. `src/main/history/archive-recoverable-sessions.ts`: startup archiving of a crash autosave puts the continuity
   state's folder into the archived metadata.
4. `src/main/history/history-restore-coordinator.ts`: reopening an entry puts the marker into the new session's
   metadata on both the native-resume and replay paths, merged with any phone-member policy. Forks get no marker.
5. `src/main/plan-queue/plan-queue-set-aside.ts`: the brief no longer says a History reopen loses the tools.

## Verification

- New and extended tests: `history-restore-coordinator.set-aside.spec.ts`, `history-manager-node-placement.spec.ts`,
  `archive-recoverable-sessions.spec.ts`. Removing the restore change fails three of them; removing the startup
  archive change fails its test.
- `npm run checks`: all green on the test Mac.
- `npm run test:quiet` on the Windows PC: 50,591 of 50,593 passed. The two failures are in other sessions' uncommitted
  work (the error-wording ratchet flags the automations page and loop-start panel; the browser-extension asset test).
- Fresh reviewer gate: `VERDICT: PASS`. Noted, unchanged: forking a live Sort out session copies its metadata (older
  behaviour in instance persistence), and the last-stop History ingest drops metadata for sessions never archived.
