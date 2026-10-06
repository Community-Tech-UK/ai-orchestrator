# Auto-save orphaned autosaves into History

**Date:** 2026-10-03
**Status:** Completed 2026-10-03

## Problem

The dashboard banner "N autosaved sessions available" lists sessions with a
session-continuity autosave but no History entry. The banner is confusing:

1. The ↻ glyph is decorative (`aria-hidden` span) but is boxed like a button.
2. "Review autosave" opens the general Resume picker with the fuzzy query
   `autosave`. The matcher is a subsequence match, so it lets through ~94 of
   2,000 real History entries alongside the real autosave items.
3. Nothing is lost only if the user acts on it. Recover spawns a live CLI per
   session, so it is not a safe automatic default.

## Decision

At startup, copy recoverable autosaves of top-level sessions into History
without starting any process. Keep the banner only for what auto-save cannot
safely handle, and fix its two UI defects.

## Must not regress

- Sub-agent sessions (Plan Queue workers/verifiers, orchestration children) are
  never archived to History on close (`instance-termination.ts`
  `archiveRootConversation`). They must not be auto-saved, and they should not be
  offered as "not in history" either.
- A History entry the user deleted, or anything from before "Clear all
  history", must not be resurrected.
- "Newer than history" autosaves must merge with the existing History entry,
  never replace it with a shorter transcript.

## Work items

1. **Record parent identity in continuity.** `SessionState.parentId`
   (`null` = top-level, string = child, absent = legacy record). Copied in
   `instanceToState`; carried into `ContinuityRecoveryMetadata` + its Zod
   schema; carried across snapshot-over-metadata merges in the candidate
   service.
2. **History suppression.** `HistoryIndex.deletedHistoryThreads`
   (threadId → deletedAt) tombstone on delete; `HistoryIndex.recoverySuppressedThrough`
   set by `clearAll`.
   `HistoryManager.isRecoverySuppressed()` answers for a candidate identity.
3. **Candidate service.** Exclude known children and history-suppressed
   records. Expose whether a candidate is a known top-level session for
   auto-save.
4. **Auto-save pass.** New `history/archive-recoverable-sessions.ts`: for each known
   top-level candidate with a history thread, merge History + autosave with the
   same reconciliation Recover uses (`buildRecoveryBuffer`), build an archive
   instance and call `HistoryManager.archiveInstance`. Legacy (unknown parent)
   records stay banner-only and age out of the 7-day window.
5. **Startup wiring.** Run after last-stop ingest in
   `initializeSessionRecoveryRuntime`; the recovery list IPC waits for the pass
   so the banner never flashes items that are about to be saved.
6. **Renderer.** Banner icon no longer looks like a button; History rail reloads
   once the post-startup recovery list resolves. "Review autosave" shows only
   the autosave recovery group (kind filter, not fuzzy text).

## Verification

Targeted specs for each unit, then the AGENTS.md canonical checklist.

## Status / as-built

All six items implemented. First fresh-eyes gate: PASS with 2 Medium / 7 Low
findings; L1 (failure causes logged), L2 (startup wiring, output-storage and
tool-outcome coverage), L4 (bounded wait), L5 (doc names), L6 (detached children)
and L7 (log wording) fixed; M1, M2, L3 recorded below as known limits.
Second gate: PASS; fixed the untimed sessionId tombstone overriding a timed
thread tombstone, replaced the banner glyph (↻ reads as "refresh" across the
app) with ⚠, and added sidecar-persistence and failure-log tests; remaining
items recorded below.

- Item 1: `session-continuity.types.ts`, `session-continuity.ts` (`instanceToState`),
  `continuity-recovery-metadata.ts` (schema + builder).
- Item 2: `history-recovery-suppression.ts`; `HistoryManager.deleteEntry` /
  `clearAll` / `isRecoverySuppressed` (net -3 lines; file is at its LOC ceiling).
- Item 3: `session-recovery-candidate-service.ts` (`isSuppressedByHistory` dep,
  child exclusion, `listTopLevelCandidates`, startup gate helpers).
- Item 4: `history/archive-recoverable-sessions.ts`, reusing
  `buildVerifiedRecoveryBuffer` exported from `continuity-revival.ts`.
- Item 5: `session-recovery-initialization.ts`; `session-recovery-handlers.ts`
  awaits the gate. The existing last-stop ingest now also skips known children
  and deleted/cleared threads (same hazard, same data).
- Item 6: banner copy/icon/History reload; picker `recoveryOnly` kind filter
  with a "Show all sessions" control in the picker header.

Known limits, by design:

- Autosaves written before `parentId` existed stay banner-only until they age
  out of the 7-day window (no persisted parent data exists for them).
- If History already holds an entry whose `originalInstanceId` is the autosave's
  source instance, `archiveInstance` skips it and the banner keeps offering it.
  The pass still counts it as `submitted` (History cannot report the skip).
- History is capped at 2,000 entries. Each auto-saved session (not merges into
  an existing thread) evicts the oldest entry, exactly as closing that session
  normally would have done — but a crash recovery does it in one batch of up to
  50 ordinary candidates plus every session that was live at the last shutdown.
  Possible follow-up: skip or log when History is near its cap.
- Deletions and clears made before this build left no tombstones. They are still
  safe: every autosave written before this build lacks `parentId`, so it is
  never auto-saved (banner-only), and terminated sessions are never re-saved.
- Autosaves carry no execution location, automation flags, hardened or
  browser-tools mode, so an auto-saved remote or automation session lands in
  History as an ordinary local, visible session. Manual Recover has the same
  limit. `endedAt` is the archive time, so recovered entries sort as just ended.
- A child detached by an `orphan-children` / `reparent-to-root` parent is synced
  to `parentId: null` in continuity (`instance-termination.ts`), so it is
  treated as top-level like History treats it.
- The recovery list waits at most 30s for the startup pass; after that it lists
  candidates as before, and the History rail is not reloaded again when a slow
  pass finishes later.
- "Legacy is banner-only" applies to the new pass. The pre-existing last-stop
  ingest still ingests legacy shutdown-live sessions (it can only skip a state
  whose `parentId` is known to be a parent), as it did before this change.
- Residual, not reproduced: a timed thread tombstone compares against the
  autosave's `lastActivityAt`, which a save bumps. A terminated session whose
  History entry was deleted would need a later save (native-resume-failure
  mark, transcript repair) to slip past it; those come from resuming that
  identity, which a deleted entry no longer offers. No test pins this.
- The pass resolves every candidate before archiving any (each archive
  invalidates the candidate cache), so every candidate's merged transcript in
  the startup batch (up to 50 ordinary plus every shutdown-live one) is held in
  memory together at startup.

Third gate: PASS, no Critical/High/Medium. Its "covered-superseded skip" note
does not apply: the archive instance is `idle`, so `shouldArchiveInstance`
returns `current-generation` before any coverage check.

Live check (2026-10-03, dev app on a throwaway `AIO_DEV_USER_DATA_PATH` profile
seeded with a top-level, a child and a legacy autosave; Chromium sandbox off
because this session runs inside Harness's process sandbox):
- app.log: `Startup autosave archive finished { submitted: 1, skipped: 0, failed: 0 }`
  about 9s after launch.
- History index: only the top-level thread, with both messages, source instance
  id preserved; child and legacy not archived.
- Banner (CDP read + screenshot): ⚠ glyph without a box, "A session has work
  missing from History", listing only the legacy autosave; the auto-saved
  session appears in the Sessions rail.
- "Review autosave": scope note + "Show all sessions", one Autosave recovery
  row, no History rows.
- Chrome native-messaging manifest unchanged (same SHA-1, packaged path);
  dev app, static server and temp profile removed afterwards.

Verification (2026-10-03): targeted specs; `tsc --noEmit`, `typecheck:spec`,
`lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, full
`test:quiet` all exit 0 (latest full run: 2336 files, 29277 tests).
