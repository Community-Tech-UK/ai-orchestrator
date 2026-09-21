# Session Restart Recovery Specification

**Status:** Completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. Live checks (startup notice rendering, focus/keyboard behaviour, Resume Picker ordering) remain deferred to the plan's linked `_livetest.md`.
**Date:** 2026-08-30
**Implementation plan:** [2026-08-30-session-restart-recovery_plan_completed.md](../plans/2026-08-30-session-restart-recovery_plan_completed.md)

## Problem

After an unexpected machine restart, recent AIO sessions can disappear from the visible session list even though their session-continuity state and provider-native transcripts still exist on disk. The current shutdown snapshot does not reliably identify the sessions that were active immediately before shutdown, and no startup code consumes that snapshot.

The incident on 2026-08-30 exposed four distinct gaps:

1. `LastStopSnapshotManager.saveSnapshot()` takes the first 20 state records without sorting or deduplicating them. Older generations can therefore crowd out current sessions.
2. `LastStopSnapshotManager.getSnapshot()` has no production caller. A snapshot can be written correctly and still have no visible effect after restart.
3. History is written during asynchronous instance termination. A restart between the synchronous continuity save and completion of history archival leaves continuity newer than history.
4. The renderer's Resume Picker reads history and live instances, not continuity recovery candidates.

The filesystem did not roll back during the incident. The missing work is present in continuity/native transcript files; it is absent from the history-driven UI.

## Goal

Make unexpected-restart recovery a first-class, non-destructive path so that recently active work is discoverable and restorable even when graceful history archival does not complete.

## Non-goals

- Guaranteeing that every asynchronous shutdown phase completes before an operating-system restart.
- Automatically restarting an agent or re-sending a prompt when AIO launches.
- Deleting or rewriting the original continuity state during recovery.
- Replacing normal history archival, history restore, or provider-native resume.
- Loading every historical continuity file into memory at startup.

## Required Behaviour

### 1. The shutdown snapshot represents current work

- Snapshot selection must rank by real session activity, not insertion order.
- Generations of the same logical provider thread must collapse to one canonical candidate.
- Every currently live recoverable session must be included, even when more than 20 stale or hibernated sessions exist.
- Up to 20 additional non-live canonical sessions may be retained as fallback candidates.
- Snapshot format v2 must record enough metadata to rank, deduplicate, explain, and recover entries.
- Existing v1 snapshots must remain readable for one release cycle and be treated as hints rather than authoritative state.

### 2. Startup discovers recoverable work

- A recovery-candidate service must consume the last-stop snapshot.
- It must also scan recent continuity metadata so recovery still works when the snapshot is v1, missing, truncated, or corrupt.
- A candidate is recoverable when continuity contains meaningful work that is absent from, or newer than, the best matching history record.
- A logical thread already represented by a live instance must not be offered again.
- Candidate discovery must be bounded by time and count and must not hydrate thousands of full transcript files.
- The result must explain why each item is offered: `newer-than-history`, `unarchived`, or `draft-only`.

### 3. Restore is non-destructive and idempotent

- Recovery creates a new runtime instance ID. It never mutates the saved source state before the replacement instance starts successfully.
- The visible transcript is reconciled from the archived history prefix plus the continuity suffix.
- Transcript reconciliation must deduplicate exact message IDs and replayed messages with equivalent stable fingerprints.
- Messages newer than the history coverage watermark are appended in stable chronological order, including tool-result messages.
- Re-running reconciliation with the same inputs must produce the same output.
- Provider-native resume is used only when its cursor is present and has not already been marked failed; otherwise the normal replay/context path is used.
- A failed recovery leaves the candidate available and its source history/state untouched.
- A successful recovery disappears from the candidate list while its logical thread is live. The original state remains available until normal archival succeeds.

### 4. Recovery is visible but never automatic

- The application must show a non-modal startup notice when recovery candidates exist.
- The notice opens the Resume Picker; it does not launch a process.
- The Resume Picker must show an `Autosave recovery` group above ordinary history, with the recovery reason and last activity time.
- `Resume latest` must prefer the newest recovery candidate over an older history entry.
- Successful recovery selects the replacement instance and refreshes candidates.
- Recovery controls must be keyboard accessible and expose useful accessible names/status text.

### 5. Shutdown remains observable and recovery-safe

- Graceful-shutdown logs must distinguish phase start, completion, timeout, and failure.
- The synchronous continuity save and recovery snapshot remain the crash-safety boundary.
- History archival may skip a superseded/hibernated generation only when matching history already covers all of its messages.
- Abrupt termination after synchronous continuity save but before asynchronous history archive must be an automated recovery scenario, not an assumed edge case.

## Proposed Data Contracts

```ts
export type SessionRecoveryReason =
  | 'newer-than-history'
  | 'unarchived'
  | 'draft-only';

export interface SessionRecoveryCandidate {
  recoveryKey: string;
  sourceInstanceId: string;
  historyThreadId?: string;
  provider: ProviderType;
  modelId?: string;
  displayName?: string;
  workingDirectory?: string;
  lastActivityAt: number;
  historyCoveredThrough?: number;
  recoveredMessageCount: number;
  reason: SessionRecoveryReason;
  nativeResumeAvailable: boolean;
}

export interface RecoverSessionRequest {
  recoveryKey: string;
}

export interface RecoverSessionResult {
  instanceId: string;
  recoveredMessageCount: number;
  usedNativeResume: boolean;
}
```

Snapshot v2 extends each recoverable entry with `historyThreadId`, `lastActivityAt`, `isLive`, `messageCount`, and `hasAssistantOutput`. `capturedAt` continues to mean snapshot capture time; it must not be used as the session-activity ranking key.

## Canonical Recovery Identity

The canonical key is selected from the first available stable identity:

1. provider plus history thread ID;
2. provider plus thread identity derived from the resume cursor;
3. provider plus provider session ID;
4. source instance ID as a final fallback.

When multiple generations share a key, select a live generation first, then the generation with the newest `lastActivityAt`. Deterministic tie-breakers must make selection stable.

## Candidate Discovery Rules

1. Read v2 last-stop entries first and retain every entry marked live.
2. Read lightweight metadata for continuity states modified within the last seven days.
3. Deduplicate records by canonical recovery key.
4. Match each record to the best history entry using canonical thread identity, not display name.
5. Use the later of history `endedAt` and its last message timestamp as the history coverage watermark.
6. Treat a continuity record as newer only when its activity is more than five seconds beyond the watermark, avoiding timestamp-jitter false positives.
7. Include a record with no history when it contains a user prompt, assistant output, or an explicit draft prompt.
8. Exclude stateless, empty, fully covered, expired, and currently live logical threads.
9. Return at most 50 candidates, newest first, after preserving v2 entries known to have been live at shutdown.

The values above are implementation constants with tests, not hidden magic numbers.

## Transcript Reconciliation

Reconciliation receives optional archived messages and required continuity messages. It returns:

```ts
interface ReconciledRecoveryTranscript {
  messages: ConversationEntry[];
  archivedCount: number;
  recoveredCount: number;
  droppedDuplicates: number;
  coverageEnd?: number;
}
```

The algorithm preserves the archived prefix, builds ID and stable-fingerprint sets from that prefix, and considers continuity entries in timestamp/order sequence. Entries already represented by ID or fingerprint are dropped. Entries beyond the coverage watermark are appended. Equal-timestamp entries are appended only when their fingerprint is absent. The result must preserve role, content, tool-call/result information, timestamps, and stable IDs.

## Failure and Safety Semantics

- Candidate listing is read-only.
- Recovery validates provider availability and transcript integrity before creating the replacement instance.
- No recovery request may execute without an explicit user action.
- Recovery failure is returned as a typed IPC error and logged without transcript content or credentials.
- Corrupt individual state files are skipped and reported; they do not prevent other candidates loading.
- A corrupt or absent last-stop snapshot falls back to bounded continuity discovery.
- Existing history and continuity files are never deleted as part of this feature.

## Acceptance Criteria

1. With 25 stale sessions and two current live sessions, both live sessions appear in snapshot v2 and recovery candidates.
2. Multiple generations of one logical provider thread produce one candidate for the newest recoverable generation.
3. A v1, missing, or corrupt last-stop snapshot still permits recovery of recent continuity newer than history.
4. Continuity with 711 archived messages plus a newer suffix restores one ordered transcript without duplicating the archived prefix.
5. Killing the test app after synchronous continuity save and before history archival produces a recovery candidate on the next launch.
6. Selecting the candidate creates a replacement instance with the reconciled transcript and does not modify the source artifacts before successful startup.
7. Failed restore leaves the candidate visible; successful restore hides it while the replacement thread is live.
8. Startup notice and Resume Picker recovery controls are keyboard and screen-reader usable.
9. Existing history restore, fork, live-session selection, doc-review revival, and provider-native resume behaviour remain covered and passing.
10. All canonical repository verification gates pass, followed by an independent fresh-context completion review returning `VERDICT: PASS` with no actionable findings.

## Operational Validation

After all automated checks pass, validate with a copied test user-data directory and a packaged/restarted app. Do not mutate the production recovery files during automated testing. Any check that genuinely requires the rebuilt application is recorded in a sibling `_livetest.md` document before this specification and its plan are closed.

