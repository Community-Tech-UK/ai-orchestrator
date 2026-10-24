# REPORT-runtime — FINAL implementation-helper handoff

Scope: Phase D Steps 9/14, exact AIO checkout `.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`. Updated 21 October 2026. Root plan/history were neither edited nor copied. This continuation ran no commits, stashes, branches, worktrees, full suite, GUI, browser, new agents or paid probes. Main owns combined canonical gates, root documentation, independent review, sealing and cleanup. This report makes no independent PASS or coordinator-completion claim.

## Final source status

All eight original runtime review items have source and focused test coverage. The remaining permission-card YOLO action gap is now implemented and exercised through the actual Angular component/template. There are no remaining runtime-source TODOs being deferred to live tests. Combined worker type failures are reported separately below for main.

### This continuation: four source/test paths

- `src/renderer/app/features/instance-detail/user-action-request.component.ts`: both YOLO branches enter the cost gate before the existing action. Deferred permission still calls `respondToInputRequired` with the original request ID, tool-use ID, scope and `enableYolo:true`; the separate branch still calls `toggleYoloMode` for the original instance. No permission/secret transport changed.
- `src/renderer/app/features/instance-detail/user-action-request.component.html`: visible pre-click cost sentence beside permission controls; shared yes/no component holds a large change; YOLO disabled while preview/confirmation is pending.
- `src/renderer/app/features/instance-detail/user-action-request.yolo-cost.ts` (new): small helper using existing runtime-preview IPC and shared YOLO request construction. A fresh click preview holds `large:true` for yes; small/unavailable notes proceed. It rechecks request-object membership, selected instance, session IDs, restart/adapter generation, status, account/runtime identity and YOLO state before applying. Preview responses and held callbacks expire on scope change or component destruction. Secret/question/denial cards cannot use this action. Previews contain runtime settings only, never tool inputs, answers or secrets.
- `src/renderer/app/features/instance-detail/user-action-request.yolo-cost.spec.ts` (new): 30 actual component/template flow cases across deferred-permission and separate-toggle branches: pre-click copy, large hold, cancel/no action, yes/exact original action, small/missing note, stale preview after selection/request/session replacement or destruction, stale confirmation, and refusal of secret/question/denial requests.

Existing `user-action-request.component.spec.ts` was not edited. Component: 1031 lines; helper: 79. LOC gate passed without ceiling changes. Parent-preserved erased `PromptSurface` type / worker-closure work in `src/main/rlm/llm-service.ts` was not changed.

## Original eight-item review disposition

| # | Final source behavior | Evidence |
|---|-----------------------|----------|
| 1 | Success requires compact boundary + result subtype success without error + exit 0. Missing/truncated/error results fail. | Native module spec; M4 rejects missing-result acceptance. |
| 2 | Deadline 10 min, kill grace 10 sec, exited-without-close grace 2 sec. Prove warm retirement before compactor, compactor retirement before warm restore. Stranded writers block new spawns. | Module/flow/adapter specs; M3 rejects removal of stranded-writer guard. |
| 3 | Drain stderr without retaining it; cap per-line NDJSON buffer at 4 MiB and skip overlong lines. | Native module spec. |
| 4 | Termination generation survives prepare/status awaits. Pending sends/turns/permission/deferred/background/self-wakeup work blocks destructive compaction; refusal cannot fall through to restart. | Adapter/flow/async-work/bookkeeping/runtime/coordinator specs; M1/M2/M5 reject recheck/cancellation/refusal regressions. |
| 5 | Settle reported spend even on failed compaction, record once, avoid charging again on next turn/resume. | Adapter/flow/bookkeeping/runtime specs; M7 rejects success-only settlement. |
| 6 | Claude native occupancy is explicitly unknown until a measured reply. Local factory exposes native hooks; remote/proxy have none and advertise supportsNativeCompaction:false, retaining summary-restart fallback. | Bookkeeping/runtime/message-format/factory wiring specs; M6 rejects old reading reuse. |
| 7 | Seven runtime flags accounted for below; actual permission-card gap closed here. | Cost/runtime-preview/IPC/controller/component coverage. |
| 8 | Claude adapter 2118 lines, below allowed 2121; native logic extracted into small modules. | Current LOC exit 0; no ceiling changes. |

Original source retained: `src/main/cli/adapters/{claude-native-compaction.ts,claude-native-compaction-flow.ts,claude-cli-adapter.ts,claude-cli-async-work.ts}`, `src/main/app/{compaction-runtime.ts,native-compaction-bookkeeping.ts}`, `src/main/context/compaction-coordinator.ts`, `src/shared/utils/{context-usage-sources.ts,runtime-change-cost.ts,replay-carryover.ts}` and their focused specs. Runtime-owned remote/proxy assertions live in `src/main/cli/adapters/__tests__/adapter-factory-claude-compaction.spec.ts`.

The four mutation-last-touch files were checked byte-for-byte against `mutation/*.orig`: `claude-cli-adapter.ts`, `claude-native-compaction-flow.ts`, `claude-native-compaction.ts`, `compaction-runtime.ts` all MATCH. No restore/write of them was necessary here. Prior runtime PID 41996 is absent (`os.kill(pid,0)` existence check, no signal sent); no pending prior runtime writer remains.

## Step 9 wiring rechecked

1. **Loops:** `default-invokers.ts` registers `registerLoopSleepContext` with the real persistent-adapter map and borrowed-chat set. Scheduled sleep / resuming provider-limit events request reset for large Claude sessions sleeping past the measured/default cache lifetime. `LoopCoordinator` consumes reset on the next iteration; the actual invoker awaits `recyclePersistentLoopAdapter`, terminates the previous adapter and clears persistent/tracking maps before replacement. Terminal cleanup awaits/deduplicates teardown. Borrowed chats hand scheduled sleeps to pre-sleep compaction, never quota parks.
2. **Automations:** late runtime initialization calls `setupPreSleepContext`. Automation changes feed enabled thread wake-ups to `PreSleepContext.note`; busy chats retry on instance:idle, removed chats are forgotten. Background work/self-wakeups inhibit compaction. System/provider-limit actions, non-local sessions and unknown/insufficient occupancy are excluded. The automation runner also notifies the same service for its next known wake-up.
3. **Queue:** `plan-queue-item-flow.ts::parkUnlocked` awaits `stopInstance` for worker/verifier before checkpointing. `stopInstance` untracks/unregisters and awaits `terminateInstance`. Parking retains no warm session to compact; Resume starts a new worker. Exhausted accounts make no paid compaction call.
4. **Idle hint:** runtime-mounted `IdleCacheHintComponent` checks every minute and suppresses for scheduled wake-ups, attached active/paused/parked loops, wait reasons, self-wakeups, background work and permission dialogs. Pure/component tests exercise 75-minute/100K thresholds without a manual 75-minute wait.
5. **Compact now:** current tests cover strict success, bounded retirement, cancellation through async windows, queued-send preservation, work refusal, failed-call spend, unknown occupancy and unsupported remote/proxy fallback. No architecture expansion.

Existing summary-restart and Codex compaction retain their previous flagged-estimate occupancy behavior; the requested Claude native route uses explicit unknown occupancy.

## Step 14: seven runtime-diff flags

| Flag | Before the actual action | Confirmation |
|------|--------------------------|--------------|
| provider | Header/composer picker cost note | Shared large-replay/context-loss confirmation. |
| model | Both picker cost notes | Large replay or native-resume full-price re-read. |
| reasoning | Both picker cost notes | Large replay where selected continuity requires it. |
| local-model target | Both picker cost notes | Large replay, with available target-window facts. |
| auto-approve | Header toggle sentence; permission card visible sentence | Header disable large gate; enable existing cost-bearing confirmation. Both permission-card branches now hold large changes for yes. |
| Copilot account | No renderer live account-change control exists; pure diff/cost/preview support present. | Truthful n/a for live controls; no invented control. |
| account profile | Chip fetches cost before switchSession. | Already gated: existing globalThis.confirm contains the cost sentence and cancel returns without switching. Interim report wording “not gated” was wrong; no chip redesign needed. |

Carryover uses the target window where known and actual bounded replay digest (`replay-carryover.ts`, about 8.6K maximum). Replay is not represented as a full transcript resend. Large replay means >=100K tokens left behind; large native model/account re-read means >=100K tokens at full price. Renderer imports shared pure code; no renderer-to-main value import introduced.

## Current verification receipts

Paths below are under `_scratch/oct2-phaseD-round2/` unless otherwise stated. Commands redirected full logs and propagated true exits; no head-pipe used for this continuation's checks.

| Check | Actual result | Receipt |
|-------|---------------|---------|
| Behavioral regression before fix | 16/20 failed, exit 1: missing copy/confirmation and immediate original actions reproduced. Earlier resource-loader setup error was corrected before this behavioral red run. | runtime-yolo-red.log; full `_scratch/test-run.pid-21004.log` |
| First new/existing component batch | 2 files / 45 tests passed, exit 0, before additional safety cases. | runtime-yolo-green.log; full `_scratch/test-run.pid-25677.log` |
| Final focused runtime/UI/Step9 batch | **27 files / 356 tests passed, exit 0**, including all 30 new component flows, existing permission/secret/rules/OpenCode cases, cost/IPC/controller/picker checks, native compaction, sleep and idle. | runtime-final-helper-focused.log; full `_scratch/test-run.pid-35880.log` |
| Restored Claude adapter family | **43 files / 509 tests passed, exit 0.** Old family log was actually red on the stale native-compaction capability expectation; earlier helper fixed it and reran the 69-test file. This continuation reran the entire family for current green evidence. | runtime-final-helper-claude-family.log; full `_scratch/test-run.pid-60486.log` |
| Actual invoker/automation/queue/capability/message-format wiring batch | **6 files / 308 tests passed, exit 0.** | runtime-final-helper-wiring.log; full `_scratch/test-run.pid-38458.log` |
| Renderer production build after template change | Exit 0, Angular AOT/templates compile; existing initial-bundle warning (1.35 MB vs 1 MB) remains. | runtime-final-helper-renderer-build.log |
| ESLint: changed component TS/HTML + both new files | Exit 0, no findings. | runtime-final-helper-eslint.log |
| Current LOC | Exit 0; component 1031, helper 79, Claude adapter 2118, header 700, shared instance types 900. | runtime-final-helper-loc.log |
| npx tsc --noEmit | **Exit 2**, unrelated combined worker graph: `src/worker-agent/worker-instance-telemetry.ts:25`, SessionPolicyRecord.configKeys string[] incompatible with contract literal-key array. No error in this continuation's files. | runtime-final-helper-types.log |
| npm run typecheck:spec | **Exit 2**, same telemetry error plus `src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts:114`, inferred cliType:string incompatible with CliType. Main/remote-policy integration work, not live-test deferrals. | runtime-final-helper-spec-types.log |
| Diff whitespace, changed tracked component files | Exit 0. | git diff --check -- the two component paths |

Main must resolve/recheck combined worker types and run final canonical gates. This helper did not run the full suite, combined final lint/build-main or independent completion review, as instructed.

### Historical receipts actually inspected

Read only Bash command/result metadata in `runtime-finalization.jsonl` and scratch logs, never dumped the full transcript. Earlier context/runtime/continuity batch: 56 files / 724 tests, exit 0 (`main-area-tests.log`, full `_scratch/test-run.pid-58573.log`). Earlier instance-detail/models/account batch: 98 files / 1004 tests, exit 0 (`renderer-area-tests.log`, full `_scratch/test-run.pid-60745.log`). Earlier types/spec-types/changed-file lint/LOC/renderer build were green at that revision; current worker type failures above supersede old type-green claims. The new receipts cover this continuation's changes.

### Seven original mutation receipts

| Mutation | Rejected by tests |
|----------|-------------------|
| M1 drop post-await live-work recheck | 7/43 failed, exit 1 |
| M2 cancelled always false | 2/22 failed, exit 1 |
| M3 remove stranded-writer spawn guard | 2/22 failed, exit 1 |
| M4 accept missing result | 3/28 failed, exit 1 |
| M5 swallow refusal into fallback | 1/14 failed, exit 1 |
| M6 reuse old occupancy | 1/14 failed, exit 1 |
| M7 settle spend only on success | 4/43 failed, exit 1 |

Logs: `mutation/M1-drop-recheck.log`, `M2-never-cancelled.log`, `M3-no-stranded-guard.log`, `M4-missing-result-ok.log`, `M5-no-refusal-rethrow.log`, `M6-old-reading-after-compact.log`, `M7-spend-only-on-success.log`. Four last-touch source files MATCH their saved originals now; current focused/family green runs followed that check. No new mutations were needed.

## Genuine live checks still unrun

Main owns recording these in root live-test docs. No locally testable source check is being deferred; combined worker types above are local integration work. The following require a rebuilt running Harness, real provider processes or Windows-worker GUI and were not attempted under this helper's constraints:

1. Rebuilt Harness, quiet local Claude CLI >=2.1.304: Compact now keeps provider session ID, leaves occupancy unknown until the next measured reply, sends a message typed during compaction exactly once, never respawns a closed session, and refuses real live background/self-wakeup work. This checks real child-process timing and provider billing beyond mocked tests.
2. Disposable real scheduled Claude chat/loop: eligible local chat compacts before a long sleep, persistent loop recycles on the next iteration, quota park makes no compaction call. Event and teardown seams are already covered locally; this checks real scheduler/provider integration.
3. **Windows windows-pc Browser Gateway only:** visually verify picker notes/large holds, header YOLO, both permission-card branches, and account-switch cost-bearing confirmation in the installed Harness. Cancel leaves process/request intact; yes invokes original action once. Component/template tests and production build already pass. Never use local Mac GUI.
4. Actual worker/remote Claude Compact now uses summary restart and advertises no native callable compaction. Local factory/adapter tests already prove capability selection; this checks a real worker connection.

A 75-minute manual idle wait is not necessary for source acceptance: threshold and pending-work suppression already have pure/component evidence. No live verification, new paid CLI evidence or independent PASS is claimed.

## Exact runtime cleanup paths — main owns seal/cleanup

Earlier probe leftovers still exist; this continuation did not delete them. Under this exact worktree:

- `_scratch/oct2-phaseD-round2/compact-probe-runtime/`
- `_scratch/oct2-phaseD-round2/compact-probe-out/`
- `_scratch/oct2-phaseD-round2/compact-probe-summary.json`
- `_scratch/oct2-phaseD-round2/compact-probe.stderr`
- `_scratch/oct2-phaseD-round2/adapter-compact-probe.out`
- `_scratch/oct2-phaseD-round2/adapter-compact-probe.err`
- `_scratch/oct2-phaseD-round2/probe-scripts/`
- `_scratch/oct2-phaseD-round2/claude-cli-adapter.ts.bak` (old draft, **do not restore**)
- `_scratch/oct2-phaseD-round2/mutation/` (four originals, mutation script, seven logs; retain until evidence sealed)
- `_scratch/oct2-phaseD-round2/tsc-runtime-{1,2,3,4}.log`
- `_scratch/oct2-phaseD-round2/tsc-spec-runtime-{1,2}.log`

Earlier throwaway Claude project store outside worktree, verified still present:

`/Users/suas/.claude/projects/-Users-suas-work-orchestrat0r-ai-orchestrator--worktrees-queue-2026-10-20-oct2-phased-tokens-0e371d--scratch-oct2-phaseD-round2-compact-probe-runtime/`

Preserve evidence until sealing: REPORT-runtime.md, review-notes-runtime.md, runtime JSONL/stderr artifacts, `runtime-yolo-{red,green}.log`, `runtime-final-helper-{focused,wiring,claude-family,types,spec-types,eslint,loc,renderer-build}.log`, referenced `_scratch/test-run.pid-*.log` and matching `test-results.pid-*.json`. Quiet-test caches/temp output is disposable after evidence capture.

Renderer build changed generated `dist/renderer/`. Neither `.angular/cache/` nor `node_modules/.cache/angular/` exists at the final path check, so no Angular-cache deletion is requested. Main owns shared generated-output snapshots (`dist-before-hashes.json`, `angular-before-hashes.json`, `node_modules_cache-before-hashes.json`) and must reconcile generated output with final builds. No branch/worktree cleanup needed for this helper; do not remove other helpers' evidence or source.
