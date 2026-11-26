## Snapshot of 2026-10-27-campaign-defects-runtime-followup_history.md

# Campaign defects runtime follow-up: history

## Round 5 resume (26 Nov 2026): usage-limit wait

Resumed after waiting for provider usage. No unticked plan items remained. Findings:

- Branch `queue/2026-10-27-campaign-defects-ru-fb7243` HEAD `4e23f5f36`, base `73ff52bef`; main has moved far ahead
  and already holds the hand-merged code (`67adab3ec`). `git merge-tree HEAD main` reports conflicts in
  `codex-app-server-turn-adapter.ts`, `instance-list-load-failure.component.spec.ts` (add/add) and
  `instance-list.component.ts`; no source change was made here, landing should keep main's versions.
- Checks on the branch: `npx tsc --noEmit` exit 0; `npm run typecheck:spec` clean; `npm run lint` all files pass;
  `npm run test:quiet` on five focused files (crash-recovery readiness, claude interrupted result, codex provider-turn
  follow, rail load-failure component, instance-list store) 94 tests pass.
- Live acceptance: 12 Nov queue run (`_evidence/2026-11-12-queue-b66c0914/report.md`) passed all sections except
  "genuine failed completion stays an error" (no safe real provider failure available); that stays open in the `_livetest.md`.
- Not run: full suite, builds, new live checks (verifier / live-test owners).


  termination; queued and in-flight publication/reconciliation now honor lifetime epochs.
  Actual adapter/runtime tests cover fourteen-turn bursts, seeded chunk boundaries,
  missing/duplicate terminals, subsequent sends/steering, interrupt, compaction and teardown.
- LT-719: typed persistent list-load failure reaches a real rail alert with readable
  wording, technical Details and a keyboard-usable Try again button. Complete successful
  snapshots clear it; live events and unrelated create/restart errors cannot hide it.
  Tests execute the real rail/store and real IPC response shape, including startup retry,
  persistent failure, focus retention, duplicate-click protection and successful recovery.
- LT-720: replaced the incompatible Vite7 override with ~8.3.3, generated the lock
  selecting8.3.5 and installed it in this worktree. Angular build22.2.1 declares8.3.0;
  this stays on the compatible minor while accepting security fixes. Default prebundling,
  angular.json and production bootstrap are unchanged. The actual builder-resolved Vite
  guard is red on7.3.7 and green on8.3.5. The final ordinary served-module crawl fetched
  175 modules with zero failed fetches/bare imports/unlinked declarations; all seven
  Angular dependency entries evaluate without importing the JIT compiler. Before repair,
  six of seven failed and ordinary serving exposed543 unlinked declaration calls.
- LT-671/LT-672/LT-721: implementation details above remain the as-built design. Final
  native RLMDatabase worker trials on the corrected dependency install pass five fresh
  profiles and restarts; this is not the actual app/context-worker IPC acceptance.

Historical focused verification before queue review:106 files/1194 tests pass, including both native Claude
Stop reasons after the first fresh review reproduced the missing aborted_tools case. Both TypeScript checks, Angular
and fast lint, LOC/UI hint checks, architecture checks, alias/IPC generation, main/preload
build, production renderer build, build dependency audit and package exports all pass.
Generators produced no tracked drift. The renderer retains its existing1MB initial-bundle
warning (1.64MB); no threshold was changed. Raw npm audit exits1 for32 moderate advisories,
zero high/critical and no Vite advisory; the repository's build-audit policy exits0.

Retained handoff: [report and receipts](2026-10-27-campaign-defects-runtime-followup_evidence/2026-10-31-runtime-repairs/report.md).
Fresh read-only review result and final cleanup receipt will be recorded there. Exact
remaining provider/rebuilt-application checks are in
[live acceptance](2026-10-27-campaign-defects-runtime-followup_livetest.md). No full suite,
real Claude/Codex campaign, installed app, actual context-worker app startup or interactive
browser is claimed here. Full suite and independent completion-gate PASS belong to the
queue verifier. The older LT-683 register index/detail disagree; their labels are not
new acceptance evidence and were not rewritten by this repair.

Fresh review follow-up: the initial independent read-only pass found that installed
Claude also uses `aborted_tools` when Stop interrupts a tool. Direct inspection of the
installed2.1.314 binary confirmed its two-reason stopped helper. Three new parser/ingress/
classifier cases failed before the additional token and pass after it; both arbitrary
source-text negative cases and genuine execution-error rejection remain covered. The
exact live check now exercises Stop during streaming and during a tool. A sixth live
section explicitly records actual renderer first paint under normal prebundling, because
served-module evaluation does not claim an app window was observed. Current as-built
notes for LT-683/719/720 above supersede the initial review's earlier document snapshot.
The second fresh read-only review returned READINESS REVIEW: PASS with no source,
test or documentation blockers. It independently traced the six executing repairs and
checked test integrity, dependencies, async ownership, security and UI wording. It ran
no commands and is not the full completion gate. The coordinator still owns full-suite,
clean-state and live acceptance verification; no full verifier PASS is claimed.
Report, command receipts, source fingerprints, both review outcomes and the evidence
seal are retained beside this plan; cleanup has a separate receipt. No document was
renamed, staged or committed.

