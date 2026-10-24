# Oct-2 housekeeping implementation evidence

Status: worker implementation ready; coordinator independent verification, full suite and integration pending. No linked spec exists; scope is the plan and answered decisions page.

## Checklist

- [x] 1.1 Lazy worktree indexes, retirement cleanup, protected project roots
- [x] 1.2 Startup/daily observation expiry cleanup
- [x] 1.3 Confirmed ledger shrink offer at half free pages
- [x] 1.4 State file cap and history-aware cleanup
- [x] 1.5 Hourly temp-home sweep and test leak fix
- [x] 1.6 Safe old work folder listing, archive, confirmation and Restore
- [x] 1.7 RLM backup offer
- [x] 1.8 Total storage and measured weekly growth
- [x] 2.1 CLI updater interruption guard and waiting pill
- [x] 2.2 Claude floor table and remote guidance
- [x] 2.3 Single Copilot floor
- [x] 2.4 Compressed Codex rollouts and protocol refresh
- [x] 3.1 RTK worker, daily rollup, cached results and seven days
- [x] 3.2 RTK 0.52.0 and bundled licences
- [x] 3.3 RTK project burst notices
- [x] 4 Instructions fallback and Copilot startup live check
- [x] 5.1 Observation memory retirement/migration and machine exclusion
- [x] 5.2 Wake hidden rows, shown counts, summary and tombstones
- [x] 6.1 Rejected-idea register and AGENTS guidance
- [x] 6.2 Read-only measurement kit

## Evidence and choices

1. Ordinary project index roots are conservatively excluded from count eviction, even when no explicit open provenance survives. This safe superset preserves user-opened roots; manifest-size safety remains. Temporary worktrees still compete for the ten-root count.
2. Windows worker filesystem probe: `C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator`, local git config `core.symlinks=false`. A disposable file symlink was created and read successfully, then removed. Git would materialize tracked symlinks as text here, so use the one-line CLAUDE import fallback. Worker instance `cjtgcmx0b`.
3. Test-first failures retained in worktree `_scratch/test-run.pid-54088.log` (index policy), `56729` (index removal), `59829` (automatic retrieval), `63850` (weekly measurements). Initial green index policy: 12/12, log `54943`; worker/retrieval/context: 21/21, log `60818`.

## As-built mapping and verification

| Item | Actual implementation and evidence |
| --- | --- |
|1.1|Spawn/prewarm skips `.worktrees` on both separator styles. Automatic prompt retrieval cannot warm indexes. Explicit symbol/code search warms the exact root. Queue retirement deletes its index through the serialized worker; missing worktree indexes are retried by maintenance. Ordinary project roots do not compete for count eviction. Focused pruner/gateway/worker/retrieval/MCP/prewarm/spawn/queue tests passed.|
|1.2|Observation retention runs on startup and daily even while OFF; `applyDecay` logs removed expired-row counts. Runtime/store tests passed.|
|1.3|Shrink review appears once >=half the pages are free (the unrelated 5 GiB floor is removed). Size appears on the offer; existing preview tickets, disk-space gate and real rebuild path retained. Small/large fixture and UI confirmation tests passed.|
|1.4|New states capped at 8 MiB, retaining newest content and explicit incomplete flags; oversized metadata preserves previous disk state. Cleanup waits History readiness, protects all known logical IDs/live/dirty states, conservatively keeps uncertain legacy identity and rechecks under mutex. Size/completeness/hydration/envelope/retention/cleanup tests passed.|
|1.5|Confirmed creator is CodexHomeManager. PID/thread markers and active registry protect real homes. Hourly jitter scheduler handles abandoned homes, retaining uncertain ownership/process states; legacy keeps a day grace. Global Codex-idle check also protects orphan children. Shared adapter helper now cleans real managers even after failed assertions/restored spies. Representative adapter rerun 191 tests, zero new temp homes; ownership/scheduler/helper tests passed. No real sweep executed.|
|1.6|Existing leftover work-folder report/removal/store/card extended and embedded in Storage. Lists task/stale queue folders with age/size/dirty/unpushed/process evidence. Unknown owner/process/push visibility blocks removal. Dirty contents have a verified private archive paired with durable Git baseline/manifest refs; Restore survives service restart.36 focused tests plus stricter follow-ups passed, including roundtrip/race/corruption.|
|1.7|Storage backup note explicitly offers old learning database copies; review retains newest and requires confirmation. Existing ticket/backup tests pass. No real backup removed.|
|1.8|Total comes from one link-safe app-root walk. Bounded daily measurements persist; weekly change is measured only with a 7–8 day old baseline, otherwise unavailable. Restart/measurement fixtures and rendered copy passed.|
|2.1|Only mid-turn/pending approval sessions block opted-in safe installers. Session-state subscriptions retry after settlement; pill shows waiting count. Guard/updater/poller/pill tests passed.|
|2.2|Shared Claude floors: resume 2.1.300, side question 2.1.299, tool-search stability 2.1.302; plain-word remote requirements. No fabricated remote version verification. Probe/remote-detail tests passed.|
|2.3|Shared Copilot 1.0.100 constant used in guidance, ready for Phase C warning reuse.|
|2.4|Streaming `.jsonl.zst` lookup, bounded line parsing; actual installed Codex 0.163.0 snapshot generated and verified. `prebuild:main` refreshes on every installed version change. No CLI means explicit unverified warning, no guessed snapshot. Scanner/generator/protocol-consumer tests passed.|
|3.1|SQLite queries use RTK worker with explicit shutdown cleanup; disposable eight-day daily rollup reads source read-only, incrementally resumes and reopens replaced sources. UI defaults seven days, immediately reuses renderer’s last successful result and shows Refreshing. Reader/client/IPC/render tests and real native-worker fixture smoke passed.|
|3.2|All five committed binaries are actual 0.52.0, official archive hashes recorded; Apache licence next to every binary and included by platform packaging filters. Pin/licence/hash/packaging tests passed.|
|3.3|Savings refresh includes projects with >2,000 recorded invocations in rolling hour; project-path notices are refresh-driven. Burst fixtures passed.|
|4|Windows file-link probe succeeded but repo config disables Git symlinks, so CLAUDE is one literal `@AGENTS.md` line and Angular import moved. Copilot 1.0.100 source listing still names two sources; installed raw-content loader confirms the tiny import is not expanded into another AGENTS body. No claim of source-list de-duplication or restarted Harness first-message delivery. Live check remains.|
|5.1|New separate settings module, authoritative defaults and one-off OFF migration, conditional route/nav, worker opt-in transport, empty disabled prompt, machine/ancestor exclusions, independent expiry cleanup.217 observation/Wake targeted tests passed before combined run.|
|5.2|Legacy/duplicate rows under Hidden, “shown” labels and total/distinct/weekly-note summary. Normalized room/content tombstones transactionally survive deletion and forced miner reruns; bridge refuses removed notes. Real SQLite/miner/render/summary fixtures passed.|
|6.1|Six topic registers plus index seed every rejected idea from both October rejected sections and earlier standing list. Each has stance/reason/reopen condition. Global ESTOP is explicitly kept, not falsely seeded as rejected. AGENTS read-before-research line added.|
|6.2|Three read-only normalized-JSONL commands: ceiling replay, composition, polling. Coverage first, >=3 stable source scans, global message-ID deduplication, research exclusion, mix beside ratios, observed/modelled labels and ±3% noise. Ceiling model explicitly excludes compaction/retry/quality effects. CLI test proves filtering/dedup/counts/model/repeats/source immutability.|

## Choices and limits

1. Ordinary project indexes are conservatively retained rather than inventing lost user-open provenance; manifest-size safety remains. Count quota applies to temporary indexes.
2. Dirty work folders may contain ignored credentials, so their contents never enter Git objects. Complete private tar archives include tracked/untracked/ignored data and links, verified by content/permission fingerprints. Git refs retain the baseline plus a manifest/hash binding. Restore opens detached, preserves contents/permissions but not staged status, retains the archive, and refuses overwriting.
3. Windows cannot reliably provide process CWD through this backend: removal fails closed and displays its reason. No platform was falsely certified.
4. Temp cleanup defers while any Codex process is live or visibility is uncertain. This protects orphan children; direct test cleanup fixes the actual leak. No existing temp homes were removed by the worker.
5. RTK cached results survive tab reopen within a running renderer, not app restart. Burst notices refresh with the panel. Source/cache handles stay off-main; source DB remains read-only.
6. Protocol refresh is a source-build gate, not runtime self-modification of a packaged app. The snapshot is current against installed 0.163.0 now.
7. Weekly storage growth is unavailable until a real week-old baseline exists; the implementation never extrapolates an initial scan.
8. No app was restarted because the Phase A safety/restart dependency is real. Live effects on James’s stores and actual provider first messages remain in the livetest document.

## Final worker gates

- PASS: focused combined 52 files / 441 tests, 33.19 s, `_scratch/test-run.pid-10949.log`. Exact invocation list and full output are in the linked command receipt/log.
- PASS: standalone audit-kit CLI test.
- PASS: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`.
- PASS: `generate:aliases`, `generate:ipc`, `verify:ipc`, `verify:codex-protocol`, `git diff --check`.
- PASS: noninteractive Electron native RTK worker smoke; ephemeral fixture/cache/script deleted, receipt `_scratch/rtk-worker-smoke.receipt.txt`.
- NOT RUN by instruction: full test suite. Coordinator verifier must run it and the independent `task-completion-gate`. This is not a live-test deferral.
- PENDING: rebuilt/restarted app and click-time real-data confirmations in `2026-10-20-oct2-housekeeping_livetest.md`.

## Review and corrections

Own review caught and fixed source-replacement/cache identity coupling, missing RTK shutdown cleanup, missing packaged licences, archive directory/ref durability, and unknown unpushed-probe handling. Static checks caught stream-union narrowing and the Angular22 guard-test signature. Combined renderer fixtures exposed a test resource loader feeding the Storage template to the nested work-folder card; it now resolves each actual template, preserving all assertions. All cited final checks passed after these corrections. No verification suppression, assertion weakening or ratchet increases were used.

## Handoff artifacts and cleanup

Plan/history/livetest remain at root absolute paths and untracked; no copies in worktree. Command receipts and work seal are beside them. The seal binds all tracked modifications and new deliverables in the worktree. Independent gate has not run in this worker. No commit/stage/stash/branch/worktree operations occurred. Build runtime cleanup is recorded in the command receipts; pre-existing node_modules is retained.

Cleanup receipt: newly created `dist/` build output removed (`.angular/` was never created) after report/seal/receipts were written; disposable command-runner script removed. Pre-existing `node_modules` retained. No database cluster, browser runtime, dependency install or copied source tree was created by this worker. Test fixture runtimes were removed by their finally/teardown paths.

## Resume revalidation: 23 October 2026

Continued the existing queue checkpoint `c50f4e0c2` against base `542f1f690`; the checkout was clean and all 154 files matched the previous seal. All 20 checklist entries were already implemented. No linked spec or additional unchecked implementation item was found. The existing decisions remain applicable; no new approval was inferred from the old readiness status.

- PASS: exact previous combined focused invocation, 52 files / 441 tests, 87.8 s; zero failed or pending tests in `_scratch/test-results.pid-94485.json`. Full raw output: `_scratch/test-run.pid-94485.log`; command receipt: `resume-focused`.
- PASS: audit-kit standalone CLI test, both type-checks, lint, LOC, main and renderer production builds, IPC verification, Codex protocol freshness, and merge-base-to-HEAD whitespace check. Each current exit code and log hash is appended to `2026-10-20-oct2-housekeeping_commands.jsonl` with a `resume-` name; logs are in worktree `_scratch/oct2-resume/`.
- PASS: aliases and IPC generators rerun; no tracked file changed. Installed Codex protocol remains 0.163.0. All nine Codex temporary homes observed in this run's fixture log were absent afterward.
- Build limit: renderer emits the initial-bundle warning (1.35 MB against the 1 MB warning budget); the build exits 0 within its 2 MB error budget. No budget or verification configuration was changed.
- NOT RUN by explicit queue instruction: full suite. Final `task-completion-gate` acceptance remains the coordinator verifier's responsibility. No completion renaming, staging, commit, stash, branch/worktree change, app restart or real-data cleanup was performed.

Ruling: retain the existing implementation and refresh its evidence rather than repeat completed edits — the seal, acceptance mapping and current checks support the checkpoint; any undiscovered runtime defect remains for the independent verifier and deferred live checks. The plan stays active at its original absolute root path.

Fresh-context review (`handoff_review_fresh`) used `task-completion-gate` and its runbook on `542f1f690..c50f4e0c2`. It found no actionable implementation defects and independently passed 7 files / 53 tests (exit 0; `_scratch/test-run.pid-42472.log`). Review covered all 20 acceptance mappings, architecture/runtime wiring, range-wide test integrity and suppressions, dependencies, security, async/state/resources, performance, and changed UI/migration surfaces. No added skips, assertion-count reductions, exit hacks, unfinished stubs, dependency changes or compiler/test-config weakening were found. The worker alias-bootstrap suppression was justified. Its verdict was **DEFERRED**, because the user reserves the full suite and final gate for the coordinator; this is not `VERDICT: PASS` or integration approval.

Resume cleanup: removed this run's 149 MB `dist/` output and disposable `_scratch/oct2-resume/run-check.py` after writing the report, seal and command receipts. Retained small logs/JSON test reports and the pre-existing dependency installation/Vitest cache. No new browser runtime, dependency install, database cluster, copied checkout, `.angular/` cache or TypeScript build-info file was created. All test-created temporary Codex homes were already removed by teardown.

## Merge conflict resolution: main into queue branch, 23 October 2026

The coordinator merged `main` into `queue/2026-10-20-oct2-housekeeping-e77162`; four files conflicted. Every conflict was
an additive union of two independent main-process lines of work, so both sides' intent was kept in full. No conflict was
semantic: nothing on either side depended on removing the other's behaviour.

- `src/main/app/late-runtime-initialization-steps.ts`: kept main's new `Codex state backup pruning` step and this
  branch's `initializeCodexTempHomeMaintenance()` added to `Stale Codex temp home sweep`. Both imports were already
  merged cleanly; step order keeps main's pruning entry before the sweep.
- `src/main/codemem/codemem-pruner.ts`: import block only. Merged `VacuumFreelistOptions`/`VacuumFreelistResult`
  (main) with `isTemporaryWorktreePath` (this branch). The body already merged cleanly with both `workspaceExists`
  worktree retirement and `CodememMaintenanceOptions.vacuumTimeBudgetMs` intact.
- `src/main/codemem/index-worker-main.ts`: kept both `workspaceExists: existsSync` (retired-worktree pruning) and
  `vacuumTimeBudgetMs` (short vacuum bursts) in the `runCodememMaintenance` options object.
- `src/main/codemem/__tests__/index-worker-main.spec.ts`: kept this branch's `remove-workspace-index` test and all five
  of main's vacuum/WAL/broad-root tests. No test dropped or weakened on either side.

Merge-integrated typecheck fix (not a conflict): `typecheck:spec` failed on two main-side files that were byte-identical
to `MERGE_HEAD` — `src/main/storage/low-disk-space-watcher.spec.ts` and `src/main/storage/scratch-sweep-scheduler.spec.ts`
exposed `mock.calls[0]![0]` on zero-argument `vi.fn()` mocks (TS2493). Fixed by typing the mock parameter as
`NotificationInput`; assertions unchanged. This is a pre-existing main-side typing gap surfaced by the merge, not
introduced by this branch's work.

Checks after resolution (all exit 0): targeted 5 files / 32 tests (`low-disk-space-watcher`, `scratch-sweep-scheduler`,
`index-worker-main`, `codemem-pruner`, `late-runtime-initialization-steps`), `tsc --noEmit`, `typecheck:spec`, lint, and
`check:ts-max-loc`. Resolved files are staged; the merge is left in progress for the coordinator to commit — this worker
did not commit, abort the merge, switch branches, or rename documents. Full suite remains the coordinator's gate.

## Verifier round-1 remediation: 23 October 2026

An independent verifier failed round 1 with two test-gate findings. Both are fixed in this worktree; no other source file
changed, and no assertion was weakened or removed.

1. **Prompt-assembly fixture not migrated to observation memory's opt-in default** (high; `src/main/instance/instance-system-prompt.spec.ts`):
   `DEFAULT_OBSERVATION_CONFIG.enabled` is now `false`, so `PolicyAdapter.buildObservationContext` returns `''` without an
   explicit opt-in; the MEM-4 injection fixture relied on the old default-on adapter, and its `**Auth middleware race**`
   assertions failed (one of the two full-suite failures; 2/17 with the isolation gate in the verifier's focused rerun).
   Fix: the fixture now calls `adapter.configure({ enabled: true })`, exercising opted-in behaviour with every injection
   assertion preserved, and a new companion test pins the migrated default at the same layer — with no opt-in the system
   prompt injects nothing, `queryRelevantReflections` is never called, and the manifest records `skipped-empty`.
2. **Wake tombstone helper expanded the context worker closure to its forbidden limit** (medium; `src/main/memory/wake-context-builder.ts`):
   the helper import pulled `shared/types/wake-hint-summary.ts` into the worker value-import closure, measuring 156 modules
   against `CLOSURE_SIZE_CEILING = 156` with `modules.size < ceiling`. Fix: the graph change is resolved, not waived —
   `normalizeWakeHintContent` moved into `shared/types/wake-context.types.ts`, which the closure already value-imports for
   `DEFAULT_WAKE_CONTEXT_CONFIG`; `wake-context-builder.ts` and the renderer-facing `wake-hint-summary.ts` both take it from
   there. Re-measured with the guard's exact parser: 155 modules (the independently audited merge-base size), with
   `wake-hint-summary.ts` absent and zero Electron value-importers (`_scratch/oct2-resume/closure-postfix.json`). The
   isolation spec's ceiling and every assertion are unchanged; the summary spec still covers case/whitespace normalization.

Verification after the fixes (all exit 0): targeted `instance-system-prompt` + `context-worker-import-isolation` +
`wake-hint-summary` + `wake-context-types` (24 tests); `src/tests/unit/memory/` + renderer knowledge (14 files / 118 tests);
`src/main/observation/` + `src/main/instance/` (207 files / 3,312 tests, containing both previously failing gates);
`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`. Distinct post-fix coverage:
223 files / 3,436 targeted tests. Full suite remains the coordinator's gate per queue instruction. No commit, stage,
branch change or document renaming was performed.
