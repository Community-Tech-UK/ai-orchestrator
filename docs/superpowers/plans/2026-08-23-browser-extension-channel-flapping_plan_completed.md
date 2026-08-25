# Browser-Extension Channel Flapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep transient `windows-pc` worker WebSocket losses from churning remote-browser state, and safely redeliver a browser command when its poll response provably never left the coordinator.

**Architecture:** Preserve the existing worker reconnect design, but restore its disconnect grace to the documented 30-second tolerance that covers the observed short-drop distribution. Bind every inbound RPC to a one-shot responder for its originating WebSocket so an old long-poll response can never be written onto a replacement socket. Hold later work behind a per-queue handoff barrier until that response is confirmed; if a non-null browser poll result cannot be written through its responder, move the exact command to the head of its original queue within its original absolute undelivered deadline. Never replay after a response was accepted by its requesting socket because execution would then be ambiguous.

**Tech Stack:** TypeScript, Node.js WebSocket server, Vitest fake timers, Electron main process.

**Spec:** `docs/plans/2026-08-23-browser-extension-channel-flapping-prompt.md`

**Status:** Implementation and agent-runnable verification complete. Rebuilt-runtime checks are
deferred to `2026-08-23-browser-extension-channel-flapping_plan_livetest.md`.

## Global Constraints

- Do not commit, stage, branch, create a worktree, stash, restore, reset, or clean.
- Do not restart the packaged app, `windows-pc` worker, Chrome, or the extension without James's explicit approval.
- Preserve unrelated dirty-tree work.
- Add LT-371 to the remediation register and remediation plan.
- Watch every new regression test fail against pre-fix production behaviour before implementation.
- Run the canonical gates, then the full suite once and alone with `NODE_OPTIONS="--max-old-space-size=8192"`.
- Defer only checks that require rebuilt/restarted software or deliberate interaction with `windows-pc`.

---

### Task 1: Record the corrected diagnosis and acceptance contract

**Files:**
- Modify: `docs/plans/livetest-remediation-register.md`
- Modify: `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`
- Modify: `docs/plans/2026-08-19-remote-node-false-negative-fixes_livetest.md`

**Interfaces:**
- Consumes: coordinator `app.log`, read-only worker-agent logs, `browser.health`, and the existing check-6 evidence.
- Produces: LT-371 with observed behaviour, root cause, required behaviour, acceptance, and an explicit correction that `node_ws_disconnected` originates from the worker-node WebSocket.

- [x] **Step 1: Add LT-371 to the remediation-register index and append its full section**

Record the independently reproduced 30/53 event counts, the 30/30 worker-socket correlation, the 24/30 reconnects within 30 seconds, the continuous extension/native-host heartbeat evidence, the non-periodic timing, and the known poll-response loss.

- [x] **Step 2: Add the matching LT-371 implementation-status section**

Mark it in progress until the regression tests, implementation, full gates, and fresh completion review pass.

- [x] **Step 3: Correct the owning livetest evidence**

State that check 6 remains pending because the deployed packaged app and worker have not yet been rebuilt/restarted and a deliberate generation transition has not been observed after stabilization.

### Task 2: Restore the intended worker disconnect grace

**Files:**
- Modify: `src/main/remote-node/connection-disconnect-lifecycle.ts`
- Test: `src/main/remote-node/__tests__/connection-disconnect-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `ConnectionDisconnectLifecycle.beginGrace(nodeId)` and `cancelOnReregister(nodeId)`.
- Produces: `DISCONNECT_GRACE_MS = 30_000`, keeping registry state, browser attachments, and pending RPCs intact during ordinary short reconnects.

- [x] **Step 1: Write the failing boundary regression**

Add a fake-timer test that begins grace, proves `onTrueDisconnect` and `rejectPending` are untouched at 29,999 ms, then proves both fire at 30,000 ms.

- [x] **Step 2: Run the focused test and observe the pre-fix failure**

Run `npm run test:quiet -- src/main/remote-node/__tests__/connection-disconnect-lifecycle.spec.ts`. Expected pre-fix failure: the callbacks have already fired after 2,500 ms.

- [x] **Step 3: Change the grace constant and its contract comment**

Set `DISCONNECT_GRACE_MS` to `30_000` and explain that it covers transient network/route recovery while still surfacing sustained disconnections promptly.

- [x] **Step 4: Re-run the focused test**

Expected: the lifecycle spec passes.

### Task 3: Requeue a browser poll result that provably was not sent

**Files:**
- Modify: `src/main/browser-gateway/browser-extension-command-store.ts`
- Modify: `src/main/browser-gateway/remote-extension-bridge.ts`
- Modify: `src/main/remote-node/worker-node-connection.ts`
- Modify: `src/main/remote-node/rpc-event-router.ts`
- Test: `src/main/browser-gateway/browser-extension-command-store.spec.ts`
- Test: `src/main/remote-node/__tests__/rpc-event-router.spec.ts`

**Interfaces:**
- Produces: `BrowserExtensionCommandStore.requeueUndeliveredCommand(queueKey: string, commandId: string): boolean`.
- Produces: `BrowserExtensionCommandStore.confirmCommandHandoff(queueKey: string, commandId: string): boolean`.
- Produces: `RemoteBrowserExtensionBridge.requeueUndeliveredCommand(nodeId: string, commandId: string): boolean`.
- Produces: `RpcRequestResponder = (response: RpcResponse) => boolean`, a one-shot closure bound to the inbound request's originating WebSocket.
- Changes: `WorkerNodeConnectionServer.sendResponse(nodeId: string, response: RpcResponse): boolean`, retaining explicit status for unbound/internal callers.
- Consumes: the original absolute undelivered deadline stored on each pending browser command.

- [x] **Step 1: Write the command-store failing regression**

Prove a receipt-capable command handed to a poller can be returned to the queue after the coordinator detects an unsent response, is delivered by the next poll with the same id, does not fire `browser_extension_command_receipt_missing`, and resolves normally after receipt/result.

- [x] **Step 2: Write the router failing regression**

Make the originating request responder return `false` for a non-null `browser.ext.pollCommand` result and assert `requeueUndeliveredCommand(nodeId, command.id)` is called exactly once. Also assert a `null` long-poll result is never requeued.

- [x] **Step 3: Run both focused specs and observe the pre-fix failures**

Run `npm run test:quiet -- src/main/browser-gateway/browser-extension-command-store.spec.ts src/main/remote-node/__tests__/rpc-event-router.spec.ts`. Expected pre-fix failures: missing requeue methods and `sendResponse` has no delivery result.

- [x] **Step 4: Implement bounded store requeueing**

Store `undeliveredDeadlineAt = Date.now() + undeliveredWaitMs`, share the undelivered timeout arming logic, and allow requeue only for a live pending command on the same queue with `dequeuedAt` set and `receivedAt` unset. Clear the receipt/execution timer, restore queued state, and re-arm only the remaining original deadline. If the absolute deadline has elapsed, reject as `browser_extension_command_not_delivered` without enqueueing.

- [x] **Step 5: Expose the operation through the remote bridge**

Translate `nodeId` to `browserExtensionQueueKeyForNode(nodeId)` and delegate without changing contact telemetry.

- [x] **Step 6: Return response handoff status and wire the router**

Pass a one-shot socket-bound responder with every inbound RPC. It returns `false` when the requesting socket is closed or has been replaced, even if the same node id has a new open socket. In `handleBrowserExtPollCommand`, requeue only a non-null command whose responder returned `false`; do not replay asynchronous write errors or any response accepted by the originating socket.

- [x] **Step 6a: Cover the completion-gate socket-replacement finding**

Regression-test old poll → old socket closes → same node re-registers → command resolves the old poll → the old response is rejected instead of written to the replacement socket → the same command id is served once to the new poll.

- [x] **Step 6b: Cover the completion-gate FIFO-ordering finding**

Defer advancement of a remote queue until its current poll response handoff is confirmed. On a failed
handoff, put the uncertain command back at the head so it precedes later work; if its original delivery
deadline has elapsed, reject it and release the barrier so later work is not stranded. Regression-test
overlapping old/replacement polls with `navigate` followed by `click`, plus the expired-deadline path.

- [x] **Step 7: Re-run focused regression suites**

Expected: lifecycle, command-store, router, remote-bridge, and worker connection/grace specs pass.

### Task 4: Verify and prepare the live deployment check

**Files:**
- Create: `docs/superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md`
- Modify: `docs/superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan.md`
- Modify: `docs/plans/livetest-remediation-register.md`
- Modify: `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`

**Interfaces:**
- Consumes: all implementation and test changes from Tasks 2–3.
- Produces: current automated verification evidence and exact rebuilt-app/worker live checks without claiming deployment.

- [x] **Step 1: Run targeted verification**

Run the focused Vitest files for lifecycle, connection grace, command store, remote bridge, and RPC router.

- [x] **Step 2: Run the canonical project gates**

After checking one-minute load is below 30, run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and `npm run build:main`.

- [x] **Step 3: Run the full suite once, alone**

Run `NODE_OPTIONS="--max-old-space-size=8192" npm run test:quiet` without a pipe and record the actual exit status.

- [x] **Step 4: Run the independent completion gate**

Give a fresh agent the prompt, this plan, working-tree diff, and acceptance criteria; require the `task-completion-gate` skill and `VERDICT: PASS` with no actionable findings. Fix and repeat with another fresh agent if needed.

- [x] **Step 5: Write the live-test deferral**

Require a rebuilt/restarted packaged app containing the coordinator changes; no extension, native-host,
or worker deployment is needed for LT-371 itself. Observe at least one natural short node-WebSocket
interruption or a James-approved controlled network interruption, confirm no
`node_disconnect`/attachment churn inside 30 seconds, confirm a poll response lost before socket handoff
is redelivered in FIFO order without `receipt_missing`, then run check 6's deliberate Chrome generation
transition and 10–15 minute prune observation.

- [x] **Step 6: Close the implementation documents**

Update as-built/status evidence, rename this file to `2026-08-23-browser-extension-channel-flapping_plan_completed.md` last, and leave the `_livetest.md` file pending until its rebuilt-runtime checks pass.

## As-built verification — 2026-08-23

- Focused LT-371 regressions: 6 files, 90 tests passed.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run build:main`: passed.
- `npm run check:ts-max-loc`: LT-371 files passed; the repository gate remains red only for unrelated
  concurrent work in `src/main/history/history-manager.ts` (1,572 lines against a 1,478 + 50 ceiling).
- Current real-checkout full suite, independently rerun by the completion reviewer: 18,555/18,556
  passed; the sole failure is unrelated concurrent work in
  `src/main/session/session-continuity.spec.ts`.
- Three fresh completion-gate reviews were used across the fix/review cycles. The first found the
  replacement-socket response bug, the second found FIFO inversion, and both were fixed with new
  regressions. The final reviewer returned `VERDICT: PASS` with no actionable findings.
- No packaged app, worker, Chrome, extension, or native host was restarted or deployed. The exact
  remaining checks and prerequisites are recorded in the linked `_livetest.md` document.
