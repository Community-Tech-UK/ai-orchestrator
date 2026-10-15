# Evidence Startup Delay Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task in the existing checkout. A separate fresh agent must use `task-completion-gate` before completion. Do not create a branch or worktree, commit, push, package-install, or restart James's running app without the authority required by `AGENTS.md`.

**Status:** Implementation and all agent-runnable verification completed in the existing root checkout on 13 October 2026. The genuinely fresh independent review returned **VERDICT: PASS**, with no unresolved actionable findings. Both typechecks, lint, the file-size gate, both builds, focused checks and the unfiltered full suite pass. Actual packaged-window launches remain deferred in the linked live-check document. No commit, push, installed-app activation, branch/worktree creation or AIO queue promotion is included in this completion. Earlier blocked rounds and the queue-worker handoff below are historical provenance.

**Goal:** Open a usable Harness window promptly with a large evidence history, while preserving encrypted capture, crash recovery, and safe cleanup.

**Architecture:** Keep keyring validation and evidence-service construction in startup. Publish the ready runtime before bulk reconciliation, then start a single background maintenance run after the window has loaded. Make reference pagination use indexed range queries, and guard background cleanup against concurrent captures and shutdown.

**Tech stack:** Electron 40, TypeScript, Node worker threads, better-sqlite3, Vitest; existing Angular renderer and IPC contracts.

**Requirements source:** The investigation in this chat on 13 October 2026 and the acceptance criteria below. No separate specification has been created.

## 1. Diagnosis and scope

The installed app launched at **09:57:13** and logged `Harness initialized` at **10:01:30**, approximately **257 seconds** later. Its `Context evidence` initialization ran from **09:57:14.826** to **10:01:15.031**, consuming **240.205 seconds** before window creation.

Observed profile size and counts at investigation time:

| Surface | Observation |
| --- | --- |
| Conversation database | 43,169,796,096 bytes, approximately 43.2 GB |
| Evidence records | 382,552 |
| Evidence cards | 382,549 |
| Provider event captures | 5,747,736 |
| Conversation messages | 308,564 |
| Conversations | 442 |
| Evidence deletion queue | Empty |

The app stayed alive. A process sample placed its conversation-ledger worker inside SQLite table traversal, sorting, and temporary-file writes. Read-only `EXPLAIN QUERY PLAN` showed table scans and temporary sort trees for the blob-reference query. A single reference page took approximately 0.39 seconds with the diagnostic Python SQLite connection; this is supporting evidence, not a benchmark of the bundled native driver.

The installed archive was checked and contains the same relevant startup-await, reference-pagination loop, and query ordering as the source checkout.

The runtime call path is:

```text
HarnessApp.initialize()
  -> createContextEvidenceInitializationStep()
  -> initializeContextEvidenceRuntime()
  -> initializeDefaultRuntime()
  -> EvidenceMaintenanceService.reconcileStartup()
     -> listAllReferencedBlobRefs(), 1,000 refs per request
     -> ContextEvidenceLedgerStore.listReferencedEvidenceBlobRefs()
     -> finalized orphan cleanup
  -> deletionService.runJanitor(100)
  -> publish contextEvidenceRuntime
  -> remaining initialization steps
  -> WindowManager.createMainWindow()
```

The database's total size is context, not proof that every byte is scanned. The confirmed defect is awaiting bulk evidence maintenance before runtime publication and window creation, compounded by reference queries that repeatedly scan and sort metadata.

In scope: evidence readiness, maintenance lifecycle, query/index efficiency, concurrency safety, content-free timing diagnostics, and large-profile startup verification.

Out of scope: changing retention policy, deleting or vacuuming James's database, repairing missing historical output chunks, fixing Copilot `EPIPE` errors, general startup-service reordering, or building a new loading screen. These were separate observations and are not prerequisites for this fix.

## 2. Acceptance criteria and constraints

Actual packaged post-window acceptance is deferred to [the live-check document](2026-10-13-evidence-startup-delay_livetest.md); CLI runtime generations do not certify it.
- [x] Waiting indefinitely on bulk maintenance does not delay evidence runtime readiness, IPC registration, or window creation. Use controlled promises to prove ordering without fragile wall-clock assertions.
- [x] Capture and validated evidence IPC work while maintenance is pending. Keyring/encryption failure retains the existing unavailable-mode behavior and never falls back to plaintext.
- [x] The reference query returns the complete, sorted, duplicate-free union of live record refs, live card refs, and unfinished deletion-queue refs across all pages, including prepared staging refs.
- [x] Large reference pagination uses indexed range access; a bounded merge/sort of page candidates is acceptable, a complete metadata-table scan/sort on every page is not.
- [x] A maintenance sweep cannot delete a referenced blob, an active staging file, a blob newer than its fixed sweep cutoff, or a blob protected by a pending deletion claim. An incomplete reference enumeration performs no finalized orphan deletion.
- [x] Repeated initialization/window recreation cannot start overlapping maintenance runs. Shutdown stops scheduling and prevents further destructive operations; restart safely resumes recovery.
- [x] New index migration preserves all rows and completes transactionally. Measure its first-launch cost and ensure initial capture/read requests do not run into the ledger worker's existing 10-second RPC deadline because of migration work.
- [x] All targeted tests, canonical project gates, and the genuinely fresh independent completion review pass. Current evidence and the PASS report are recorded in section 14.


Global constraints: preserve conversation ownership, encrypted blob authentication, secure directory identity checks, the 15-minute evidence-staging age threshold, and existing deletion grace/lease semantics. Keep the worker as the sole production SQLite writer. Do not increase startup or RPC timeouts to disguise the regression. Preserve unrelated dirty-tree work and avoid new dependencies.

Browser/UI checks use the AIO Browser Gateway and explicitly target `windows-pc` after worker/channel preflight. If unavailable, report the result and ask James how to proceed. Do not drive the local Mac or the hard-denied Harness computer-use target. Automated tests that open no window may run locally. An isolated packaged smoke may open a window on macOS, so it requires task-specific authority or an allowed remote/headless route.

## 3. Review focus

1. **First launch with existing data:** new indexes must not merely transfer the four-minute delay into worker migration or make early persistence calls time out. Covered by Tasks 2 and 4.
2. **Capture during cleanup:** a stale reference snapshot must not classify a newly prepared or referenced blob as an orphan. Covered by Task 3.
3. **Partial failure:** RPC timeout, filesystem error, or cancellation must leave evidence recoverable and must not produce a successful cleanup report. Covered by Tasks 1 and 3.
4. **Window recreation and restart:** maintenance runs once per runtime generation and stops safely at shutdown; a late asynchronous continuation cannot publish an old runtime. Covered by Tasks 1 and 3.
5. **Fail-closed storage:** corrupt keyring, authentication failure, symlink replacement, and unavailable encryption preserve current protections and visible error codes. Covered by Tasks 1, 3, and 4.

## 4. Task 1: Separate runtime readiness from bulk maintenance

**Files:**
- Modify: `src/main/context-evidence/evidence-maintenance-service.ts`.
- Modify: `src/main/app/initialization-steps.ts` and `src/main/index.ts` for the post-window maintenance hook.
- Create: `src/main/context-evidence/evidence-maintenance-runtime.spec.ts` for injected lifecycle dependencies.
- Verify existing: `src/main/app/initialization-steps.context-evidence.spec.ts`, `src/main/ipc/handlers/context-evidence.handlers.spec.ts`, and `src/main/context-evidence/evidence-key-manager.spec.ts`.

**Interfaces:** Preserve `initializeContextEvidenceRuntime(): Promise<void>` and `getContextEvidenceRuntime(): ContextEvidenceRuntime`. Initialization now resolves after keyring validation, service construction, cleanup registration, and runtime publication. Add these internal lifecycle entry points:

```ts
export function startContextEvidenceMaintenance(): void;
export function stopContextEvidenceMaintenance(): Promise<void>;
```

- [x] Read the complete implementation, coordinator consumers, IPC handler registration, worker readiness/timeout path, shutdown composition, and adjacent tests before editing. Reconfirm the observed sequencing with the existing startup logs and an isolated controlled reproduction.
- [x] Split service construction from `reconcileStartup()` and the initial deletion janitor call. Keep encryption initialization awaited; publish only a valid runtime. Retain unavailable IPC registration if readiness fails.
- [x] Call `startContextEvidenceMaintenance()` after `createMainWindow()` resolves and after normal readiness logging. Skip maintenance kickoff in the self-quitting packaged startup smoke; verify maintenance separately with a non-self-quitting isolated harness.
- [x] Make the start hook idempotent and generation-aware. Register shutdown cleanup when the runtime is created, before any background work starts. Invalidate pending initialization/start continuations on reset or shutdown.
- [x] Verify actual runtime ordering with a controlled maintenance promise: the window-ready seam proceeds while that promise remains unresolved, and evidence IPC is available. Verify unavailable encryption still produces typed failures and a usable app shell.
- [x] After behavior verification, add/update regression tests; do not rewrite existing assertions merely to obtain a green result. Build the lifecycle harness around the real readiness/maintenance split, injecting keyring and maintenance dependencies. Hold reconciliation unresolved; await initialization; assert `getContextEvidenceRuntime()` returns the constructed runtime and validated evidence IPC remains available. In the app-hook test, hold window loading unresolved and assert the maintenance-start spy has zero calls; resolve window loading and assert exactly one call. Reinvoke initialization/start and assert no second sweep. Mocking the entire initialization function would hide the defect and is not sufficient coverage.

Run focused checks:

```bash
rtk npm run test:quiet -- src/main/context-evidence/evidence-maintenance-runtime.spec.ts src/main/app/initialization-steps.context-evidence.spec.ts src/main/ipc/handlers/context-evidence.handlers.spec.ts src/main/context-evidence/evidence-key-manager.spec.ts
```

## 5. Task 2: Make evidence pagination use indexed ranges

**Files:** Modify `src/main/conversation-ledger/conversation-ledger-schema.ts` and `src/main/conversation-ledger/context-evidence-ledger-store.ts`. Extend `src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts` and `src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts` after verifying query behavior. Create `scripts/bench-evidence-maintenance.ts` for the reproducible synthetic benchmark.

**Interfaces:** Retain `EvidenceBlobReferenceQuery`, `EvidenceMaintenanceQuery`, and the existing return contracts. No renderer/preload API changes are needed for pagination.

- [x] Add the next schema migration without changing historical migrations. At planning time the latest version is 6; recheck before execution. Candidate indexes are:

```sql
CREATE INDEX idx_evidence_records_maintenance
  ON evidence_records(status, updated_at, id);
CREATE INDEX idx_evidence_records_live_blob
  ON evidence_records(blob_ref, conversation_id)
  WHERE blob_ref IS NOT NULL AND status <> 'deleted';
CREATE INDEX idx_evidence_cards_live_blob
  ON evidence_cards(blob_ref, conversation_id)
  WHERE blob_ref IS NOT NULL;
CREATE INDEX idx_evidence_deletion_queue_pending_blob
  ON evidence_deletion_queue(blob_ref)
  WHERE completed_at IS NULL;
```

- [x] Build distinct first-page and cursor-page SQL. Apply `blob_ref > ?` inside each union branch when a cursor exists; remove the outer `(? IS NULL OR blob_ref > ?)` predicate. Retain each source's live-conversation and deletion filters and the bounded final limit. Verify the actual bundled SQLite planner rather than assuming the SQL change is sufficient.
- [x] If the native planner still materializes whole sources, fetch up to `limit` sorted distinct refs independently from each indexed branch, merge/deduplicate those at most three bounded lists in the worker, and return their first `limit` entries. Apply the same cursor to each source; truncating each branch to `limit` cannot omit a value from the union's first `limit` entries. Keep this fallback within the store, preserving the RPC contract.
- [x] Keep `(updatedAt, id)` ordering for staging maintenance. Verify equal timestamps, rows changing status during recovery, and exclusion of deleted conversations; do not lose or repeatedly visit pending rows.
- [x] Verify migrations from a populated v6 fixture twice: first application preserves metadata/content and adds indexes; second application changes no rows or migration records. Record migration duration separately and test early worker requests under the existing RPC deadline.
- [x] After query behavior is verified, cover duplicate refs across sources, card-only refs, prepared staging refs, unfinished/completed deletion refs, empty sources, page sizes 1 and 1,000, and more than one full page. Compare all paginated output to a one-shot trusted union on the fixture.
- [x] The benchmark seeds **400,000 evidence rows and 400,000 card rows** with obvious placeholder content in an isolated directory. Run before and after through the production store/native driver. Record complete traversal time, first/middle/last page latency, migration duration, peak memory, and query plans. Target total reference traversal below **10 seconds** on the reference host and at least **10x improvement** against the original query when its baseline completes. Structural access-plan checks are the CI guard; wall-clock benchmarks are separate evidence.

```bash
rtk npm run test:quiet -- src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts
rtk npx tsx scripts/bench-evidence-maintenance.ts
```

If the native module ABI differs between Node and Electron, follow `docs/packaging-native-modules.md`; do not change dependencies or silently substitute Python SQLite for native verification.

## 6. Task 3: Run background maintenance safely and fairly

**Files:** Create `src/main/context-evidence/evidence-maintenance-scheduler.ts` and its spec. Modify `evidence-maintenance-service.ts`, `encrypted-evidence-blob-store.ts`, and `evidence-storage.types.ts` under the same directory, plus shutdown sequencing in `src/main/index.ts`. Modify `context-evidence-ledger-store.ts`, `conversation-ledger-service.ts`, `ledger-store-port.ts`, `conversation-ledger-worker-client.ts`, and `conversation-ledger-worker-main.ts` under `src/main/conversation-ledger/` for the bounded candidate-reference check. Update the closed worker method allowlist and all in-process/fake ports that implement it. Extend maintenance/blob-store/capture/deletion and worker integration specs after runtime verification.

**Interfaces:** Add a closed internal ledger method, with matching production worker and in-process implementations:

```ts
listReferencedEvidenceBlobRefsForCandidates(blobRefs: string[]): Promise<string[]>;
```

The store implementation returns `string[]` synchronously; asynchronous ports wrap it. Reject more than 100 candidate refs per call. Query all three reference sources with indexed `IN` lookups and preserve the same live-reference semantics as full enumeration. Add optional cancellation to maintenance/blob cleanup options without changing existing required fields or return shapes.

- [x] Schedule the first run **5 seconds after window readiness**, with one run in flight per runtime generation. Run staging reconciliation, staging cleanup, reference enumeration, finalized cleanup, and the initial leased deletion batch in that order. Do not add a second periodic orphan scan; retain the existing deletion janitor cadence after successful startup maintenance.
- [x] Yield to the event loop for **25 milliseconds between reference pages**, check cancellation before each page/filesystem mutation, and chunk candidate processing at **100 entries**. Continue using the dedicated ledger worker, but keep each RPC bounded so capture/read requests can interleave between pages. Do not hold a large SQLite read transaction throughout the sweep.
- [x] Take one fixed sweep timestamp. Preserve the existing 15-minute cutoff. Reconcile only pre-sweep staging candidates, re-read before transition, and use a conditional update if a row changed while reconciliation was in flight. Skip currently owned capture/staging work; cancellation or transient errors leave it pending.
- [x] Keep the complete reference set as a conservative initial filter. If any page fails or cancellation occurs, skip finalized orphan removal entirely. Never mistake partial results for the complete set.
- [x] Before removing any finalized candidate, run the bounded fresh-reference check and recheck age, directory identity, and cancellation. Protect record/card refs and unfinished deletion refs. Prove the remaining capture-to-unlink race is closed by immutable randomized blob names plus metadata preparation before rename; verify concurrent key rotation/card replacement against this proof. If a reference can still be published after the final check, serialize its publication and deletion through an explicit ownership/claim boundary before shipping.
- [x] Stop scheduling and synchronously abort the active generation at the beginning of `HarnessApp.cleanupSync()`. Await `stopContextEvidenceMaintenance()` at the start of asynchronous cleanup, before shutdown operations or cleanup-registry callbacks close the ledger. Keep the registered cleanup as an idempotent fallback, not the sole ordering guarantee: registry callbacks run concurrently. Await cancellation up to the existing cleanup budget; never treat a `Promise.race` timeout as cancellation of the underlying work. Prevent late janitor scheduling or runtime publication after stop/reset. Retry an interrupted sweep on the next launch; do not increase quit timeouts.
- [x] Log content-free phase start/end, duration, page/count totals, and failure/cancellation codes. Log every 50 pages at most; include no blob refs, conversation text, credentials, or key material. Separate runtime-ready timing from maintenance-finished timing.
- [x] Verify with an isolated real ledger/blob-store harness while captures, reads, deletion claims, and shutdown occur. Then pin: capture prepared between enumeration and candidate deletion; active staging file; failed middle page; duplicate start; cancellation before unlink; restart after interrupted sweep; corrupt/symlinked blob; and read/write latency while paging. Preserve existing recovery/authentication tests.

```bash
rtk npm run test:quiet -- src/main/context-evidence/evidence-maintenance-scheduler.spec.ts src/main/context-evidence/evidence-maintenance-service.spec.ts src/main/context-evidence/encrypted-evidence-blob-store.spec.ts src/main/context-evidence/evidence-capture-service.spec.ts src/main/context-evidence/evidence-deletion-service.spec.ts src/main/context-evidence/context-evidence-incident-replay.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-worker-client.spec.ts
```

## 7. Task 4: Verify populated-profile startup and storage behavior

**Files:** Extend `scripts/packaged-startup-smoke.js`, `scripts/__tests__/packaged-startup-smoke.spec.ts`, and `scripts/__tests__/packaged-startup-smoke.integration.spec.ts` to accept a fixture-seeding seam for the temporary profile. Add a separate isolated maintenance integration harness if the existing self-quitting smoke cannot exercise background work. Keep generated fixtures/results under `_scratch/`, ignored, with no real user data or keys.

- [x] Before changes, reproduce the delay with the synthetic large profile or the controlled pending-maintenance seam. Do not copy, migrate, vacuum, or launch a second process against James's production profile.
- [x] Retain the post-window readiness marker and existing degraded-evidence/critical-initialization failure checks. A launch that displays a window with evidence permanently unavailable must not pass as a healthy startup.
- [x] Verified one populated v6 upgrade and two migrated **headless runtime generations**, each under 30 seconds. Actual packaged/window launches remain pending in the linked live-check document. Include enough encrypted placeholder blobs across multiple directories to exercise traversal, plus authentic prepared recovery and deliberate stale-orphan fixtures. Record database counts and fixture sizes; the benchmark need not manufacture a 43 GB database to test 400,000-row metadata behavior.
- [x] Separately run the non-self-quitting harness through maintenance completion. Confirm new evidence can be captured and read during the sweep, referenced blobs survive, only eligible orphans disappear, and stop/restart behaves correctly. Record whole-sweep duration as well as query performance.
- [x] Use the authorized worker/headless route for automated app checks. For a rebuilt Mac app, obtain task-specific authority before a headed launch; otherwise record only the genuinely blocked live check with exact steps and prerequisites. Never silently skip the populated-profile integration checks that can run in tests or a CLI harness.
- [x] After runtime verification, add the populated-profile and ordering regressions. Run startup helper/integration specs and retain evidence from the actual rebuilt executable where available.

```bash
rtk npm run test:quiet -- scripts/__tests__/packaged-startup-smoke.spec.ts scripts/__tests__/packaged-startup-smoke.integration.spec.ts
```

## 8. Task 5: Full verification, independent review and closure

This completion records the user-requested implementation and final verification in the existing root checkout. Historical queue-worker instructions and receipts are retained in section 13; this does not manually integrate, promote or certify a parked AIO branch.

- [x] Run the targeted checks and both typechecks, lint, LOC, main build and renderer build. Independently repeat the canonical checks after concurrent edits settle.
- [x] Run the full unfiltered suite with current output and the normal tool path. Preserve earlier failed receipts; do not weaken assertions, increase timeouts or change test configuration.
- [x] Verify imports/exports, both ports, closed worker dispatch, production post-window kickoff, generation ownership and shutdown drain, including the compiled build.
- [x] Start a genuinely fresh read-only agent using `task-completion-gate`, acceptance criteria, retained native evidence, merge-base-to-HEAD and the complete scoped working/untracked delta.
- [x] Resolve the earlier actionable deleted-history paging finding, verify its repair and obtain fresh **VERDICT: PASS** with no unresolved actionable finding.
- [x] Record measured as-built results and keep genuine packaged-window checks in the linked livetest. All CLI-verifiable checks are complete.
- [x] Update this active plan and the livetest's back-link, rename the plan `_completed` last, and render the disposable review artifact from the final Markdown. Leave all work uncommitted.
- [x] Report actual acceptance status, including the deferred packaged launch. No app replacement/restart, commit or push is authorized or performed by this task.

Canonical commands (pinned project Node version; inherited tool PATH retained):

```bash
rtk npx tsc --noEmit
rtk npm run typecheck:spec
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run build:main
rtk npm run build:renderer
rtk npm run test:quiet
```

## 9. Planning review and current status

- [x] Investigated the running app and confirmed the four-minute evidence initialization bottleneck.
- [x] Read the runtime readiness/cleanup flow, reference queries, migration mechanism, current tests, and packaged-smoke constraints.
- [x] Selected readiness separation plus indexed background maintenance, with concurrency safeguards and first-upgrade verification.
- [x] Created this implementation plan and a disposable HTML review copy.
- [x] Current root implementation, all runnable checks and fresh independent final sign-off pass. Actual packaged-window acceptance remains deferred in the livetest.

## 10. As-built implementation and earlier measurements

The readiness/runtime lifecycle now lives in `evidence-maintenance-runtime.ts`, reexported from the original service entrypoint. Runtime construction still awaits keyring validation and one empty bounded worker readiness RPC; reconciliation and the initial deletion batch start through one cancellable scheduler five seconds after the loaded window and readiness marker. The self-quitting packaged smoke skips background work. Synchronous quit aborts scheduling; asynchronous quit awaits actual maintenance and scheduled janitor work before closing the ledger. Reset generations cannot publish a stale initialization.

Migration 7 adds four maintenance/reference indexes without altering historical migrations. `evidence-blob-reference-store.ts` fetches each source's bounded indexed page before merging it. Candidate reference checks (maximum 100 inputs) and live maintenance rereads are wired through service, both ports, and the closed worker dispatcher. Recovery transitions conditionally match staging status, timestamp, blob identity and live conversation.

`evidence-blob-cleanup.ts` owns bounded cancellation-aware cleanup. Complete reference enumeration precedes finalized cleanup; every candidate batch also gets a fresh lookup. Fixed cutoff, current file age/identity, directory identity, active write paths and publication ownership are checked before removal. Capture, cards and rotation own their whole write-to-metadata interval. A publisher appearing during a lookup invalidates the batch; a busy publisher conservatively postpones orphan removal until a later launch. Existing encryption/authentication and deletion grace/lease behavior remain in place.

Measured native SQLite fixture: 400,000 evidence records, 400,000 cards and 800,000 distinct reference strings. Original query traversal: 133.041 seconds. Final maintenance scan traversal after review remediation: 2.962 seconds (about 45 times faster). Earlier 1.103/0.737-second results measured the compatibility query, which retains a deleted-history limitation and is no longer used by maintenance. The latest retained JSON is the authority for current timings. Fresh populated v6 migration: 1.995 seconds with exact row counts preserved; repeat migration 0.115 milliseconds with migration records unchanged. Final actual production worker upgrade plus concurrent first capture/read: 1.917 seconds within the unchanged 10-second deadline; 801 interleaved scan/read pages had no failed RPCs, maximum read latency 4.040 milliseconds. Earlier compatibility-path timings remain retained in the query report.

Separate authenticated storage fixture: 400,018 evidence records, 400,000 cards, 17 conversations, 19 encrypted fixture blobs across 19 directories; database 467,677,184 bytes. Headless evidence readiness seam after remediation: upgrade 1,036.602 milliseconds, subsequent generations 2.260 and 2.566 milliseconds. Whole restart maintenance sweep: 24.110 seconds, including deliberate 25-millisecond fairness pauses between pages. These are CLI runtime generations, not process/window launches. Concurrent capture/read, prepared recovery, fixed-age orphan removal, referenced survival, cancellation before deletion, restart and deletion grace/claims passed.

Evidence is retained under `_scratch/evidence-startup-delay/query/`, `_scratch/evidence-startup-delay/startup/` and the final `_scratch/evidence-startup-delay/remediation-startup/`. The actual packaged post-window three-launch check requires an authorized GUI/package route and is recorded in [the live-check document](2026-10-13-evidence-startup-delay_livetest.md). No production database was copied, migrated, deleted or vacuumed; no installed app was replaced or restarted. Existing unrelated documentation and concurrent renderer edits remain outside this task's payload.

No estimate or performance target in this document is a completed verification claim. The Copilot errors and missing-output warnings remain separate from this plan's scope.

## 11. Historical independent review remediation (resolved)

The first independent review reproduced repeated traversal of excluded card references belonging to deleted conversations: a 50,000-live/50,000-deleted fixture took394ms when the deleted range followed the live range versus36ms when it preceded it. The data remained correct, but the critical cleanup scan could repeat that range on every page. This finding blocked the initial review; the bounded raw-page repair below resolved it, and the final fresh gate passed.

Added a maintenance-specific raw indexed scan page, keeping the existing exact live-reference API compatible. Each source reads at most1,000 raw indexed rows before deduplication or live-conversation checks. A safe frontier across full source pages prevents skewed duplicate groups from advancing past unseen references. The returned cursor advances independently of filtered live results; empty live pages therefore yield and continue. Existing candidate checks filter at most100 reference strings per call. Root owns the maintenance consumer, fake and isolated CLI; the query worker owns the closed ledger API and native benchmark. Source-level row counts in candidate lookups can still depend on duplicate owners; this is not a claim of constant SQLsteps for adversarial shared-name metadata.

Full parent suite failed only15tests in a concurrently changing unrelated provider config; an unchanged focused rerun passed19tests. The first reviewer full run was stopped before remediation edits and is not a successful gate receipt. Canonical checks and genuinely fresh reviews were repeated on the repaired payload.

The deleted-history remediation is implemented and native-verified: both sort orders return50,000 live refs in101pages,321/343ms rather than repeatedly traversing the excluded range. Final new critical-path benchmark is2.962seconds for800,000refs;801actual-worker scanpages had no failed requests.38focused runtime/CLI tests and51ledger tests pass. Both typechecks, lint, LOC and both builds pass on the repaired code. The subsequent full-run receipts are preserved below; the final current unfiltered suite and fresh gate passed, as recorded in section 14. No timeout, test filter or configuration was changed.

Second parent full suite actual exit1: `_scratch/test-run.pid-43010.log` / matching JSON records2,415passedfiles,31,153passedtests,6skipped and5failures only in the concurrently added/changed `plan-queue-verifier-select.spec.ts`. Task-owned hashes stayed unchanged. Current unchanged focused rerun of that queue spec passes10tests (`_scratch/test-run.evidence-queue-current.log`). Shared source then remained stable over a fresh check. The earlier reviewer then checked the repaired code in the existing checkout. Its blocked result is historical; the final resumed PASS in section 14 supersedes it. No branch/worktree authority was assumed or used.

## 12. Historical blocked verification round (superseded by section 14)

Tasks 1–4 are implemented. The original packaged-window acceptance remains genuinely deferred to [the live-check document](2026-10-13-evidence-startup-delay_livetest.md), not claimed from CLI timings. At this earlier handoff, final sign-off was withheld because unrelated edits moved during verification. The resumed scoped review and stable corrected run in section 14 resolved that blocker.

Independent repaired review evidence is under `_scratch/evidence-startup-delay/fresh-review-repaired/`. Both typechecks, lint, LOC and both builds independently returned exit0 (`gates.json`). The corrected unfiltered full suite returned actual exit0:2,419files,31,221passedtests,6existing skips,364.8seconds. Raw log/JSON: `_scratch/test-run.evidence-repaired-fresh-corrected.log` and `_scratch/test-results.evidence-repaired-fresh-corrected.json`. All38task-owned source hashes remained unchanged. A verifier PATH mistake caused3unrelated failures in the preceding independent run; the missing rg path was corrected,66unchanged affected tests passed, and the complete suite then passed. Failed receipts remain retained.

The new fresh reviewer independently tested100randomized native duplicate/deleted-owner runs across page sizes1/2/7/100/1000, a50k-live/50k-deleted fixture in both orders, fresh400k encrypted runtime construction/cleanup/restart, and the compiled production worker v6 upgrade/new scan route. All passed. Their final native worker measured2.439seconds for first requests including migration,801pages/exact800krefs, zero failures, maximum interleaved read140milliseconds under concurrent load. The fresh encrypted CLI measured814.418milliseconds upgrade readiness,2.106/2.465milliseconds subsequent generations and24.996seconds restart sweep. Packaged window verification remains explicitly false.

Final benchmark native first/middle/last page latencies:3.729/3.008/2.708milliseconds; peak memory181,264KiB. Original native first/middle/last:176.964/145.318/148.745milliseconds. The complete critical-path traversal is2.962seconds versus133.041seconds,44.91times faster. Candidate lookups are bounded by100submitted names, not a claim of constant underlying SQLsteps for arbitrarily many duplicate owners.

After the successful independent full run, four unrelated source files changed (contracts plan-queue schema, queue routing, checker plan and provider account routing), then additional queue routing/coordinator/flow/verifier source and tests changed. The unchanged evidence payload was green; that **then-current combined checkout** lacked a stable final canonical receipt, so the reviewer did not issue PASS. Final stability evidence is retained in their report directory. No further task source fix was identified. This earlier round remained blocked; the later scoped review, corrected unfiltered full run and final gates completed in the existing checkout. No temporary branch/worktree authorization was assumed or used.

The final resumed independent gate returned PASS before this document was closed. No installed-app activation/restart, commit or push forms part of this completion.

Historical independent verdict: **BLOCKED — current checkout still changing**, superseded by the resumed PASS in section 14. [Read-only review report](../../_scratch/evidence-startup-delay/fresh-review-repaired/report.md) records no actionable finding in the38unchanged task-owned files, all green task receipts, and the latest14unrelated source deltas. That round was not PASS. Its failed/blocked receipts remain preserved; all five implementation tasks are now verified, subject to the explicitly deferred packaged live check.

## 13. Historical queue-worker handoff — 13 October 2026

The queue worker reported its code and verification in `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-evidence-startup-de-94a931`, branch `queue/2026-10-13-evidence-startup-de-94a931`, base `02df9b4e2be4c6a00c0026c50184b2af8057f6d1`. This was the AIO-supplied checkout; no additional branch or worktree was created. The plan and livetest remain at their original absolute paths in the root checkout. There is no separate spec.

The worktree initially contained none of the implementation described above. The worker read all 38 task-owned root implementation/test files and their relevant call paths, retained an inspected snapshot under `_scratch/evidence-queue/source-snapshot/`, then brought those exact files into the supplied checkout. Unrelated root edits were excluded. An author review of the complete tracked/untracked delta found no additional actionable issue. All 38 resulting files match the inspected snapshot; manifests, test configuration, compiler/lint settings, generated aliases/channels and unrelated source remain unchanged. This author review is not the coordinator's independent completion gate.

Before changing production code, `_scratch/evidence-queue/reproduce-before.cjs` executed the original runtime initializer with a controlled real-maintenance ledger call. While that call remained unresolved, initialization stayed pending and runtime lookup returned unavailable; releasing it allowed publication. The reproduction passed, exit 0. After the readiness split was applied, the native encrypted CLI harness passed before regression tests were brought over. Controlled lifecycle/window/validated-IPC regressions subsequently passed.

As built: encryption and an empty bounded ledger-readiness RPC remain awaited; runtime publication precedes background reconciliation. The loaded-window seam logs readiness before one generation-aware five-second scheduler starts. Raw indexed reference scan pages use a separate advancing cursor through deleted histories and safe frontiers through duplicate groups, while the existing exact live-reference API remains compatible. Fresh candidate checks, fixed sweep cutoff, conditional staging transitions, capture/card/rotation publication ownership and cancellation preserve encrypted storage and deletion leases. Shutdown aborts synchronously and awaits actual background work before ledger cleanup. Production compiled worker dispatch exercises all new methods.

The queue checkout was absent from the filesystem and Git worktree list during final root verification. The following worker-reported historical paths/results are preserved for provenance; they are not the current completion evidence. Current root receipts are in section 14. AIO retains ownership of any parked branch and integration metadata.

All historical evidence paths below are relative to the **queue worktree**, not the root checkout:

| Check | Worker-reported historical result | Evidence |
| --- | --- | --- |
| Combined plan-targeted and added regressions | Exit 0; 20 files, 218 tests, 36.3 seconds | `_scratch/evidence-queue/targeted-tests.log` includes exact argv; full log `_scratch/test-run.pid-43168.log` |
| `rtk npx tsc --noEmit` | Exit 0 | `_scratch/evidence-queue/typecheck.log` |
| `rtk npm run typecheck:spec` | Exit 0, documented 8 GiB ceiling | `_scratch/evidence-queue/typecheck-spec.log` |
| `rtk npm run lint` | Exit 0 | `_scratch/evidence-queue/lint.log` |
| `rtk npm run check:ts-max-loc` | Exit 0; existing tolerated ceilings reported | `_scratch/evidence-queue/loc.log` |
| `rtk npm run build:main` | Exit 0; compiled runtime/store/worker and bundled preload present | `_scratch/evidence-queue/build-main.log` |
| `rtk npm run build:renderer` | Exit 0 | `_scratch/evidence-queue/build-renderer.log` |
| `rtk npm run generate:aliases` and `rtk npm run generate:ipc` | Both exit 0; generated content unchanged | Git diff of both generated paths is empty |
| Original versus current native traversal | Exit 0; 130.441 seconds versus 2.098 seconds, 62.16 times faster; exactly 800,000 refs | `_scratch/evidence-queue/native-benchmark.log`, `_scratch/evidence-startup-delay/query/native-j4srrL/result.json` |
| Native populated-v6 index migration | 701.392 ms; repeat 0.076 ms | Same benchmark receipt; row-preservation/transaction rollback/idempotence regressions also pass |
| Native encrypted populated runtime | Exit 0; upgrade readiness 453.629 ms, subsequent generations 1.369 / 1.082 ms; restart sweep 23.278 seconds | `_scratch/evidence-queue/runtime-cli.log`, `_scratch/evidence-startup-delay/startup/startup-results.json` |
| Production compiled worker over fresh v6 fixture | Exit 0; initial read/stage including migration 748.869 ms under unchanged 10-second deadline; 800,000 refs / 801 pages; max interleaved read 3.025 ms; zero failed RPCs | `_scratch/evidence-queue/native-worker.log`, `_scratch/evidence-queue/native-worker-result.json` |

Native measurements used the installed Electron 40 native SQLite ABI in `ELECTRON_RUN_AS_NODE=1` mode. Plain Node 24 correctly rejected that ABI during preflight; no dependency was installed or rebuilt. Reproduction commands were:

```bash
rtk proxy node _scratch/evidence-queue/reproduce-before.cjs
rtk proxy env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --require tsx/cjs scripts/isolated-evidence-startup.ts
rtk proxy env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --require tsx/cjs scripts/bench-evidence-maintenance.ts
rtk proxy env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron _scratch/evidence-queue/native-worker.cjs
```

The native traversal's first/middle/last nonempty pages took 3.657 / 2.030 / 3.240 ms, with a separate 0.097 ms termination page. Original nonempty pages took 193.207 / 177.020 / 79.469 ms. Peak cumulative RSS was 175,232 KiB for the improved run (156,832 KiB at the end of the original traversal). All six observed raw source plans used the new indexes with no temporary sort.

The authentic encrypted fixture contained 400,018 records, 400,000 cards, 17 conversations and 19 encrypted blobs across 19 directories; the database was 467,677,184 bytes. Concurrent capture/read, prepared recovery, referenced survival, eligible orphan removal, recent-orphan preservation, cancellation/restart and deletion grace/claims passed. Runtime generations are explicitly labeled `packagedWindowVerified: false`.

Worker-reported acceptance status at that handoff:

1. Three actual packaged post-window launches under 30 seconds: **deferred**, with prerequisites and expected observations in the linked livetest. This checkout has no `release/` directory or unpacked executable. `windows-pc` was connected and Browser Gateway health reported its remote channel fresh and commands deliverable; worker unavailability is not the reason for deferral. No GUI launch or installed-app change occurred.
2. Pending bulk maintenance cannot block runtime/IPC/window readiness: **verified** by controlled reproduction and passing readiness/window/IPC regressions.
3. Capture/validated IPC while pending and fail-closed encryption: **verified** by native encrypted CLI and lifecycle/IPC/keyring tests.
4. Exact sorted duplicate-free live-record/card/unfinished-deletion union, including prepared refs: **verified** by trusted-union, duplicate/frontier, empty-source, cursor and candidate regressions.
5. Indexed bounded pagination: **verified** by native access plans, the 800,000-ref benchmark and compiled worker traversal.
6. Referenced/active/recent/claimed blob protection and no finalized deletion on incomplete enumeration: **verified** by cleanup/maintenance/storage regressions and authentic encrypted harness.
7. Single generation, shutdown cancellation and restart recovery: **verified** by lifecycle/scheduler and encrypted harness.
8. Transactional index migration without lost rows or early deadline failures: **verified** by schema/range regressions, native upgrade and actual compiled-worker initial requests.
9. All canonical gates and independent completion review: **worker checks passed; coordinator full suite and fresh PASS pending**. Per the queue instruction, the worker did not run the full suite or rename this document.

The coordinator should review the complete staged/unstaged/untracked queue implementation delta as well as the merge-base-to-HEAD range; HEAD-only review currently omits all 38 files' changes. No commit, stash, push, package installation, branch switch, app replacement, restart, or production-profile mutation was performed. At that handoff the plan remained active for independent verification and coordinator closure. Final current-root verification is recorded in section 14.

> Plan Queue parked work: `queue/2026-10-13-evidence-startup-de-94a931` — 1 commit(s), reason: land-blocked.


## 14. Final current-root completion — 13 October 2026

The genuinely fresh read-only reviewer returned **VERDICT: PASS** with no unresolved actionable task finding. [Formal independent report](../../_scratch/evidence-startup-delay/fresh-review-resumed/report.md) records source tracing, acceptance mapping, forensics, native reproduction and actual command exits. It certifies the scoped evidence change and its executing boundaries; it does not claim whole-repository health or promotion of a parked AIO branch.

| Required item | Actual status | Current evidence |
| --- | --- | --- |
| Runtime readiness and post-window ordering | Verified | Construction, lifecycle, loaded-window and validated IPC regressions; production call path traced |
| Indexed exact reference scan and migration | Verified | Trusted union/randomized/deleted-owner checks, access plans and actual compiled v6 worker |
| Safe fair background maintenance/shutdown | Verified | Publication ownership, fixed cutoff, identity/cancellation checks and authentic encrypted interrupted/restarted sweep |
| Populated encrypted profile | Verified through native headless runtime | 400,018 records, 400,000 cards, 17 conversations and 19 encrypted blobs; actual window launches remain in livetest |
| Canonical checks and independent completion review | PASS | Six repeated gates, final spec typecheck, focused tests and corrected unfiltered full suite |

Both typechecks, lint, LOC and both builds returned exit 0 in `post-movement-gates.json`; the final `typecheck:spec` returned exit 0 in `final-typecheck-spec.json`. Current focused checks returned exit 0: 26 files / 504 tests. The corrected **unfiltered** full suite returned actual exit 0: 2,419 files, 31,254 passed tests and six existing skips. Full raw output and structured receipt: `_scratch/test-run.evidence-final-resumed-current.log` and `_scratch/test-results.evidence-final-resumed-current.json`; subprocess exit metadata: `_scratch/evidence-startup-delay/fresh-review-resumed/corrected-full.json`. No test filter, timeout, assertion or configuration was weakened. The project Node 24.15.0 was prepended to the inherited tool PATH; the documented eight-fork override was used.

Earlier concurrent queue/Codex changes were reviewed for actual effect, with current affected tests rerun after edits settled. The initial resumed full routing failure is retained; it no longer reproduced against the current guard, and the corrected full suite passed without verifier code/test edits. Final stability evidence records zero source differences across 6,015 files from corrected full start through the last gate, with all 38 task-owned files and 623 load-bearing boundary files unchanged. Reports and structured receipts are under `_scratch/evidence-startup-delay/fresh-review-resumed/`.

Fresh independent native checks passed: 100 randomized trusted-union comparisons; 50,000-live / 50,000-deleted-owner scans in both orders with exact results; actual newly compiled production worker over fresh v6 with 800,000 references / 801 pages and no failed RPCs. Initial worker read/stage including migration took 1.265 seconds under the unchanged ten-second deadline; interleaved traversal took 3.835 seconds and maximum read latency was 23.700 ms.

The final authentic encrypted native CLI measured evidence readiness of 844.654 ms for populated-v6 upgrade and 2.557 / 2.213 ms for migrated generations. Restart maintenance took 25.656 seconds, including fairness pauses. Capture/read during maintenance, prepared recovery, referenced/recent survival, eligible orphan removal, cancellation/restart and deletion grace/claims all passed. `packagedWindowVerified` remains false. No CLI timing is a claim about actual packaged renderer/window launch.

Deferred packaged window acceptance: [pending live-check document](2026-10-13-evidence-startup-delay_livetest.md). All implementation and agent-runnable checks are complete. No installed app was replaced/restarted; no commit, push, new branch/worktree, manual queue promotion or queue metadata mutation was performed in this root completion. Unrelated work is preserved. This document was updated while active and renamed `_completed` last, and remains uncommitted.
