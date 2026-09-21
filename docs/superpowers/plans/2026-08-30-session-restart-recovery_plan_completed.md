# Session Restart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Do not create a branch or worktree. Follow the repository's active-document lifecycle and completion gate.

**Status:** Completed 2026-09-20. Live checks deferred to [2026-08-30-session-restart-recovery_livetest.md](./2026-08-30-session-restart-recovery_livetest.md) (5 open — startup notice rendering, focus/keyboard behaviour, Resume Picker ordering).

**Goal:** Make recent AIO work reliably discoverable and recoverable after an abrupt restart, even when history archival did not complete.

**Architecture:** Treat synchronously persisted session continuity as the crash-safety source and history as an optional archived prefix. Snapshot v2 selects live/current logical threads deterministically; a bounded startup service reconciles snapshot hints, continuity metadata, history coverage, and current live instances into recovery candidates. Explicit user action revives a new instance from a non-destructively reconciled transcript. Renderer state exposes candidates through a startup notice and the existing Resume Picker.

**Tech Stack:** Electron 40 main process, TypeScript, Angular 22 signals/standalone components, Zod 4 IPC contracts, better-sqlite3/history storage, Vitest.

**Spec:** [2026-08-30-session-restart-recovery_spec_completed.md](../specs/2026-08-30-session-restart-recovery_spec_completed.md)

## Global Constraints

- Work in James's current checkout. Do not create or switch branches or worktrees.
- Preserve every unrelated dirty-tree change.
- Keep this plan and its linked specification untracked and unstaged while implementation is active.
- Do not commit unless James explicitly authorises a commit. This overrides generic skill commit steps.
- Read every target file and its callers/tests in full immediately before editing; paths below are the expected surfaces, not permission to skip investigation.
- Reproduce failures before changing behaviour. Write focused failing tests before implementation.
- Never place transcript content, credentials, resume cursors, or realistic secret-like values in logs, fixtures, or screenshots.
- Candidate listing must remain read-only, and no agent process may start without an explicit user action.
- Run focused tests after each task. Run the complete canonical verification checklist after the multi-file implementation.
- Do not mark the documents complete until an independent fresh-context reviewer uses `task-completion-gate` and returns `VERDICT: PASS` with no unresolved actionable findings.

## Incident Baseline

Before implementation, preserve a redacted, code-level reproduction rather than copying James's production data into the repository:

- the synchronous continuity save completes;
- asynchronous history archival is interrupted;
- last-stop contains more than 20 unordered generations;
- continuity is newer than the matching history entry;
- the current UI cannot surface that state.

The implementation is successful only when this scenario becomes recoverable without depending on graceful shutdown completion.

## Task 1: Make Snapshot Selection Current, Canonical, and Backward Compatible

**Files:**

- Create: `src/main/session/recoverable-session-selection.ts`
- Modify: `src/main/session/last-stop-snapshot.ts`
- Modify: `src/main/session/session-continuity.ts`
- Modify: `src/main/session/__tests__/last-stop-snapshot.spec.ts`
- Create: `src/main/session/recoverable-session-selection.spec.ts`
- Modify only if required after tracing types: `src/main/instance/instance-manager.ts`

- [x] Read the complete snapshot manager, continuity manager, instance lookup APIs, state types, and existing snapshot tests.
- [x] Add failing selection tests covering 25 stale entries plus two live entries, duplicate generations, deterministic ties, stateless/empty records, and more than 20 live records.
- [x] Define a pure selection input that does not depend on `InstanceManager`:

```ts
export interface RecoverableSessionSelectionInput extends RecoverableSession {
  recoveryKey: string;
  lastActivityAt: number;
  isLive: boolean;
  messageCount: number;
  hasAssistantOutput: boolean;
}

export function selectRecoverableSessions(
  sessions: readonly RecoverableSessionSelectionInput[],
  nonLiveLimit = 20,
): RecoverableSessionSelectionInput[];
```

- [x] Implement canonical-key generation in the same module. Prefer history thread ID, resume-cursor thread identity, provider session ID, then source instance ID. Never log the raw key or cursor.
- [x] Dedupe by key, preferring live then newest activity; return all canonical live entries followed by at most 20 newest non-live entries with deterministic tie-breakers.
- [x] Introduce versioned snapshot types (`LastStopSnapshotV1`, `LastStopSnapshotV2`) and parsing that migrates v1 entries into conservative hints.
- [x] Make snapshot expiry use top-level `writtenAt`; make ranking use `lastActivityAt`.
- [x] Update `SessionContinuityManager.buildRecoverableSessionList()` to derive true last activity, message count, assistant-output presence, history identity, and current live status. Add only the smallest read-only `InstanceManagerForContinuity` capability required to classify an instance.
- [x] Verify focused tests:

```bash
rtk npm run test:quiet -- src/main/session/recoverable-session-selection.spec.ts src/main/session/__tests__/last-stop-snapshot.spec.ts src/main/session/session-continuity.spec.ts
```

Expected: all selection, v1 migration, v2 round-trip, expiry, and continuity integration tests pass.

## Task 2: Discover Recovery Candidates at Startup

**Files:**

- Create: `src/shared/types/session-recovery.types.ts`
- Create: `src/main/session/session-recovery-candidate-service.ts`
- Create: `src/main/session/session-recovery-candidate-service.spec.ts`
- Modify: `src/main/session/session-continuity.ts`
- Modify: the history query/repository file identified by tracing `HistoryManager` thread lookup
- Modify: `src/main/index.ts` or the actual composition root identified during tracing

- [x] Read the complete history manager/repository, continuity file-index/load path, composition root, reset-for-testing conventions, and shared provider/message types.
- [x] Add failing tests for `newer-than-history`, `unarchived`, `draft-only`, unchanged/fully archived exclusion, currently live exclusion, corrupt-file isolation, v1/missing/corrupt snapshot fallback, and deterministic top-50 ordering.
- [x] Add the shared candidate/request/result contracts from the specification, using existing provider and timestamp conventions.
- [x] Add lightweight continuity metadata enumeration. It must read headers/metadata only where possible, restrict fallback discovery to files modified within seven days, and hydrate full state only for shortlisted candidates.
- [x] Add a history coverage query returning the later of thread `endedAt` and its last message timestamp. Match by stable logical identity, never display name.
- [x] Implement `SessionRecoveryCandidateService` with injected dependencies and `_resetForTesting()` if made a singleton:

```ts
export class SessionRecoveryCandidateService {
  listCandidates(): Promise<SessionRecoveryCandidate[]>;
  resolveCandidate(recoveryKey: string): Promise<ResolvedRecoveryCandidate>;
  invalidate(): void;
}
```

- [x] Merge v2 snapshot hints, recent continuity metadata, history coverage, and live logical identities. Apply the five-second skew tolerance, seven-day fallback window, and 50-candidate cap as named exported/tested constants.
- [x] Preserve every v2 entry known to have been live at shutdown before applying the non-live result cap.
- [x] Register lifecycle invalidation on instance creation/termination and after successful archival so stale candidates disappear without a restart.
- [x] Verify focused tests and a performance assertion using thousands of metadata stubs to prove bounded full-state hydration:

```bash
rtk npm run test:quiet -- src/main/session/session-recovery-candidate-service.spec.ts src/main/session/session-continuity.spec.ts
```

Expected: candidate reasons, exclusions, legacy fallback, corruption isolation, bounds, and sorting pass.

## Task 3: Reconcile History and Continuity Without Data Loss

**Files:**

- Create: `src/main/session/recovery-transcript-reconciler.ts`
- Create: `src/main/session/recovery-transcript-reconciler.spec.ts`
- Modify: `src/main/instance/lifecycle/continuity-revival.ts`
- Modify: `src/main/instance/lifecycle/continuity-revival.spec.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Modify: the relevant instance creation/buffer tests discovered while tracing revival

- [x] Read the complete continuity-revival flow, provider adapter resume flow, instance construction, conversation buffer mutation, history restore, and their tests.
- [x] Add failing reconciler tests for archived-prefix overlap, exact-ID duplicates, changed-ID replay duplicates, equal timestamps, out-of-order state entries, tool calls/results, 711-message history plus a newer suffix, and idempotence.
- [x] Implement a pure reconciler:

```ts
export function reconcileRecoveryTranscript(
  archived: readonly ConversationEntry[],
  continuity: readonly ConversationEntry[],
): ReconciledRecoveryTranscript;
```

- [x] Build stable fingerprints from normalized role, content, tool-call/result identity, and timestamp bucket. Keep fingerprinting local; do not persist transcript-derived hashes unless a later profiling result requires it.
- [x] Preserve the archived prefix and append only unseen continuity entries at/after the coverage boundary in deterministic order. Return counts for observability without returning message content in logs.
- [x] Generalize continuity revival reason to `'doc-review-submission' | 'crash-recovery'` without changing existing doc-review semantics.
- [x] Add `InstanceManager.recoverFromContinuity(resolvedCandidate)` (or an equivalently named typed method) that validates first, creates a new runtime ID, seeds the reconciled visible transcript, and uses provider-native resume only when its cursor is valid and has not previously failed.
- [x] Make the operation transactional at the application level: if validation/instance start fails, tear down only the partial replacement and leave history, source state, and candidate unchanged.
- [x] On success, select/return the replacement instance, invalidate candidate cache, and let live-identity exclusion hide the source candidate. Do not delete the source state.
- [x] Verify focused tests:

```bash
rtk npm run test:quiet -- src/main/session/recovery-transcript-reconciler.spec.ts src/main/instance/lifecycle/continuity-revival.spec.ts
```

Expected: reconciliation is lossless/idempotent, doc-review behaviour is unchanged, recovery failure is non-destructive, and native/replay paths are covered.

## Task 4: Expose Typed Recovery IPC Through Preload

**Files:**

- Modify: `packages/contracts/src/schemas/session.schemas.ts`
- Modify: the contracts barrel exports used by existing session schemas
- Modify: `packages/contracts/src/channels/session.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Modify: `src/main/ipc/handlers/resume-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts` only if registration follows the existing ownership pattern there
- Modify: `src/preload/domains/session.preload.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/domains/types.ts` if the new methods require a shared preload-domain type
- Modify: corresponding schema, handler, preload, and API-shape specs

- [x] Trace the complete IPC path for `SESSION_LIST_RESUMABLE`, `SESSION_RESUME`, and history restore before choosing handler ownership.
- [x] Add failing schema and handler tests for empty list, candidate list, unknown/stale key, validation failure, provider unavailable, start failure, and success.
- [x] Add `SESSION_RECOVERY_LIST` and `SESSION_RECOVERY_RESTORE` to the canonical channel map.
- [x] Define Zod request/result schemas matching the shared contracts; derive types from schemas where existing contract conventions require it.
- [x] Register list and restore handlers that call only the candidate/revival services. Convert known failures into existing typed IPC error shapes; do not include transcript content or resume cursors.
- [x] Expose preload methods:

```ts
listRecoveryCandidates(): Promise<SessionRecoveryCandidate[]>;
recoverSession(request: RecoverSessionRequest): Promise<RecoverSessionResult>;
```

- [x] Update Electron API types and exact-shape tests so the renderer cannot bypass validation.
- [x] If a new `@contracts/...` subpath is introduced, update all required runtime/test aliases: `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts`.
- [x] Verify focused tests:

```bash
rtk npm run test:quiet -- packages/contracts/src/schemas/__tests__/session-wave3.schemas.spec.ts packages/contracts/src/channels/__tests__/session.channels.spec.ts src/main/ipc/handlers/__tests__/session-handlers.spec.ts src/preload/__tests__/ipc-channel-contract.spec.ts
```

Expected: schemas reject malformed payloads, errors are typed/redacted, and the preload/API contract resolves end to end.

## Task 5: Surface Recovery in the Resume Picker and at Startup

**Files:**

- Create: `src/renderer/app/core/state/session-recovery.store.ts`
- Create: `src/renderer/app/core/state/session-recovery.store.spec.ts`
- Modify: `src/renderer/app/features/resume/resume-picker.types.ts`
- Modify: `src/renderer/app/features/resume/resume-picker.controller.ts`
- Modify: `src/renderer/app/features/resume/resume-actions.service.ts`
- Modify: `src/renderer/app/features/resume/resume-picker-host.component.ts`
- Modify: corresponding Resume Picker specs
- Create: `src/renderer/app/shared/components/session-recovery-banner/session-recovery-banner.component.ts`
- Create: `src/renderer/app/shared/components/session-recovery-banner/session-recovery-banner.component.html`
- Create: `src/renderer/app/shared/components/session-recovery-banner/session-recovery-banner.component.scss`
- Create: `src/renderer/app/shared/components/session-recovery-banner/session-recovery-banner.component.spec.ts`
- Modify: the application shell/dashboard component selected after tracing startup composition

- [x] Read the full Resume Picker controller/actions/host, HistoryStore, app shell/dashboard, selection store, accessibility patterns, and all adjacent tests.
- [x] Add failing store tests for initial load, refresh, stale-response protection, error state, in-flight restore, success invalidation, and failure retention.
- [x] Implement an injectable signal store with `candidates`, `loading`, `error`, `refresh()`, and `recover(recoveryKey)`; guard against earlier async responses overwriting newer state.
- [x] Extend picker item kind/action with `recovery` / `recoverAutosave`. Add an `Autosave recovery` group above History, with reason text, last activity, optional recovered-message count, and an `Autosave` badge.
- [x] Make Resume Latest choose the newest recovery candidate before ordinary history. Preserve current live-instance and history behaviour when no candidate exists.
- [x] On successful restore, select the returned instance, close the picker, refresh candidates/history/live state, and announce the result through the existing accessible status mechanism.
- [x] Add a non-modal startup banner when candidates exist. Its primary action opens the Resume Picker focused on recovery; dismissal is session-local and never mutates recovery data.
- [x] Add keyboard/ARIA tests: meaningful names, focus order, Enter/Space activation, loading/disabled semantics, error announcement, and focus return when the picker closes.
- [x] Verify focused Angular tests:

```bash
rtk npm run test:quiet -- src/renderer/app/core/state/session-recovery.store.spec.ts src/renderer/app/features/resume/resume-picker.controller.spec.ts src/renderer/app/features/resume/resume-actions.service.spec.ts src/renderer/app/features/resume/resume-picker-host.component.spec.ts src/renderer/app/shared/components/session-recovery-banner/session-recovery-banner.component.spec.ts
```

Expected: recovery is discoverable without automatic execution, Resume Latest precedence is correct, success/failure state is correct, and accessibility cases pass.

## Task 6: Make Shutdown Archival Observable and Avoid Redundant Work Safely

**Files:**

- Modify: `src/main/process/graceful-shutdown.ts`
- Modify: `src/main/process/__tests__/graceful-shutdown.spec.ts`
- Create: `src/main/history/should-archive-instance.ts`
- Create: `src/main/history/should-archive-instance.spec.ts`
- Modify: `src/main/instance/lifecycle/instance-termination.ts`
- Modify: `src/main/instance/lifecycle/instance-termination.spec.ts`
- Modify: `src/main/index.ts`

- [x] Read the complete graceful-shutdown manager, app quit handlers, termination flow, automation-failure archival rules, history writer, and tests.
- [x] Add failing tests for phase started/completed/failed/timed-out events and for event-loop stalls where timer delivery is delayed.
- [x] Add structured phase reporting with phase name, outcome, and elapsed milliseconds. Keep logs free of prompts, output, paths that may contain secrets, and process environment.
- [x] Document in code that `Promise.race` budgets are cooperative and cannot interrupt synchronous/event-loop-blocking work; do not claim otherwise in logs.
- [x] Add a pure `shouldArchiveInstance(instanceSummary, historyCoverage)` helper. It may skip a hibernated/superseded generation only when matching history covers its last meaningful message. Preserve existing visibility rules for failed automations and never skip a live/current generation solely because another generation exists.
- [x] Query coverage before gzip/write and log only skip reason plus stable redacted identifiers.
- [x] Keep `cleanupSync()` continuity/snapshot persistence as the primary crash-safety step and ensure it precedes process termination.
- [x] Verify focused tests:

```bash
rtk npm run test:quiet -- src/main/process/__tests__/graceful-shutdown.spec.ts src/main/history/should-archive-instance.spec.ts src/main/instance/lifecycle/instance-termination.spec.ts
```

Expected: shutdown outcomes are observable, redundant archive skips require positive coverage evidence, and existing failure archival behaviour remains intact.

## Task 7: Prove Abrupt-Restart Recovery End to End

**Files:**

- Create: `src/main/session/session-restart-recovery.integration.spec.ts`
- Modify: test helpers for isolated user-data/history/continuity directories as needed
- Modify: `docs/architecture.md`
- Modify: `docs/testing.md` only if a new test tier/command is introduced

- [x] Build an isolated integration fixture using obvious placeholder content and a temporary user-data directory.
- [x] Write the failing incident scenario: create overlapping history/continuity, save sync continuity and last-stop, interrupt before async archive, re-create services as a new process/startup, list the candidate, restore it, and verify the exact reconciled suffix.
- [x] Cover v1/missing snapshot fallback in the same integration layer so recovery is not coupled to one manifest version.
- [x] Assert the source continuity and history files are byte-for-byte unchanged after candidate listing and after a forced restore failure.
- [x] Assert successful recovery uses a new runtime ID, excludes the candidate while live, and preserves source artifacts until normal archive.
- [x] If feasible with existing test infrastructure, use a child process and an explicit IPC barrier to terminate after `cleanupSync()` but before history archive. Do not use timing-only sleeps as the synchronization mechanism.
- [x] Update architecture documentation with the crash-safety boundary, candidate pipeline, explicit-user-action rule, and ownership of snapshot/candidate/reconciliation/revival layers.
- [x] Verify the integration test:

```bash
rtk npm run test:quiet -- src/main/session/session-restart-recovery.integration.spec.ts
```

Expected: the simulated restart surfaces and restores the missing suffix without altering source artifacts.

## Task 8: Run Repository Gates and Independent Completion Review

- [x] Inspect `rtk git diff --check` and the full task diff; confirm no unrelated edits, secrets, production transcripts, or active-document staging.
- [x] Run the canonical gates in this order:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run build:main
rtk npm run test:quiet
```

Expected: every command exits zero. Record exact failures and repair root causes before proceeding.

- [x] Exercise the dev application with synthetic recovery data if the UI can be verified without a rebuild/restart. Verify banner, picker, recovery selection, error retention, keyboard navigation, and no automatic process start.
- [x] For checks that genuinely require a packaged rebuild/restart or copied user-data directory, create `docs/superpowers/plans/2026-08-30-session-restart-recovery_livetest.md` with exact prerequisites, actions, expected observations, reason for deferral, remediation header, and a link to this plan. Do not defer any agent-runnable test.
- [x] Start a genuinely fresh agent context that did not implement the change. Require it to use `task-completion-gate` and review the merge-base-to-HEAD/worktree diff plus the specification for architecture, test integrity, security, async/state races, performance, accessibility, shutdown behaviour, and conditional UI.
- [x] Treat every actionable finding as unfinished work. Fix findings, rerun focused and canonical gates, then request another genuinely fresh completion-gate review. Repeat until the reviewer returns exactly `VERDICT: PASS` with no unresolved actionable findings.
- [x] Update the specification acceptance checklist and both documents' as-built notes with actual files, design deviations, test evidence, and any legitimate live-test deferrals.
- [x] If a live-test document is required, move deferred checks out of this plan into it before closing the plan.
- [x] Update the specification's plan link, rename this plan to `2026-08-30-session-restart-recovery_plan_completed.md`, and rename the specification to `2026-08-30-session-restart-recovery_spec_completed.md`. Perform these renames only after all agent-runnable work passes and the fresh completion gate returns PASS.
- [x] Verify the closed documents have `_completed` filenames before any later staging. Do not stage or commit without James's explicit authorisation.

## Final Completion Evidence

The final implementation handoff must report each of the following separately:

- snapshot v2 live-session guarantee and legacy migration;
- bounded startup candidate discovery;
- non-destructive transcript reconciliation and revival;
- typed IPC/preload path;
- Resume Picker and startup notice behaviour;
- shutdown phase evidence and safe archive skipping;
- abrupt-restart integration result;
- canonical command results;
- independent completion-gate verdict;
- any pending `_livetest.md` checks, stated as deferred rather than verified.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.

### Checkbox reconciliation (2026-09-20)

This plan was written in the step-by-step checkbox style and the implementing session never ticked
the boxes as it went, so a reader arriving after the `_completed` rename would have seen a closed
plan full of unchecked work. The boxes are now ticked to match reality, which was established by
reading the executing code and the specs on disk — not by trusting the plan's own prose. The
independent fresh-eyes reviewer confirmed each step's artefact exists and that the tests covering it
are load-bearing rather than vacuous. Items that genuinely remain unverified are the live checks,
and those are named in the status line above and tracked in the linked `_livetest.md`, not ticked
here.
