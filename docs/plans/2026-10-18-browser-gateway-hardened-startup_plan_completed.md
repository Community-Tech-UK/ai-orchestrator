# Browser Gateway hardened startup repair

Status: implementation retained and queue-worker verification refreshed on 18 October 2026; ready for the assigned independent Queue verifier. Overall completion remains open until its full suite and fresh completion gate pass. The coordinator owns checkpointing, integration and document closure; this worker must not commit, rename this plan, restart the app or create another branch/worktree.

Goal: a restricted Codex session can initialise Browser Gateway without granting write access to the whole Harness data directory. An unavailable log sink must not prevent the bridge handshake.

## Evidence

- Screenshot session: `cxa2xzfpj`, Codex exec, working directory `myshellarts`.
- Live app log records hardened spawn with seven roots, none covering the configured per-instance browser-forwarder log directory under Electron userData.
- The forwarder log directory was absent before investigation. An unrestricted handshake using the existing generated session configuration succeeded.
- Packaged `aio-mcp browser-gateway` with a mode-0500 temporary log ancestor exited 1 without any stdout. Stack: top-level getLogger → LogManager constructor → ensureLogDirectory → mkdirSync EACCES.
- Nested Seatbelt reproduction cannot run in this agent's inherited sandbox (`sandbox_apply: Operation not permitted`). Do not treat that as an app failure or remove restrictions.

## Implementation and checks

- [x] Grant `options.browserGatewayMcp.logDirectory` as an exact additional hardened writable root, without granting its parent or unrelated sessions. Trace production spawn and provider-switch wiring.
- [x] Catch file-sink initialisation failure in LogManager, disable file output, retain memory/console configuration, and emit a fixed stderr diagnostic without paths or error contents. Keep stdout clean for MCP.
- [x] Verify actual forwarder initialize/tools-list with denied logging using a bundled local dispatcher; only then add regression tests for denied logging and narrow adapter grants.
- [x] Refresh focused logger/adapter/forwarder checks and the six non-suite canonical gates: TypeScript, spec typecheck, lint, LOC and both builds. Retain full logs and command receipts in ignored scratch output.
- [x] Regenerate aliases and IPC channels, verify IPC/exports/contracts, exercise the rebuilt bundle and SEA binary with writable and denied sinks, and rerun the two previously failing queue specs.
- [ ] Assigned Queue verifier: run the full quiet suite. The current worker instructions explicitly reserve this gate for the verifier; the earlier interrupted run is not a pass.
- [ ] Fresh independent task-completion-gate review of the original repair and current checkout; resolve all actionable findings and repeat until PASS. Review scope is recorded below because the repair is already in the merge base.
- [ ] Coordinator: close the plan after independent verification. The installed-app check remains in the linked live-test document. This worker leaves the plan active and uncommitted as instructed.

## Review focus

Logging failure during top-level imports; MCP stdout purity; exact session root rather than broad userData; no grant when Browser Gateway is absent; normal log sink still enabled; no sandbox bypass on failure. Existing unrelated dirty changes are outside this task.

## Verification evidence from the original implementation

- Focused logger, hardened factory, real-process startup and stdio-forwarder tests: passed, 4 files / 35 tests. `_scratch/test-run.browser-startup-focused.log`.
- `npx tsc --noEmit`, lint, LOC check, main build and renderer build: exit 0. Individual logs and command results: `_scratch/browser-startup-verification/`.
- `npm run build:aio-mcp-dist`: exit 0. Real SEA binary answers initialize and tools/list with both writable and mode-0500 denied log folders; stdout contains only JSON-RPC and the fixed warning is confined to stderr. `_scratch/browser-startup-verification/runtime.json`.
- `npm run typecheck:spec`: initially exit 2 in concurrent, out-of-scope queue tests (`plan-queue-run-hold.spec.ts`: status widening and missing lastAssistantOutput; `plan-queue-routing-panel.component.spec.ts`: incomplete fixture cast). After both files changed in the concurrent work, a fresh full rerun passed exit 0 (`spec-types-rerun.log`). The original failure is retained in `spec-types.log`; no task code changed for the rerun.
- An additional focused spec compilation against the repository spec configuration passed exit 0 (`focused-spec-types.log`).
- Full quiet suite was interrupted (actual exit 130) after recording four out-of-scope queue failures, two each in `plan-queue-coordinator.spec.ts` and `plan-queue-pause-control.spec.ts`. This was not a completed or passing full-suite run. Queue sources/tests were changing concurrently, so this run cannot certify a single fixed checkout. Retained output: `_scratch/test-run.browser-startup-full.log`.
- Independent reviewer reran focused tests, main TypeScript and lint successfully; independently exercised SEA handshake with writable/denied logs and confirmed a normal sink persists JSON log entries. Fresh review verdict: FAIL solely because of the outstanding full-suite gate, with no actionable task-specific findings. Evidence: `_scratch/browser-startup-verification/review-result.txt`. Plan stays active until a stable checkout passes the full suite and fresh completion gate.
- Installed-app hardened session retest is recorded in [the live-test document](2026-10-18-browser-gateway-hardened-startup_livetest.md). No app restart or installed bundle replacement performed.

## Queue resume as-built notes — 18 October 2026

- Resumed in the supplied worktree `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-18-browser-gateway-har-25f6a9` at `81755b3fa441c8c741e13db4c894f61a0de4620b`. The working tree was clean. `git merge-base main HEAD` equals HEAD and `git diff main...HEAD` is empty: the original repair is already in the shared history. No further production or test changes were needed. No linked spec exists in this plan or alongside the matching startup documents.
- Review the task-scoped original diff `81755b3fa^..81755b3fa`, limited to `src/main/cli/adapters/hardened-adapter-config.ts`, `src/main/cli/adapters/__tests__/adapter-factory-hardened-remote.spec.ts`, `src/main/logging/logger.ts`, `src/main/logging/__tests__/logger.spec.ts`, and `src/main/browser-gateway/browser-mcp-startup.spec.ts`. An empty queue merge-base diff does not replace reviewing those changes. The evidence seal hashes these five paths and the adjacent stdio-forwarder test/implementation.
- Production wiring remains intact: `SpawnConfigBuilder.getBrowserGatewayMcpOptions` derives the encoded per-instance folder, runtime reconciliation supplies it on provider changes, and `createCliAdapter` delegates hardened configuration to `configureHardenedAdapter`. That helper prepares the exact folder before confinement and adds only that folder. Logging initialisation catches file-sink failures before MCP startup without changing console configuration or exposing paths in the fallback diagnostic.
- Current evidence directory (inside the queue worktree, ignored): `_scratch/browser-startup-resume-2026-10-18/`. It contains `report.md`, `seal.json`, individual `*.receipt.json` command receipts, raw build/static logs, focused Vitest logs/JSON and protocol/sink logs. The original implementation evidence above is historical and is not substituted for these new runs.
- Focused logger/hardened-factory/real-process/stdio checks: **4 files, 32 tests passed, no skips**, cache disabled. The prior full-run blockers were checked separately: `plan-queue-coordinator.spec.ts` and `plan-queue-pause-control.spec.ts` now pass **2 files, 128 tests**, cache disabled. This is targeted evidence, not a full-suite result.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and `npm run build:renderer`: **all exit 0**. Renderer build retains its existing initial-bundle budget warning (1.36 MB against 1 MB). Alias and IPC generation introduce no tracked differences; IPC, export and contracts checks all exit 0.
- Initial `build:aio-mcp-dist` with Homebrew Node 26.3.0 correctly refused to build because that binary lacks the SEA fuse (exit 1 retained). Repeating with the already-installed `.nvmrc` runtime, Node **24.15.0**, passed exit 0. No dependency installation or source workaround was required.
- Rebuilt bundle and SEA binary each passed initialise/tools-list with writable, mode-0500 and non-directory log ancestors: **six cases, all exit 0**. Each stdout contains exactly two valid JSON-RPC replies, including the stable browser discovery tools. Both normal sinks persist the MCP startup entry. Each failed sink emits exactly the fixed diagnostic to stderr without the log path. The initial fixed-wait probe failed to observe the cold SEA normal-sink startup before EOF; its failure receipt is retained. The final probe waits for both protocol and sink readiness before EOF and passes without production changes.
- Seatbelt preflight was rerun: `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` exits **71**, `sandbox_apply: Operation not permitted`. This confirms the nested confinement limit still applies. No confinement bypass was attempted. The installed-app/restricted-Codex check still genuinely requires the rebuilt/restarted app and remains in the existing `_livetest.md`; no live browser step was attempted.
- Ruling: the current Queue worker instructions supersede this plan's earlier instruction to run the full suite and close the plan here. The full suite, fresh independent verdict and final rename remain open for the assigned verifier/coordinator. They are not live-test deferrals. All worker-owned verification is ready for that handoff.
- Cleanup: disposable fixture directories are removed by the runtime probes. After report/seal/receipts are written, remove this run's `dist/` output (absent at resume), retaining the pre-existing linked dependency install and pre-existing Vitest cache. No checkout or dependencies were copied outside the worktree. See `cleanup.receipt.json` for the final cleanup and clean-tree result.

## Coordinator handoff: verdict discovery — 18 October 2026

The first assigned verifier ended with a textual PASS but reported it could not find `plan_queue_report_verdict`; no recorded verdict is inferred from that text. Native status remains `verifying`. The coordinator independently discovered that exact schema through `orchestrator_tool_search` with query `plan_queue_report_verdict`; its advertised invocation is `orchestrator_tool_execute` with `name: "plan_queue_report_verdict"` and the schema's arguments. This establishes discovery in the coordinator session only, not the cause of the earlier verifier's failure. A subsequent verifier should discover the tool in its own session before claiming it is unavailable, then submit its own verdict exactly once. The coordinator must never submit or impersonate a verifier. Keep source acceptance and closure open until the native tool records a qualified verdict.
