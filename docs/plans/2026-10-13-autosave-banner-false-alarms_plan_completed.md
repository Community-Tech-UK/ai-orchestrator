# Stop false "work missing from History" banners

**Date:** 2026-10-13
**Status:** Completed 2026-10-13 (packaged-app checks deferred to [livetest](2026-10-13-autosave-banner-false-alarms_livetest.md))
**Follows:** [2026-10-03-autosave-to-history_plan_completed.md](2026-10-03-autosave-to-history_plan_completed.md)

## Problem (reproduced on James's real profile, 2026-10-13)

The dashboard banner listed four sessions as "not in history". All four were in
History with every message. Each archived conversation held exactly one message
with no `id` and no `timestamp`: Codex's "Codex stopped retrying the provider
failure. Work is preserved." notice.

1. `codex-app-server-notification-adapter.ts` emits both native-retry notices
   (`willRetry` true/false) without `id`/`timestamp`, unlike every other output
   from that adapter. Nothing downstream fills them in.
2. `history-recovery-coverage.ts` `isVerifiedConversation` rejects a whole
   archive if any message lacks a string `id` or finite `timestamp`, so History
   is treated as not covering the session and the banner says "not in history".
   `continuity-revival.ts` `assertOutputMessage` applies the same rule to the
   History half of a recovery, so manual Recover would fail on that thread once
   coverage did match.
3. The startup auto-save pass then hands the session to `archiveInstance`, which
   skips it because an entry with the same `originalInstanceId` exists, and the
   pass still counts it as `submitted`. Recorded as a known limit in the
   2026-10-03 plan.

## Work items

1. **Source fix.** Give both Codex native-retry notices `id: generateId()` and
   `timestamp: Date.now()`. Safety net: `InstanceCommunication.withRuntimeMetadata`
   fills a missing `id`/`timestamp` on any adapter output before it reaches the
   buffer, so another provider cannot reintroduce this.
2. **Repair on History read.** New `history/archived-message-repair.ts`: when
   History loads a conversation file, a message that is otherwise well formed
   (an object with string content) but lacks an `id` gets a deterministic
   one (`<entryId>:repaired:<index>`), and a missing `timestamp` takes the
   previous valid one (else the entry's `createdAt`). Anything else stays
   untouched, so a genuinely corrupt archive is still not trusted as coverage.
   Applied in `HistoryManager.loadPersistedConversationForCoverage`, which feeds
   coverage, recovery, archive merging, the History viewer and every
   `updateConversation` write. The file is not rewritten on read, but any later
   save built from that load keeps the repaired values.
3. **Same-instance archive.** `archiveInstance` reports its outcome
   (`archived` / `already-archived` / `covered`) and accepts
   `allowSameInstanceRearchive`. The startup pass sets it only when the History
   copy was loaded and verified (so the archive is History + newer autosave, never
   the autosave alone), and counts declines separately from archives. A session
   whose History copy cannot be verified even after item 2 stays in the banner:
   the autosave may be the only good copy (first fresh-eyes gate, finding 1).
4. **Banner only for real leftovers.** After 1–3 the banner lists only legacy
   autosaves (no parent identity), ones without a thread id, ones whose History
   copy is damaged, and archives that fail. Verify against a copy of the real
   profile data.

## Known limits

- The same-runtime re-archive uses the History copy as read when the candidate
  was resolved. A History write landing between that read and the archive would
  be overwritten; the window is a few milliseconds early in startup, the same as
  the existing cross-runtime merge.
- A re-archive does not carry `archivedAt`, so a session the user had archived
  from the rail returns to it when newer autosaved work is merged in. The
  cross-runtime merge already behaved this way; arguably new work should be
  visible.

## Verification

- Reproduction test first: History entry with an id-less message + older autosave
  from the same instance ⇒ currently a candidate; after the fix, none.
- Targeted specs for each unit, then the AGENTS.md canonical checklist.
- Replay of the repair + coverage logic over James's four real archives.

## Status / as-built

All four items implemented. Item 4 needed no code beyond 1–3.

- Item 1: `codex-app-server-notification-adapter.ts` (both notices);
  `instance-communication.ts` `withRuntimeMetadata` safety net. A source scan
  found no other adapter emitting output without an id.
- Item 2: `archived-message-repair.ts` (+ spec), one call in
  `HistoryManager.loadPersistedConversationForCoverage`. Read-only scan of the
  real profile: 20 of 2,000 archives had malformed messages, all the two Codex
  notices; 0 remain unverifiable after repair.
- Item 3: `ArchiveInstanceOutcome` / `ArchiveInstanceOptions` in
  `should-archive-instance.ts`; `archiveInstance` returns the outcome; startup
  pass reports `archived` / `declined`. Three archive dependency types widened
  to `Promise<unknown>`. The first fresh-eyes gate (FAIL, finding 1) removed a
  candidate-service filter that hid autosaves whose runtime History held only in
  an unverifiable copy; such sessions stay in the banner and the pass declines
  them without touching History (test pins this).

Verification (2026-10-13):
- Reproduction test failed before the fix and passes after; with the repair
  call disabled it fails again (mutation check).
- Replay of the real repair + coverage code over copies of James's four
  archives: all four went from "NOT covered => banner" to "covered => no banner".
- `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`,
  `build:renderer`, full `test:quiet` (2408 files, 31,072 tests) all exit 0
  after the gate-1 fixes; later comment-only edits re-checked with tsc, lint and
  targeted tests.
- Fresh-eyes gates: 1 FAIL (fixed), 2 PASS (two Low notes: wording softened,
  limits recorded above), 3 PASS with no actionable findings.
- Packaged-app checks: see the livetest doc.
