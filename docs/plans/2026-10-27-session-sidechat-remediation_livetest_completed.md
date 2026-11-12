# Session sidechat remediation: remaining Windows check

Status: both Windows checks passed live on 2026-11-12 on the merged code, with inspectable receipts (see "Evidence run — 2026-11-12" at the end). The 2026-11-04 results below are superseded: their receipt bundle was lost with its worktree. Routing defect numbering: the defect recorded as LT-723 here is LT-735 in the register. No deferred checks. The queue coordinator owns lifecycle acceptance; this document stays active.

Plan: [session sidechat remediation](2026-10-27-session-sidechat-remediation_plan_completed.md).
Original acceptance: [LT-SC-7](2026-10-02-session-sidechats_livetest.md#lt-sc-7--remote-workspace-routing).

> Reproduced defects belong in `docs/plans/livetest-remediation-register.md` with observed behaviour, root cause, required behaviour and acceptance, and in a new active implementation follow-up. Do not extend the closed July remediation plan. Before testing, read [the campaign runbook](livetest-campaign-runbook.md). Keep evidence here and leave this document open until every check passes.

## Prerequisites

- Build the queue worktree with `npm run build:main` and `npm run build:renderer` and launch an isolated profile. Do not restart James's running app.
- Register a separate, disposable Windows worker connection with that isolated coordinator, using the installed Windows worker runtime and its own identity/configuration. Do not disconnect, re-pair or reconfigure the production `windows-pc` worker. This is an agent-run fixture prerequisite, not a request for James to log in or restart anything.
- Run Browser Gateway health and `browser.preflight_target` with `computer: "windows-pc"` before browser work. All manual browser work remains on that computer; automated offscreen application tests open no desktop windows.
- Use a disposable Windows workspace and retain the coordinator's node identity and Windows path in local test variables. Do not put pairing credentials in this document, command arguments, chat or receipts.

## Check 1: real Windows sidechat dispatch

1. Confirm the isolated app's `electronAPI.remoteNodeList()` reports the disposable worker connected with Claude available. The production worker roster is not evidence of a connection to the isolated app.
2. Create a parent with `electronAPI.createInstance({ workingDirectory: windowsPath, provider: 'claude', forceNodeId: fixtureNodeId, yoloMode: false })`. Wait for its ready/idle state.
3. Create a sidechat with `electronAPI.sideChatCreate({ parent: { kind: 'session', historyThreadId: parent.historyThreadId, originNodeId: fixtureNodeId }, selection: { provider: 'claude', model: 'sonnet', reasoning: 'high' }, currentCwd: windowsPath })`.
4. Send `electronAPI.sideChatSend({ chatId, text: 'Report your current working directory. Do not edit any files.' })` and wait for a completed assistant reply.
5. Read `electronAPI.chatGet({ chatId })` and the runtime's execution location. Record the worker identity, exact Windows working directory, actual provider reply and an unchanged parent transcript.

Expected: the runtime is on the disposable Windows worker in the parent's Windows directory; no coordinator-local process interprets the Windows path.

## Check 2: unavailable worker refuses the sidechat send

1. Stop only the disposable worker connection created for check 1; wait for the isolated coordinator to report it unavailable.
2. Send another question to the same sidechat and retain the returned error and runtime list.
3. Confirm the send gives the explicit forced-worker-unavailable failure and creates no local replacement process. Do not substitute a standalone `createInstance` refusal for the sidechat send.
4. Remove the disposable worker process/config/workspace and isolated coordinator runtime. Retain the sanitized report, command receipts and seal.

Expected: explicit refusal, no local fallback and no change to the production worker connection.

## Current evidence: 2026-11-03

Browser Gateway reported the production `windows-pc` channel fresh and commands deliverable, and Windows-targeted preflight succeeded. The isolated test profile had no registered worker. The local remediation checks did not establish a disposable Windows connection, so neither check above is claimed to pass. There is no verified Windows worker outage or James-only approval/login boundary.

Sanitized receipts: `../../.aio-review/2026-11-03-session-sidechat-remediation-022b2b/windows-preflight.json` and the `persisted-rail-and-rows` receipt in that bundle's `live.jsonl`.

## In-loop fixture attempt — verification round 1 repairs

- Browser Gateway health: windows-pc channel fresh, commands deliverable. Windows-targeted preflight succeeded; no existing page was needed for automated offscreen IPC testing.
- Isolated offscreen Electron profile and free listener port 56135; loopback HTTP returned `426 Upgrade Required`, proving the listener answered. No desktop window was shown. Both Electron executable and firewall application entry were read; no firewall policy was changed.
- Built a disposable worker from this queue checkout, with its own log directory, one-time pairing, namespace, node identity, disabled auto-update and workspace. Uploaded through the normal worker and launched via the functioning Antigravity carrier. Production worker configuration, pairing and process were left unchanged.
- The disposable worker reported `unreachable`, with `socket hang up` before registration at the wired LAN address. Its own PID was verified and stopped before alternate timing checks. Windows HTTP probes to the other LAN address returned connection reset, and to Tailscale returned empty reply. Those are source-specific observations, not proof of a host or worker outage; no firewall/network cause has been established.
- The original missing fixture was agent-runnable and has now been attempted. Successful online sidechat dispatch and offline sidechat refusal still require a connection to the isolated coordinator. Final alternate-route WebSocket probes returned reset/hangup, but occurred near the coordinator timeout and are retained as diagnostics rather than proof that its listener was still available at that instant. The original active-worker failure and earlier two-vantage HTTP diagnostic remain the connection evidence. Both fixture processes have exited; the remote folder, own stale lock, local runtime and credentials were removed. See windows-cleanup.json and runtime-cleanup.json in the evidence bundle.
- Evidence in the queue checkout: `.aio-review/2026-11-03-session-sidechat-round2/windows-network-diagnostic.json`, `windows-fixture-status.json`, `windows-fixture.log`, `windows-live.jsonl` and `windows-preflight.json`.

## Evidence run — 2026-11-04, verification round 3 repairs

Both checks pass. The normal production worker remained connected; only an additional disposable worker connection and workspace were used.

1. **Online:** the isolated app listed the disposable node connected with Claude. A forced remote parent was created, then `sideChatCreate` and `sideChatSend` dispatched its Claude sidechat. At 01:24:26 UTC the retained answer named `C:\Users\shutu\.orchestrator\_scratch\aio-transfers\session-sidechat-round4\workspace`. The runtime's execution location was remote on node `4e7fa6ec-b8f2-4222-8fbd-95bebd57f370`, its working directory matched exactly, and the parent output buffer was byte-for-byte unchanged.
2. **Unavailable:** after the disposable connection disappeared and the roster no longer reported it connected, the same sidechat's send at 01:27:18 UTC returned `Forced worker node "4e7fa6ec-b8f2-4222-8fbd-95bebd57f370" is unavailable (not found)`. The adapter-factory observation recorded zero starts during that send. The app retained one error placeholder with its default local label; it had no CLI adapter or process. The worker cleanup check subsequently confirmed the fixture PID and its launcher were already absent. The initial stop-agent attempt exited before delivering instructions, so this is an observed unavailable-worker transition, not a claim that that failed agent issued a successful stop.

### Reproduction and transport limits

Before the fix, a connected Windows parent succeeded but its sidechat send tried the Windows directory on the Mac and failed `Working directory does not exist ... (cannot spawn claude)`. The policy used the optional local supervision-tree `workerNodeId`; the actual connected machine is `executionLocation.nodeId`. Runtime test doubles had hidden this distinction. LT-723 is registered in the worktree register and implemented in the active plan.

The original direct coordinator connection was tested while listening, from both Windows and the Mac: loopback returned HTTP 426, while direct LAN traffic closed. A minimal HTTP diagnostic answered from Windows over both LAN addresses and Tailscale. A temporary Node 24 WebSocket relay into coordinator loopback then carried the registered worker and the complete provider turn. The same relay under another installed Node runtime did not answer the LAN probe; host load changed during investigation, so neither a Node-version root cause nor an OS/firewall cause is asserted. No firewall or network policy was changed. The relay is test plumbing; production direct-network connectivity was not retested or modified.

Application checks were automated in an offscreen Electron window with an isolated profile, not a manually controlled local browser. Test-only no-sandbox/disabled-GPU flags were retained; production OS sandboxing and desktop focus were not tested. Windows Browser Gateway health and explicitly targeted preflight succeeded; no everyday browser page was navigated.

Evidence in the assigned worktree: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4. `windows-live.jsonl` retains both application results, `reproduced-routing-windows-live.jsonl` retains the pre-fix failure, and `runtime-receipt.json`, `command-receipts.jsonl`, `windows-stopped.json`, `report.md`, `seal.json` and `cleanup.json` retain verification and custody. Replay scripts are small `.txt` artifacts; runtime credentials and compiled fixtures are removed after sealing. Dependencies remain in the worktree.

### Final verification and cleanup

The genuinely fresh task-completion-gate reviewer returned **VERDICT: PASS** with no actionable findings, checked the before/after runtime receipts and traced the production path, and independently reran all canonical gates. The full unfiltered suite passed36492 tests with0 failures (nine pre-existing pending cases). It did not repeat paid provider turns or independently re-inspect Windows; those are the submitted runtime receipts, not a second Windows observation. Exact dirty source hashes matched before/after review; no clean checkout was created under the no-copy/no-commit instructions.

The Windows fixture and own lock were removed, all known fixture PIDs were absent and the normal production worker was still connected. Local fixture runtime and generated caches/build output are removed after retaining the evidence. The active filename is retained by explicit instruction; it no longer represents an accepted deferral. Full report: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/independent-review.md.

## Evidence run — 2026-11-12 (merged code, real Windows worker)

Both checks pass. The receipts are in `.aio-review/2026-11-12-session-sidechat-windows-646c67/` in the root checkout (`report.md`, `receipts/`, `scripts/`, `command-receipts.jsonl`, `seal.json`). They replace the lost 2026-11-04 bundle; the 2026-11-04 prose above stays as history only.

Fixture: isolated dev app from this queue worktree (profile `/tmp/aio-lt-queue-38646c67`, debug port 9529), a disposable worker (own node id, namespace `default`, own working folder) started detached on `windows-pc` and connecting through a Node 24 TCP relay on the Mac (test plumbing; a direct LAN connection is refused for the Electron binary). The production `windows-pc` worker was neither stopped nor reconfigured. Worker bundle needed a stub `electron` module and `NODE_PATH` to the existing checkout's modules; these are fixture details, not product behaviour.

1. **Check 1, online dispatch: PASS.** Roster showed only the disposable node, connected, win32, Claude available. Parent `cl68ybyw5` (`forceNodeId`, `yoloMode:false`) went idle with `executionLocation` remote on that node. `sideChatCreate` then `sideChatSend` (06:42:57Z) returned ok. The assistant reply read `C:\Users\shutu\.orchestrator\_scratch\aio-transfers\session-sidechat-lt646c67\workspace`; the sidechat runtime `cirj3tgdz` was remote on the same node, same directory, processId -1. The parent output buffer was empty before and after. The worker's own log shows two Windows `claude.exe` launches and `Provider turn completed ... end_turn` at 06:43:00Z.
2. **Check 2, unavailable worker: PASS.** The disposable worker was stopped on Windows at 06:43:40Z; the roster showed it `disconnected` 16 s later. Sends to the same sidechat at 06:44:19Z and 06:44:33Z both failed with `SIDE_CHAT_SEND_FAILED: Node not connected: a6712304-aa84-4151-8a41-d24a0543a4c9`. No new instance appeared (`newInstanceIds: []`), all instances stayed remote on the lost node with processId null or -1, and the coordinator lifecycle log has no spawn event. No local replacement process.

Wording difference: the 2026-11-04 run recorded `Forced worker node "..." is unavailable (not found)`. This run left the node known to the app but disconnected, with a live sidechat runtime bound to it, so the send reached that runtime and failed with "Node not connected". Both are explicit refusals naming the worker with no local fallback. The "not found" wording needs the node removed from the roster and was not re-run. The sibling campaign's LT-1019 (inconsistent send errors for about 30 seconds after worker loss) is a separate open observation; the sends here came 39 and 53 seconds after the stop and were consistent.

Earlier attempts in the same bundle (`receipts/attempt1-*`, `attempt2-*`) hit fixture limits: missing `better-sqlite3`, then `Worker at capacity (1 instances)`. Not counted as results.

Cleanup: worker stopped, 11 uploaded files (including every launcher that held a pairing token) and the workspace folder removed from Windows, helper agents terminated, pairings and the disposable node revoked, dev app closed, relay and static server killed, ports closed, `/tmp` profile and `dist/` removed. Not tested: production OS sandboxing and desktop focus (test-only `--no-sandbox --disable-gpu`), and direct LAN connection without the relay.

Process note: the dev app window ran on this Mac as the task's instructions required; no everyday browser was driven.

> Closure history: `2026-10-27-session-sidechat-remediation_livetest_history_31f91d7e8c8a43db75522442d6d4889152d5d289e87a98195aa7620b39702d56_completed.md`.
