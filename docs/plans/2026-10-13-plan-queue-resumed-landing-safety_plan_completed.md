# Plan Queue resumed landing safety

Status: Verification round 1 failed on the linked-install manifest mismatch. Worker remediation on 2026-10-13 reproduced that failure, provisioned an independent worktree install, and passed the unchanged dependency spec, queue regressions and all six non-suite canonical gates. Ready for the assigned Queue verifier to rerun the full suite and independent gate. The exact five-file payload remains unchanged and matches the previously reviewed repair. Integration and completion rename remain coordinator work. Installed-app activation is deferred in the linked live-check document; no live activation or safe-continuation claim is made.

## Purpose and reproduced defect

Keep October plan-queue work intact when a parked item resumes. Independent public-tool reproduction through the coordinator, worker checkpoint, verification and real scratch Git showed that a saved squash candidate survives a later repair at the same base. A fresh PASS then promotes the old candidate, omits repaired code and current closed-document evidence, and deletes the repaired branch. Current source and compiled main code both reproduce it; the exact running application's imported code is not confirmed.

Evidence: `_scratch/oct-queue-recovery/queue-resume-landing-audit/` (original evidence must remain unchanged).

The active October run remains paused. The user's three original overlapping edits stay in place until the repaired queue and Phase 0 pass their independent gates. Never edit live queue metadata, manually merge or move queue refs, or bypass its normal integration flow.

## Implementation

1. Clear the saved landing candidate and previous verification result when the parent explicitly resumes an item.
2. Clear a saved candidate when the coordinator records a different branch checkpoint, including reattachment that discovers a changed branch head. Keep the candidate for an unchanged checkpoint so interrupted landing retries remain idempotent.
   Clear the candidate when entering every new verification round as well. This protects old-runtime working and awaiting-slot rows, including document-only changes whose branch checkpoint stayed unchanged. An interrupted landing stays in the landing stage and keeps its candidate.
3. Re-run the actual public-tool reproduction against the fix, using new scratch fixtures. Verify repaired code and refreshed documents land, hooks rerun, and overlaps still refuse promotion. Check document-only resume, branch change before reattachment, already-working recovery, unchanged crash retry, and moved base.
4. After runtime verification, add regression coverage without weakening existing assertions or changing test configuration.
5. Run focused checks and all canonical gates on the current checkout, with full logs retained. Obtain a genuinely fresh task-completion-gate PASS covering this repair and the unrelated-dirty baseline.
6. Deferred installed-app validation: [live-check document](2026-10-13-plan-queue-resumed-landing-safety_livetest.md).

## Acceptance

- A resumed item never promotes a candidate from the previous work/evidence round.
- Changed checkpoints invalidate the candidate even for an item resumed before the fix loaded.
- Reattachment cannot hide a changed head by replacing the checkpoint baseline first.
- Unchanged crash recovery retains its candidate and runs the landing hook once.
- New repairs and document evidence reach the resulting base commit together.
- Dirty overlapping root paths and repaired parked branches remain protected on refusal.
- Current normal verification and independent fresh code review pass. Deferred installed-app checks are recorded in the live-check document.

## Progress

- [x] Independent source and compiled-code reproduction, with control scenarios.
- [x] Existing original overlapping edits preserved; October run paused.
- [x] Production repair and public runtime checks (three production files; source and rebuilt compiled execution).
- [x] Regression coverage (new real-Git coordinator and worktree cases; existing assertions preserved).
- [x] Final canonical verification after the extra verification-boundary safeguard (all seven actual exits zero; retained `final-parent-verification.json`).
- [x] Independent completion gate: genuinely fresh `VERDICT: PASS`, no unresolved actionable repair findings.
- [x] Normal queue worker intake of the exact reviewed payload, with current focused tests, static checks, builds and source/compiled runtime evidence.
- [x] Verification-round-1 dependency finding reproduced and remediated with a real worktree install; unchanged dependency spec, queue regressions and six non-suite canonical gates pass.
- [ ] Assigned Queue verifier's current full canonical verification and independent verdict, followed by normal coordinator integration and closure.

Deferred installed-app checks: [live-check document](2026-10-13-plan-queue-resumed-landing-safety_livetest.md).

## Current evidence and limits

Runtime evidence: `_scratch/oct-queue-recovery/queue-resume-landing-audit/patched-verification-boundary-runtime.md`, with new source and compiled public-path runs. The earlier runtime report's legacy document-only limit is superseded by this new verification-boundary proof; old evidence remains unchanged.

Parent command receipts and original-work preservation manifest: `_scratch/oct-queue-recovery/queue-resume-landing-repair/`. Only five repair production/test paths changed. Each was byte-identical to HEAD before this repair; the unrelated dirty files, root HEAD and index remain unchanged.

The first full test run passed before the extra safeguard. Focused regression tests, main build, production/spec type checks, focused ESLint, canonical lint, size check and renderer build pass with the safeguard. The final uncached, unfiltered full suite also exits zero (257.03 seconds). The five repair sources, root HEAD and index stage entries stayed unchanged during those checks. A genuinely fresh `task-completion-gate` independently returned `VERDICT: PASS` on an exact standalone HEAD-plus-five-file fixture: all seven canonical gates, additional architecture/IPC/exports/contracts/native checks, focused real-Git tests, and source/compiled public scenarios pass with zero unresolved actionable repair findings. Full evidence: `_scratch/oct-queue-recovery/queue-landing-safety-fresh-gate/review.md` (SHA-256 `fcb80f1b4c7a37b348df535a51eb9a7dd42a1a9c2fc37006af49ab6e92dffcc6`).

The additional architecture check exits 1 on three imports in two pre-existing dirty renderer test files. Both files match the preserved pre-repair manifest exactly. Those unrelated diagnostics were not changed or suppressed; they must be classified separately by the independent reviewer.

Read-only process/package inspection confirms the running process opens `/Applications/Harness.app/Contents/Resources/app.asar`, whose main entry is `dist/main/main-process-entry.js`. Extracted installed queue code lacks the candidate invalidation changes. Rebuilding root `dist` has not activated the fix in that installed process. No installed package, live queue row, database, branch, worktree or root index was manually changed.

The normal local build and signed packaging pipeline pass. The prepared app signature and helper identity checks pass, and its three queue module hashes equal the exact compiled modules executed by the runtime probes. Package receipts and artifact manifest are beside the parent checks. Installation/restart remains unperformed and is recorded solely in the active live-check document.

The independent review disclosed two initial isolated-fixture setup failures and corrected them without changing task code. Before fixture Git metadata existed, an existing inventory unit test may have added an unreachable synthetic blob to root Git objects through its temporary index. No root staging/ref/checkout change occurred; no object cleanup was attempted. Original source, HEAD and stage entries are verified preserved. The initial raw-index hash comparison was invalid because the manifest records stage-entry hashes, not raw index bytes; the corrected comparison and original records remain in review evidence.

## Normal queue worker intake

This bounded repair is required to continue the ten October plans safely. The parent uses normal `plan_queue_start` for this document, rather than manually committing or merging the root repair.

The exact reviewed five-file payload is frozen at ROOT `_scratch/oct-queue-recovery/queue-resume-landing-repair/verified-source-payload/`, with `manifest.json`; the patch is `repair.diff` beside that folder. It contains only the three production and two adjacent test files named by the manifest. Before applying, fully read those supplied-worktree sources, relevant callers/types/tests and this plan. Verify their baseline corresponds to original HEAD `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`; do not overwrite unexpected changes or copy unrelated root dirty work.

Apply that payload in the supplied AIO-managed worktree, validate all five hashes match, and run applicable focused tests, direct five-file ESLint and all canonical gates with Node 24.15.0 pinned. Retain exact commands/exits/raw logs. A new different fresh code gate is required if any code differs from the already reviewed payload. The normal assigned Queue verifier still independently checks the exact current tree and reports via its caller-checked tool. Parent preservation of the five root repair files permits only normal AIO integration after the evidence is current. The original three unrelated Phase 0 overlap edits stay in place throughout.

Keep this plan and the live-check document at their active untracked root paths during implementation. Update as-built intake notes and the live document's link to this plan's eventual `_plan_completed.md` name before the normal coordinator closes this code plan. Do not copy the active plan or pending live checks into the worktree or stage them. AIO alone owns safety commits, refs, merge, completion rename and cleanup. No live SQLite writes, installed-app edits, restart, browser/desktop action, paid provider experiment, credential access or other-plan implementation is part of this intake. The pending live document remains open after code integration.

## As-built normal queue worker intake — 2026-10-13

Worktree: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-plan-queue-resumed-14f579`, branch `queue/2026-10-13-plan-queue-resumed-14f579`. Initial HEAD was exactly `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`, the initial tree was clean, and each of the five target files was byte-identical to that baseline. Applied only `repair.diff` from the frozen payload after reading the complete target files, queue callers/types/recovery/landing paths, adjacent tests and architecture. All five final SHA-256 values match `verified-source-payload/manifest.json`; no implementation deviation or test-configuration change was made. This bounded repair has no linked task spec; the original queue specification was read as architecture context and remains unchanged.

The public-tool baseline reproduction exited 1 at the expected repaired-landing assertion: the old candidate was promoted, `repair.txt` was absent, the old document evidence landed, the hook ran only once, and the repaired branch was deleted. Applied production changes before importing the reviewed regression tests, then ran all 11 public-path scenarios against source and rebuilt compiled modules in new scratch fixtures. Both runs exited 0: repaired code and updated evidence land together, changed-head reattachment and legacy working/awaiting-slot recovery clear candidates, document-only verification refreshes evidence, overlap refusal preserves the repaired branch and operator file, and unchanged landing crash retry reuses its candidate with one hook run. Loaded source hashes match the manifest; the three executed compiled hashes also match the earlier reviewed compiled repair.

Current worker verification used Node `v24.15.0`, pinned via `/Users/suas/.nvm/versions/node/v24.15.0/bin` for every command. All commands below exited 0:

- `npm run test:quiet -- src/main/plan-queue/plan-queue-coordinator.spec.ts src/main/plan-queue/plan-queue-worktree.spec.ts src/main/plan-queue/plan-queue-landing.spec.ts src/main/plan-queue/plan-queue-squash.spec.ts src/main/plan-queue/plan-queue-doc-close.spec.ts src/main/mcp/plan-queue-tools.spec.ts`: 118/118 tests across six files; uncached run, raw Vitest log and JSON report retained.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, direct ESLint of all five payload files, and `npm run check:ts-max-loc`.
- `npm run build:main` and `npm run build:renderer`.
- `npm run generate:aliases`, `npm run generate:ipc`, `npm run verify:ipc`, `npm run verify:exports` and `npm run check:contracts`; generated tracked files remain unchanged.
- `git diff --check`; final author review of the complete diff found no blocking issue. This review is not an independent completion-gate verdict.

Evidence directory (absolute): `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-plan-queue-resumed-14f579/_scratch/queue-resumed-intake-20261013-14f579/`. Every verification command has a `.json` receipt with its exact command, cwd, exit and duration, plus its raw `.log`. `worker-handoff.md` records the acceptance mapping and review; `payload-identity.json`, `source-scenario-results.json`, `dist-scenario-results.json`, runtime module manifests and Git logs, and `preservation-before.json` / `preservation-after.json` retain identity and no-loss evidence. The root HEAD, root stage entries and every initially dirty tracked root file remained unchanged. Only the five payload paths differ in the worker checkout, with nothing staged and HEAD unchanged by this worker.

Ruling: the current Plan Queue worker instruction explicitly reserves the full suite for the assigned verifier, overriding this plan's older instruction that the worker run all canonical gates. The six non-suite canonical gates and all focused/runtime checks were run here; the current full suite and fresh independent Queue verdict remain open above, not deferred as a live check or claimed by this worker. No new fresh review of different code is needed because the payload is exact, but the assigned Queue verifier must still judge this actual tree and report through its caller-checked verdict tool. The coordinator owns checkpointing, integration, rename and cleanup. No live queue controls, metadata writes or installed-app actions occurred.

## As-built verification-round-1 remediation — 2026-10-13

Resumed at coordinator checkpoint `aed8dbf27096f416e65899a98d8c46f4cff679af` with a clean working tree. The merge-base-to-HEAD diff still contains exactly the five reviewed repair files. The verifier reported one failure among 30,738 tests: `scripts/__tests__/dependency-compatibility.spec.ts` rejected dependencies linked from the root checkout because both root manifests differ from this branch. A fresh uncached focused reproduction confirmed the exact assertion: 4/5 tests passed, 1 failed, exit 1. The test correctly fails closed; neither it nor the manifests, test configuration or task code needed modification.

Environmental remediation: moved only this worktree's ignored per-entry-linked `node_modules` directory to `_scratch/queue-resumed-dependency-remediation/linked-node_modules-before/`, then ran `npm ci --ignore-scripts --no-audit --no-fund` in this worktree against its existing lockfile. Ran dependency lifecycle scripts through an explicit `npm rebuild --foreground-scripts` package list, with Puppeteer browser downloads disabled, followed by the repository's `npm run rebuild:native`. The explicit lifecycle list includes every non-root package marked `hasInstallScript` in the lockfile; the root postinstall's shared Git configuration/global-ignore writes were unnecessary and were not run. The new install marker is a real file at this worktree's `node_modules/.package-lock.json`; dependencies now resolve within this checkout. Its only top-level/scoped package symlinks are the three local npm workspaces (`archiver`, contracts and SDK). The include helper preserves an already-present dependency directory, so ordinary include handling will not replace this install with root links.

Current remediation verification used Node `v24.15.0`, pinned for every command. All post-remediation commands exited 0:

- Unchanged dependency-compatibility spec: **5/5 passed**, uncached, versus the recorded pre-remediation exit 1.
- The same six queue/MCP focused specs listed above: **118/118 passed**, uncached.
- `npx tsc --noEmit`, heap-aware `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main` and `npm run build:renderer`.
- `npm run generate:aliases`, `npm run generate:ipc`, `npm run verify:ipc`, `npm run verify:exports` and `npm run check:contracts`; generated tracked files remain identical to HEAD.
- Native rebuild and `node scripts/verify-native-abi.js`: the worktree's `better-sqlite3` binary matches Electron 40.10.6, ABI 143.
- `git diff --check`, reviewed-payload hash comparison and before/after preservation checks: worktree HEAD/index/manifests and clean tracked state, root HEAD/index, every initially dirty tracked root file, and sampled root dependency marker/package/native-binary hashes remain unchanged. All five source hashes still match the frozen reviewed manifest.

Evidence directory (absolute): `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-plan-queue-resumed-14f579/_scratch/queue-resumed-dependency-remediation/`. Each command has an exact-command/exit/duration JSON receipt and raw log; the three focused test runs also retain copied raw Vitest logs and JSON reports. `remediation-summary.json` maps every result and preservation assertion; `preservation-before.json` and `preservation-after.json` retain the underlying values. The source diff and test-integrity review found no new code change or suppressed assertion: this round changes only ignored local dependencies/evidence and this active untracked root plan.

Handoff: the single reported environmental finding is addressed and its original failing spec now passes. **The full suite and fresh assigned Queue verdict still require the verifier's rerun**; this worker did not run the full suite or claim independent PASS. Use the independent install already present in this exact worktree. No commit, stash, branch/ref change, worktree creation, plan rename, live metadata operation or installed-app action was performed. The active plan remains untracked at its original root path; the existing live-check document remains open and unchanged.

## Assigned verifier round 0 environment failure — parent preservation note

The assigned verifier's uncached full suite failed exactly one installed-dependency compatibility assertion: the supplied worktree's dependency marker resolves to the root checkout, while both package manifests differ. Retained raw evidence is ROOT `_scratch/oct-queue-recovery/queue-resume-landing-repair/assigned-verifier-round0/`; its structured result reports 30,730 passed, one failed and seven existing pending tests. This is an actual failed gate, not a waived success. The verifier has returned the item to normal fixing.

Repair the supplied worktree's installation from its own unchanged lockfile. Do not copy the root's dirty manifests, modify dependencies or compatibility assertions, suppress the failing test, or alter the root/shared dependency tree. Use a real local dependency tree, lockfile-exact installation with lifecycle scripts disabled as appropriate, then explicit fixture/worktree Electron setup and the native-module runbook; preserve any AIO-included dependency links through ordinary supported worktree installation handling. The original frozen five-file source hashes must remain exact. Reproduce the failed compatibility test after setup, rerun applicable focused/static/build verification, and return to the assigned independent verifier for the real full suite. The parent has saved and cleared only its own five repair files back to their original baseline to permit normal AIO promotion after a current PASS; all other root work, including the original three Phase 0 overlap edits, remains in place.
