# POSIX node.exec timeout cleanup implementation plan

Status: completed, verified, untracked and uncommitted. No commit or push is authorised. Earlier pending/failed entries below are retained execution history; the final verification section supersedes them.

Goal: stop leaking AIO-spawned children when POSIX inspection fails, preserve descendant ownership safety, and make real-process test teardown independent of product cleanup.

Architecture: retain the bounded marker-validated process-tree inspector. Add direct-child signalling in the executor using the live ChildProcess lifetime as ownership proof. Tests register process handles and descendant PID files before execution, assert actual death, and force cleanup even after failed assertions.

Spec: James's 2026-10-03 request in this session. Implement in the existing checkout; preserve all unrelated dirty work.

## Decisions and limits

1. When the child has not reported exit (`exitCode === null && signalCode === null`, plus the exit-event guard), its positive PID belongs to the child AIO spawned. Send SIGTERM, wait the existing grace period, then SIGKILL if it remains live, even if marker inspection is unavailable, empty, or invalid. Recheck lifetime after asynchronous inspection. Preserve `cleanupIncomplete` when descendant identity is unavailable and report failed direct signals.
2. Do not signal `-pid` without validated group ownership. A detached leader proves the child, not every member of its group; members may lack the marker, and a leader can exit during inspection. The existing scanner intentionally rejects groups containing unmarked processes. An unconditional group fallback would bypass that model. Unproven descendants may remain; report that limitation truthfully rather than claiming universal tree cleanup.
3. Do not adopt `pgrep -P` or `pgrep -g` as product inspection fallback. They expose relationships/group membership, not the per-execution inherited environment marker or identity continuity after PID reuse/reparenting. Use pgrep for reproduction and verification only. Retain bounded ps inspection.
4. Do not add a global Vitest teardown scan: detached descendants can already be reparented before teardown, ps may be unavailable, and broad command matches could include James's existing processes or concurrent sessions. Explicit per-fixture registration plus independent force cleanup and liveness assertions provide stronger ownership and failure evidence without a suite-wide kill policy.
5. Existing machine orphans must remain untouched. Only processes started by this task may be cleaned up. The separate `fake-codex.mjs` orphan in `~/work/communitytech/work-finding` is a follow-up outside this task.

## Review focus

- Child exits while asynchronous inspection runs: never signal a reused direct PID.
- Failed, thrown, hung, empty and invalid-marker inspection: direct cleanup remains bounded and stderr stays truthful.
- Validated descendants and mixed-marker groups: preserve positive/negative PID safety rules.
- Failed assertions or execution errors before PID assignment: fixture teardown must still discover and stop owned children.
- Host load and inherited pipes: wait for process death with a bounded poll, not result shape or heartbeat alone.

## Tasks

- [x] Read executor, process-tree implementation, node-ops and policy specs in full; trace dispatcher, worker wiring, options and result contracts.
- [x] Record pre-run `pgrep -f 'node -e'` baseline in ignored scratch evidence. Reproduce with injected failing `execFileProcess` and a uniquely identified SIGTERM-ignoring child; show it survives with pgrep, then force-kill only that reproduction child in guaranteed teardown.
- [x] Add a test fixture registry in test-only code: register ChildProcess handles at spawn time, register descendant PID files before launching parents, SIGKILL still-live owned fixtures in afterEach/finally, and wait for death. Make liveness checks distinguish ESRCH from permission failures.
- [x] Run the new no-ps real-process regression against unchanged production code and retain its expected failure. Cover TERM then KILL, TERM-exit during inspection/grace, signal failure, invalid/missing marker, empty scan, inspection exception and timeout; do not signal unproven groups/descendants.
- [x] Implement direct-child lifetime-checked fallback in `src/worker-agent/worker-node-executor.ts`; keep tree ownership authority separate from fallback success. Exercise the real executor/RPC path and rerun affected specs.
- [x] Retrofit all long-lived node-ops/policy fixtures with unconditional teardown and death assertions for roots and relevant descendants. Register PID files before assertions/execution to cover early failures.
- [x] Audit every result of `rg -l 'process.execPath|node -e' src --glob '*.spec.ts'`; record mock/finite fixtures as checked and repair missing independent teardown in risky real-process fixtures. Preserve concurrent edits. Inventory and startup-race remediation are implemented; final independent review remains pending.
- [x] Run targeted specs, `npx tsc --noEmit`, `npm run typecheck:spec`, lint, max-LOC, main and renderer builds, and uncached full quiet tests. Retain full logs and actual exit codes under `_scratch/`.
- [x] Compare final pgrep snapshot with baseline; verify no newly surviving node-e fixtures from the final full run. Do not signal baseline PIDs or unrelated new processes. Historical six-survivor attribution remains unknown and is reported separately.
- [x] Fresh independent agent uses `task-completion-gate` to review acceptance, task diff (including uncommitted work), safety, lifecycle, test integrity, async/state and performance. Fix actionable findings and repeat with a new reviewer until PASS. Fourth fresh gate returned PASS.
- [x] Record as-built decisions, audit inventory, verification and limitations, then rename this plan to `_plan_completed.md` only after all required gates pass. Leave changes uncommitted.

## Evidence and audit inventory

Evidence will be recorded here while this plan remains active. Full logs belong in ignored `_scratch/`; they are not source files.

### Current execution evidence

- No-ps reproduction failed against unchanged product code; `pgrep -f` found PID 73354, and the death assertion failed. Repeated controlled run also failed (PID 1520), exit 1. Registered teardown killed only the reproduction fixtures. Logs: `_scratch/node-exec-no-ps-red.log`, `_scratch/test-run.node-exec-red.log`.
- Fixed regression: 1 test passed, exit 0, `_scratch/test-run.node-exec-green.log`.
- Affected worker specs: 3 files, 155 tests passed, exit 0, `_scratch/test-run.node-exec-focused.log`.
- Other-spec audit: initial 9 files/215 tests and follow-up 2 files/8 tests passed, exit 0; logs `_scratch/test-run.process-audit.log` and `_scratch/test-run.process-audit-extra.log`.
- Requested audit found 28 specs: two worker specs hardened by root, ten further specs hardened by audit agent, sixteen checked unchanged. Full inventory below.
- Baseline `pgrep -f 'node -e'`: exit 1, zero matches; captured in `_scratch/node-exec-process-baseline.json`. Existing machine processes were not signalled.
- Initial working-tree typecheck failed on another session's `src/renderer/app/core/state/side-chat.store.ts` imports; initial lint failed on its unused symbols. Logs `_scratch/node-exec-typecheck.log` and `_scratch/node-exec-lint.log`. These files are outside this task's scope; current gate results are recorded below.

## Hardened specs (10)

| File | Original risk | Change |
| --- | --- | --- |
| src/main/doc-review/serve-review.spec.ts | HTTP server registered only after readiness, so startup rejection loses handle; SIGTERM-only teardown does not await death. Slow capture hook deliberately outlives server. | Track every spawned server handle immediately; afterEach registry SIGKILL/await. Slow hook is now a direct 2s Node timer. A server-only preload journals its actual ChildProcess PID synchronously in the creator, before hook startup; the test proves it outlives server then independently kills/waits it. |
| src/main/plan-queue/plan-queue-process.spec.ts | 60s sleeps depend on product cleanup; detached escapee PID assigned only after await run, so failed await loses it. | All long-lived creator commands use direct Node roots (shell:false), keeping a finite shell exit/output case. Capture actual roots synchronously using captureFixtureSpawns; register descendant PID files before launch; afterEach product cleanup runs with independent registry cleanup in finally. Delayed-preload regression stops the actual creator before it can write a descendant PID or spawn an escapee. |
| src/worker-agent/provider-runtime-diagnostics.spec.ts | Four auth probes run setInterval with SIGTERM handlers; finally only removes fixture directory. | Preserve actual defaultExec timers and callbacks; capture its actual OS handles synchronously through captureFixtureSpawns. Register auth PID file pre-launch; independently cleanup in finally. Real probe tests assert at least three actual handles captured before a PID was assigned. |
| src/main/cli/adapters/base-cli-stdin-write.spec.ts | Real detached ACP readline process can stay resident; spawn occurs outside finally and teardown relies on adapter. | Override test subclass spawnProcess to register actual handle immediately; afterEach independent cleanup covers spawn/setup/assertion failures. |
| src/main/cli/adapters/codex-exec-native-outcome.spec.ts | Silent and timeout fixtures use setInterval; adapter teardown may lose prior child after successor/replacement. | Track every actual spawnProcess handle and independently cleanup all handles in afterEach. |
| src/main/instance/codex-exec-input-receipt.spec.ts | Stop fixtures keep intervals alive; only product adapter cleanup. | Track every actual spawnProcess handle; independent registry afterEach cleanup. Existing real-timer restoration preserved. |
| src/main/cli/adapters/__tests__/provider-source-logging-extra.native.spec.ts | Exec timeout setInterval plus resident app-server readline fixtures only adapter cleanup. | Capture real spawn handles synchronously before startup using captureFixtureSpawns. Register fixture PID files pre-launch; native assertions match each reported PID to captured handle and prove capture preceded PID assignment. Registry cleanup runs independently in afterEach finally before capture restoration and temp deletion. |
| src/main/cli/adapters/__tests__/provider-source-logging-notification.native.spec.ts | Resident Codex app-server/Sdk readline fixtures; setup/dispose failure can miss product cleanup. | Capture real app-server roots synchronously through captureFixtureSpawns, plus explicit SDK handles. Native assertions match reported PID to captured handle and prove capture preceded PID assignment. Independent finally teardown stops roots before reading PID files/removing fixture dirs. |
| src/main/orchestration/loop-completion-detector.spec.ts | abortVerify fixture sleeps 60s with no unconditional independent teardown. | Capture real verify creator handles before startup; POSIX shell exec replaces shell with the Node creator. Register PID file pre-launch; assertion confirms live captured root and capture-before-PID timing. Independent cleanup/restoration precedes temp removal. |
| src/main/orchestration/loop-coordinator-cancel-preflight-verify.spec.ts | 4s cancellation fixture teardown relies entirely on coordinator cancellation; failed test could leave child to run after worker exits. | Capture real verify creator handles before startup; POSIX shell exec replaces shell with Node. Register PID file pre-launch; assertions prove live root capture and capture-before-PID timing. afterEach registry cleanup/restoration precedes coordinator cleanup/temp deletion. |

ProcessFixtureRegistry is root-owned at src/tests/fixtures/process-fixture.ts. Audit imported it without modifying helper. It sends SIGKILL only to live ChildProcess handles or PIDs written by specific registered test fixtures, waits for captured-handle exit or ESRCH, and reports permission failures. A PID receipt cannot override a captured root lifetime. No group signalling was introduced here.

## Checked unchanged (16)

| File | Execution and lifetime evidence |
| --- | --- |
| src/main/util/file-lock.spec.ts | spawnSync empty Node script; fully reaped before returns. |
| src/main/orchestration/loop-coordinator-audit.spec.ts | Node verification explicitly process.exit(0); other slow fixture is bounded sleep 0.5. No detached resident fixture. |
| src/main/workspace/git/worktree-manager.spec.ts | Actual git commands and finite install-marker.js writes one file and returns; no interval, signal ignore, detached escapee fixture. |
| src/worker-agent/worker-supervisor.spec.ts | Injected fake child handles with microtask exit plans. process.execPath only command resolution expectation. |
| src/main/cli/hooks/__tests__/defer-permission-hook.spec.ts | spawnSync hook fed finite stdin; terminating script, no resident or descendant fixture. |
| src/main/cli/hooks/__tests__/rtk-defer-hook.spec.ts | spawnSync finite hook/stub scripts; stub exits explicitly. No resident fixture. |
| src/main/cli/adapters/acp-cli-adapter.liveness.spec.ts | TestAcpCliAdapter/FakeAcpProcess; interval is in test harness, not OS subprocess. |
| src/main/cli/adapters/acp-cli-adapter.spec.ts | All instances TestAcpCliAdapter; overridden spawnProcess returns in-memory FakeAcpProcess constant PID 4242; no actual OS child. |
| src/main/cli/adapters/__tests__/provider-source-logging.native.spec.ts | Actual stdout/stderr fixture writes finite small payload then returns. Remaining fixtures are in-process HTTP servers with teardown. Safety conclusion based on terminating script, not adapter terminate. |
| src/main/browser-gateway/browser-mcp-stdio-server.spec.ts | Actual execFile probe uses finite 2.1s timer + retry and execFile 15s deadline. No interval/signal handler/descendant fixture. |
| src/main/cli/adapters/__tests__/copilot-usage-diagnostics.native.spec.ts | Actual fixture writes finite argv receipt and small stdout then returns. Existing untracked/concurrent work preserved. Safety conclusion based on script lifetime, not adapter terminate. |
| src/main/instance/__tests__/instance-lifecycle-browser-mcp.spec.ts | Spawn configuration assertions only; no child execution. |
| src/main/instance/instance-communication.spec.ts | EventEmitter fake adapters; ACP receives synthetic events; native Codex tests mock connectAppServer before init. No actual child. |
| src/main/hooks/enhanced-hook-executor.spec.ts | Every command/script rejected by policy before spawning. |
| src/main/orchestration/loop-coordinator-terminal-intents.spec.ts | Actual finite passing/failing verify commands with process.exit; finite counter script. Invocation callbacks and reviewers simulated. |
| src/main/orchestration/loop-coordinator-review-driven.spec.ts | Actual finite process.exit(0) verify command; primary/reviewer callbacks simulated. No resident child fixture. |

Adjacent utilities read: plan-queue-process.ts, base-cli-adapter.ts (complete), base-cli-process-utils.ts, provider-runtime-diagnostics.ts (complete), serve-review.mjs, loop-test-commands.ts, loop-coordinator-test-cleanup.ts. Audit subagent read acp-cli-adapter.test-helpers.ts and traced mocked Codex initializer connection.


- Self-review detected duplicate TERM delivery when a validated group had already signalled the root. Added regression failed (exit 1; `_scratch/test-run.node-exec-duplicate-term-red.log`); tree cleanup now reports actually signalled PIDs, and fallback only runs if the root was not signalled. The final worker-focused run is pending.
- New real-process regressions now allow 2 seconds for Node startup before the requested timeout; under concurrent builds/full suite the original 300ms allowance sometimes expired before SIGTERM handlers were installed. Readiness, escalation and liveness assertions remain intact.
- Task-scoped ESLint passed, exit 0; `_scratch/node-exec-scoped-lint.log`. Spec typecheck has no remaining task-file errors; unrelated side-chat/dashboard errors persist in `_scratch/node-exec-typecheck-spec-rerun.log`.
- Main build passed, exit 0; renderer build failed on unrelated chat-detail/dashboard changes. Max-LOC failed on unrelated chat-service/dashboard growth. Logs use `_scratch/node-exec-*.log`.

### Independent review and current verification

- First fresh completion gate: FAIL. PID-file-only registration could miss a child still starting when an assertion/setup failure triggers teardown. Added synchronous real-handle capture and a delayed-PID-write helper regression. Helper regression passed; `_scratch/test-run.node-exec-fixture-regression.log`. Six audit specs initially passed 196 tests; `_scratch/test-run.process-audit-fix.log`.
- Second fresh completion gate: FAIL. Plan-queue tracked a shell while an untracked intermediate Node process could outlive it and later create a detached sleep/PID file. Reviewer reproduced this with a delayed preload, then killed only its own fixtures. Remediation replaces long-lived shell creators with directly launched Node roots and adds early-startup coverage. The new regression also exposed a transparent mock not capturing the actual product spawn path; actual capture wiring is being corrected and explicitly asserted across integrations. Green result-shape tests alone were insufficient.
- Latest completed project gates: production typecheck, lint, max-LOC, main build and renderer build all exit 0. Logs `_scratch/node-exec-{typecheck-final,lint-final,max-loc-final,build-main-final,build-renderer-final}.log`.
- Latest spec typecheck exits 2 solely on an unrelated side-chat spec import (`src/renderer/app/core/state/side-chat.store.spec.ts:4`); `_scratch/node-exec-typecheck-spec-latest.log`. Preserve that session's work. Required full suite is still running and will need final evidence after startup-race changes.
- Duplicate-TERM correction verified: worker-focused 3 files / 156 tests passed, exit 0; `_scratch/test-run.node-exec-focused-root-signal.log`. Fallback does not send another TERM when validated tree signalling already reached the root.

- Startup-race remediation now uses `captureFixtureSpawns` on the actual `ChildProcess.prototype.spawn`, before native delegation; ineffective builtin-export mocks were removed. A real bound-export helper regression passed two tests, exit 0 (`_scratch/test-run.node-exec-fixture-capture.log`). Native/diagnostic/loop integrations explicitly prove capture before PID assignment. Plan-queue launches Node creators directly, with a delayed-preload regression; capture-hook creator journals its real child PID before hook startup.
- Final audit remediation: seven specs / 204 tests passed (`_scratch/test-run.process-audit-final-fix.log`). Consolidation briefly dropped plan-queue tempdir initialization, causing seven failures; fixed and all seven reran successfully (`_scratch/test-run.process-audit-final-planqueue.log`). Other six specs passed 197 tests in the consolidation run. Scoped ESLint of those seven specs exits 0. Root is running all 14 task specs against final source.
- Gate3 spec typecheck also found unrelated renderer plan-queue tests referring to a removed `answer` member (`plan-queue-item-list.component.spec.ts:139` and `plan-queue-run-list.component.spec.ts:118`). No task-file type errors. These unrelated files remain untouched; log `_scratch/node-exec-typecheck-spec-gate3.log`.

### Third fresh review remediation

- Third fresh completion gate: FAIL. The helper correctly skipped exited captured roots initially, but its subsequent PID-file pass could kill a replacement at the same PID. Reviewer reproduced this using only a controlled replacement child and an exited captured handle. No machine orphan was signalled.
- Deterministic real-replacement regressions for both exitCode and signalCode failed before the fix: two failures (`_scratch/test-run.node-exec-reused-pid-red.log`). Cleanup now excludes captured root PIDs from receipt-based signalling, including roots already exited or killed earlier in that cleanup pass. Remaining descendant receipts retain independent cleanup.
- The same lifetime must govern assertions: the extended regression initially exposed a false “still alive” result for an exited root's reused PID (`_scratch/test-run.node-exec-reused-pid-wait-red.log`). Captured-child waits now consult exitCode/signalCode dynamically, while raw descendant waits continue requiring ESRCH. Receipt assertions cannot override captured roots either.
- Latest all-task focused run on pinned Node v24.15.0: 14 files / 377 tests passed, exit 0 (`_scratch/test-run.node-exec-lifetime-authority-green.log`). Updated code hashes: `_scratch/node-exec-source-hashes-gate4.json`.
- Pinned Node gate4: production typecheck, scoped lint, full lint, max-LOC, main build and renderer build exit 0. Spec typecheck now fails only on the unrelated side-chat import (`_scratch/node-exec-typecheck-spec-gate4.log`). Other renderer plan-queue type errors no longer appear. That unrelated file remains untouched pending James's scope decision.

### Full-suite and process evidence (not yet completion)

- First full run finished exit 1: 12 failures of 29,183 tests (`_scratch/test-run.node-exec-full.log`). It started before final source refinements: older duplicate-TERM logic and missing helper exports caused task failures. Other failures were two SEA builds using unsupported Homebrew Node v26.3.0 and a chat-contract expectation outside task scope. Keep this as failed evidence, not a green full gate.
- Repo pins v24.15.0 in .nvmrc; that installation exists locally. Next full run uses its bin directory at the front of PATH, preserving the rest of the environment (`_scratch/test-run.node-exec-final-full.log`, currently running). Last helper ownership remediation happened during this run, so its final report must be checked for stale helper transforms; final frozen-source verification is still pending.
- After the first full run, pgrep -f 'node -e' and pgrep -P 1 reported PIDs 55531, 56027, 58320, 63074, 63687, 64527. They are six reparented survivors. Attribution is UNKNOWN: two contain the original inherited-pipe parent script without the current PID-file recording; prior reviewers ran current specs and have no exact-PID ownership evidence for them. Initial snapshot was zero; do not pretend these were in that snapshot or attribute them to a specific run from command patterns. They remain untouched.
- These six form the explicitly recorded pre-pinned-run snapshot (`_scratch/node-exec-process-after-first-full.json`). Compare the final run against it and the original zero snapshot, and report both honestly. Read-only ps metadata inspection was denied (`Operation not permitted`); no signalling or permission bypass was attempted.

### Frozen-source final verification

- Second full run finished exit 1: three failures of 29,199 tests in 1,677.2 seconds (`_scratch/test-run.node-exec-final-full.log`). Two helper PID-reuse failures used the pre-remediation transform from that already-running suite; the current source passes both regressions in the 377-test focused run. The third failure was the unrelated chat-channel contract expectation. This failed run does not verify the final helper.
- Post-second-run pgrep matches exactly the same six unidentified PIDs, with no additions (`_scratch/node-exec-process-after-second-full.json`). They remain untouched; the initial zero snapshot and subsequent six-survivor snapshot are both retained.
- A third uncached full quiet run is now running under pinned Node v24.15.0 with all task source frozen. Evidence: `_scratch/test-run.node-exec-frozen-full.log`, `_scratch/node-exec-frozen-full-start-hashes.json`, and `_scratch/node-exec-frozen-full-exit.json` when it finishes. No task source changes are permitted during this run.
- The other session corrected its side-chat spec import and chat-channel expectation. Root has not edited either file. Spec typecheck and the chat-contract spec are being rechecked; James's pending import-fix scope question is now moot.
- Fourth fresh completion reviewer is independently inspecting the current task diff and acceptance. Its verdict is pending the frozen full run and remaining verification evidence.
- Corrected unrelated chat contract recheck: one file / two tests passed, exit 0 (`_scratch/test-run.node-exec-chat-contract-recheck.log`). Spec typecheck gate5 now fails on an unrelated runtimeTarget assignment in `src/main/ipc/handlers/chat-handlers.ts:203` (string provider versus CanonicalCliType), not on the corrected import. Log: `_scratch/node-exec-typecheck-spec-gate5.log`. Preserve that session's changes.
- Fourth reviewer independently reran four focused specs / 42 tests successfully, exit 0 (`_scratch/test-run.node-exec-gate4-independent.log`), including real no-ps RPC, ownership/group safety, asynchronous root exit, duplicate TERM, PID reuse and delayed startup. No task-code finding reported so far; final verdict remains pending.
- The frozen full run currently reports two unrelated `side-chat-context.spec.ts` failures: pending transcript turns duplicate durable content. Root is preserving that feature and has asked whether James wants ownership of its blockers transferred; no answer is assumed. Full-run final status remains pending.

### Final full-run result and concurrent blocker resolution

- Frozen full run finished exit 1 in 361.3 seconds: 29,192 passed, two failed, six skipped, 29,200 total. Only the two unrelated side-chat context assertions failed (`_scratch/test-run.node-exec-frozen-full.log`, `_scratch/test-results.node-exec-frozen-full.json`). All 17 task source files remained unchanged (`_scratch/node-exec-frozen-full-source-comparison.json`).
- Final pgrep equals the same six prior unidentified survivors, with zero additions versus the pre-frozen snapshot (`_scratch/node-exec-process-after-frozen-full.json`). Fourth reviewer independently confirmed hash and PID equality. No unidentified processes were signalled.
- The other session subsequently fixed both remaining blockers. Spec typecheck gate6 exits 0 (`_scratch/node-exec-typecheck-spec-gate6.log`), and current side-chat context recheck passes all 20 tests (`_scratch/test-run.node-exec-side-chat-blocker-recheck.log`). Root has not modified any side-chat file; both scope questions are moot.
- Production typecheck, full lint, max-LOC and both builds are being refreshed against that corrected tree (gate7 logs). A new uncached full quiet run will then verify it, while task source remains frozen. Fresh reviewer is holding its verdict for those results.
- Gate7 refresh completed: production typecheck, full lint, max-LOC, main build and renderer build all exit 0 (`_scratch/node-exec-gate7-exits.json`; individual `_scratch/node-exec-*-gate7.log`). Spec typecheck gate6 exits 0. New uncached quiet full run is active under pinned Node v24.15.0 (`_scratch/test-run.node-exec-post-blocker-full.log`), with its own source hashes and exact process baseline.

### Verification limits

- The 14 affected specs contain 380 tests: 377 passed and three existing ps-availability checks skipped in focused and frozen full runs. They are the policy premature-script-input descendant case, RPC detached-descendant case, and RPC immediate-orphan three-trial case. No skip was added by this task. This sandbox cannot run ps, so real marker-validated forced descendant termination is not newly runtime-verified here; injected marker/group safety tests pass.
- The non-skipped inherited-pipe test asserts death of its actual finite descendant before safety teardown. Its one-second natural lifetime does not prove forcible descendant termination. The real injected-no-ps regression separately proves TERM-to-KILL direct-root cleanup. Other real-process audit tests prove independent root/descendant teardown on their applicable paths.
- Unproven descendant ownership continues to produce cleanupIncomplete, and only the direct live child receives the fallback. Universal descendant termination under unavailable inspection is deliberately not claimed.

## Final verification and as-built status

All five requested implementation items are implemented. POSIX fallback signals only the currently live direct positive PID, first TERM then KILL through the existing grace sequence. Marker validation retains authority over descendants and groups; rootSignalled avoids duplicate TERM. Test-only synchronous capture and independent force teardown cover startup/assertion failures. Captured exit evidence remains authoritative over root PID receipts. The full original 28-spec audit is recorded above; ten additional specs were hardened, two worker specs hardened, sixteen checked unchanged. No product pgrep fallback or suite-wide teardown scanner was adopted, for the ownership reasons recorded in Decisions.

Final canonical commands used the repo-pinned Node v24.15.0 installation, with its bin directory prepended to the existing PATH:

| Verification | Result | Evidence |
| --- | --- | --- |
| `npx tsc --noEmit` | exit 0 | `_scratch/node-exec-typecheck-gate7.log` |
| `npm run typecheck:spec` | exit 0 | `_scratch/node-exec-typecheck-spec-gate6.log` and exit JSON |
| `npm run lint` | exit 0 | `_scratch/node-exec-lint-gate7.log` |
| `npm run check:ts-max-loc` | exit 0 | `_scratch/node-exec-max-loc-gate7.log` |
| `npm run build:main` | exit 0 | `_scratch/node-exec-build-main-gate7.log` |
| `npm run build:renderer` | exit 0 | `_scratch/node-exec-build-renderer-gate7.log` |
| All 14 affected specs | 377 passed, three existing inspection skips, exit 0 | `_scratch/test-run.node-exec-lifetime-authority-green.log` |
| `npm run test:quiet -- --no-cache` | 2,332 files, 29,194 passed, six skipped, zero failed; exit 0 in 233.8 seconds | `_scratch/test-run.node-exec-post-blocker-full.log`, `_scratch/test-results.node-exec-post-blocker-full.json`, actual exit JSON |
| Fresh completion gate | VERDICT: PASS, no unresolved actionable findings; independently 42 focused tests passed | `_scratch/node-exec-completion-gate4.md` |
| Final task-source hashes | all 17 unchanged during full run | `_scratch/node-exec-post-blocker-full-comparison.json` |
| Final `pgrep -f 'node -e'` comparison | zero added matches; same six prior unidentified survivors | `_scratch/node-exec-post-blocker-full-process-baseline.json`, `_scratch/node-exec-post-blocker-full-process-after.json`, `_scratch/node-exec-post-blocker-full-comparison.json` |

The final full run set AIO_TEST_SUMMARY=0 and AIO_TEST_OUT_SUFFIX=node-exec-post-blocker-full. Every shell invocation used RTK; full logs and actual subprocess exits were retained. Full verification became green after the other session corrected its own side-chat changes; root did not modify those files.

No machine orphan was targeted, and the six unidentified historical survivors remain untouched. Their appearance after the original zero snapshot is recorded honestly above; the green final run added none. Three real inspection-dependent forced-descendant checks remain unverified in this sandbox, as documented in Verification limits. No commit, push, branch or worktree was created. Task paths are unstaged; this completed plan remains untracked. The unrelated fake-codex orphan remains an out-of-scope follow-up.
