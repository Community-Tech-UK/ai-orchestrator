# WS15 Worker-Node Streaming Durability — Live Test

## Current status — 2026-09-27 (current checkout)
Open: 0 · Closed: 7 · Failed: 0

All seven checks are closed. The 2026-09-27 disposable-worker run revalidated checks 2
and 3 on the current checkout after the LT-541 and LT-542 ports: a healthy-link reply
arrived, outage output replayed exactly once and matched the worker transcript byte for
byte, a work RPC parked and survived a reconnect inside the 60-second window, and a
separate work RPC rejected 60,003 ms after parking when the reconnect window elapsed.
The full current-checkout evidence is recorded below. The current
[remediation register](livetest-remediation-register.md) tracks the defects and their
live-verification state.

## Status — 2026-09-20 (queue-branch evidence; superseded for current closure)
Open: 0 · Closed: 7 · Failed: 0
All seven checks passed on the queue branch. Checks 2, 3 and 5 were re-run on 2026-09-20 against
that branch's source with the disposable-worker harness; see [Evidence run — 2026-09-20 (queue worker)](#evidence-run--2026-09-20-queue-worker).
Two new defects were found and fixed during that run — **LT-541** (every remote assistant reply silently
dropped on a healthy link) and **LT-542** (the parked-work window never opened on a heartbeat-timeout
disconnect). Check 5 passed with one recorded method deviation (ring capacity reduced on the live worker
rather than 4 MB of real output generated); see that check's entry.

> **Register history.** These entries first lived only on
> `queue/2026-07-13-fable-ws15-332c74`. They are now also in the root checkout's
> [remediation register](livetest-remediation-register.md), where their current
> status is **REOPENED — ported to the working tree; live re-check pending**. The
> matching implementation-status sections are in
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`.

### Status — 2026-09-06 (superseded)
Open: 1 · Closed: 4 · Failed: 2
Agent-runnable now: checks 2, 3, 5 can all be re-run today with the self-contained disposable-worker harness proven 2026-08-25 (an isolated dev app + a from-source worker-agent build, both on loopback) — no dependency on James's live worker or the packaged app remains.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-13-fable-implementation-plan_completed.md](2026-07-13-fable-implementation-plan_completed.md) (§WS15)

**Prerequisites:** rebuilt app AND redeployed worker agent (`npm run build:worker-dist` + redeploy — BOTH sides must carry the WS15 protocol; a legacy worker against a new app, and vice versa, must behave exactly as today). The doc originally called for "a remote node connected over a link you can interrupt (Wi-Fi toggle or `sudo pfctl` rule)" against James's real worker — superseded 2026-08-25 by the disposable-worker method below, which needs neither James's node nor an interruptible physical link.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1 — Handshake flag (incl. "no durability lines for LEGACY workers") | 2026-07-26; legacy half closed 2026-08-25 | `StreamDurability` epoch line matches node's `workerAgent.startedAt` exactly; legacy sub-part confirmed via check 6's pre-WS15 build — no `Worker stream epoch changed` line ever logged for it, `streamDurability`/`streamEpoch` both `undefined` |
| 4 — Worker restart resets cursors (epoch guard) | 2026-07-26 (epoch guard), completed 2026-08-01 (fresh-turn follow-on traffic) | `run_on_node` after a real worker restart: seq restarts cleanly at 0/1, `lastSeq: 1`, zero duplicate/gap/out-of-order lines in coordinator log |
| 6 — Legacy worker regression | 2026-08-25 (Batch E) | Built pre-WS15 commit (`0d140701d`, parent of the squashed WS15 landing `c3d3714ad`) from `git archive`, paired to an isolated dev app; no durability lines logged, real round-trip turn succeeded, `resumeNode()` structurally never attempts `node.streamResume` against it. Residual not independently observed: a live link drop against this specific legacy node (follows from the same structural guards, per the doc's own reasoning, but not directly witnessed) |
| 7 — Notification typed failure | 2026-08-25 (Batch E) | Called `getWorkerNodeConnectionServer().sendNotification()` directly via Node Inspector against a genuinely deregistered node; returned `false`, `app.log` logged "notification NOT delivered" with correct nodeId/method, no exception |

## Checks 2, 3 and 5 — history and current result

### 2. Gap-free delivery across a real drop — PASSED 2026-09-20 (was FAILED, LT-524)
- Steps: start a long-running remote turn producing steady output. Kill the network link for ~20 s (longer than the 2.5 s grace), then restore it. The worker process must stay alive throughout.
- Expected: on reconnect the app log shows "Durable stream resume completed" with a replayed count > 0; the transcript contains the output produced DURING the outage, in order, with no duplicates (seq-consecutive; compare against the worker's local log).
- Result (2026-08-25, disposable-worker method): reproduced twice. A complete, real assistant response was generated entirely during the outage (confirmed via the Claude CLI's own on-disk transcript) but never reached the coordinator — zero "Durable stream resume completed" lines, `outputBuffer` contained only the user message, no error, no gap marker. Root cause: `StreamDurabilityCoordinator.resumeNode()` early-returns when `state.cursors.size === 0` (`stream-durability-coordinator.ts:97-100`) — a turn whose entire output window falls after the drop has no pre-existing cursor and is never asked about at all. Filed as **LT-524** (P1 — silent, permanent data loss on losing the link right after sending a message).
- Caveat: this reproduction's timing (block enabled before any output arrived) differs from the check's literal wording (cutting the link after output is already "steady") but is a more severe variant of the same failure; the check's core expectation is directly falsified either way.
- Historical (2026-08-31 remediation note): LT-524 was fixed in code — durable registration now sends a resume RPC even with an empty cursor set, and the worker discovers every buffered ring absent from the coordinator's cursor list at sequence zero. Failing-first tests cover empty/offline-only/mixed cursor cases. Live re-check was still outstanding at that point.
- **Result (2026-09-20): PASS.** A 4021-character assistant response produced entirely inside a 145 s outage was replayed on reconnect (`Durable stream resume completed { instances: 1, replayed: 3 }`), landed in the transcript once, in order, with its original timestamp, and matched the worker's own on-disk transcript exactly. Full detail in [Evidence run — 2026-09-20](#evidence-run--2026-09-20-queue-worker). The run also uncovered **LT-541**, which had been discarding every remote assistant reply on a healthy link and had to be fixed before this check could be evaluated at all.

### 3. Parked work RPC completes after reconnect — PASSED 2026-09-20 (was FAILED, LT-525 + LT-542)
- Steps: send a prompt that runs a long turn (e.g. 2-minute task); drop the link ~10 s in; restore within 60 s.
- Expected: log shows "Parking in-flight work RPCs for durable worker reconnect" then "Durable worker reconnected — parked work RPCs resume"; the turn COMPLETES normally (no "Node disconnected" error for the sendInput RPC). Past 60 s without reconnect: the work RPC fails with "(parked-work window elapsed)".
- Result (2026-08-25, disposable-worker method): the literal "Parking in-flight work RPCs" / "parked-work window elapsed" log lines were never observed either way — `sendInput` itself always acks in 2-5ms (it only confirms stdin queuing, not turn completion), so no run cleanly caught a work RPC itself in flight at drop time. Separately found and reproduced twice: an instance genuinely `processing` when its node disconnects does not complete normally after reconnect — it gets stuck in `degraded` status indefinitely because `WorkerNodeRegistry.onReconnect` (`node-failover.ts:119-140`) tries to restore it straight to `processing`, which the state machine disallows from `degraded` (`instance-state-machine.ts:161`, `IllegalTransitionError`, swallowed generically). Only recovered via an incidental manual `sendInput()`. Filed as **LT-525** (P1).
- Historical (2026-08-31 remediation note): LT-525 was fixed in code — `degraded` can now restore every nonterminal remote lifecycle state, and reconnect reconciliation isolates per-instance failures so one bad transition cannot reject registration or strand later instances. Failing-first state-machine and failover tests cover both requirements. Live re-check was still outstanding at that point.
- Correction to the 2026-08-25 note above: `sendInput` does **not** ack in 2-5 ms on this path. `RemoteCliAdapter.sendInput()` dispatches with `timeoutMs: 0`, so the RPC stays pending for the whole turn — the coordinator logged `inFlightWork: 1` with `oldestInFlightMs: 95291` at socket close. The parking lines were missing for a different reason, filed here as **LT-542**: `isDurableNode()` read durability off a registry entry the health monitor had already deleted, so every durable worker looked non-durable at grace expiry and its in-flight turn was aborted instead of parked.
- **Result (2026-09-20, after fixing LT-542): PASS, both branches.** Reconnect inside the window produced `Parking in-flight work RPCs for durable worker reconnect { windowMs: 60000 }` → `Durable worker reconnected — parked work RPCs resume` → `Durable stream resume completed`, with no `Node disconnected` error and the instance back to `idle` unaided (which also closes the LT-525 residual). A separate 210 s outage produced the `(parked-work window elapsed)` rejection exactly 60 s after parking. Full detail in [Evidence run — 2026-09-20](#evidence-run--2026-09-20-queue-worker).

### 5. Ring overflow surfaces a gap marker — PASSED 2026-09-20 (method deviation recorded)
- Steps: with the link down, generate > 4 MB (or > 500 events) of output for one instance, then reconnect.
- Expected: replay delivers the most recent events and the transcript shows the "⚠️ Some output … was lost" system marker (never silent truncation).
- Historical (why it was not run before): `DEFAULT_MAX_EVENTS_PER_INSTANCE = 500` (`worker-stream-durability.ts`). Given LT-524, the ring this check needs to overflow was never queried unless the coordinator already held a cursor for the instance from before the drop, and the 2026-08-25 session's block timing never exercised that path.
- **Result (2026-09-20): PASS, with a recorded method deviation.** A baseline turn established cursor 4; the ring's `maxEventsPerInstance` was then set to 2 on the live worker (restored to 500 afterwards) instead of generating 4 MB of real output, which the Claude CLI's own tool-output truncation makes impractical and which >500 events cannot reach inside one 90 s disconnect window. Everything else is the real path. After one real turn during the outage the ring held events `[7, 8]` with `droppedThroughSeq: 6` against cursor 4; on reconnect `Durable stream resume completed { instances: 1, replayed: 2 }` and the transcript gained the `⚠️ Some output from this remote session was lost … (events up to #6 were dropped from the worker's replay buffer)` system message with `metadata.source: "stream-durability-gap"`. Full detail in [Evidence run — 2026-09-20](#evidence-run--2026-09-20-queue-worker).

## Evidence run — 2026-09-27 (current checkout)

Checks 2 and 3 were re-run from the root checkout against a fully isolated dev app and
disposable worker. The coordinator used renderer CDP port 9761 and worker WebSocket port
4967; the worker used Node Inspector port 9763. The app was launched with
`--no-sandbox --disable-gpu` because Chromium utility processes cannot initialize their
sandbox inside this agent shell. Those flags affect Chromium process startup only; the
real coordinator, worker-agent, WebSocket, Claude CLI and durable-streaming paths all ran
unchanged. The worker registered as node
`15000000-0000-4000-8000-000020260927`; the remote instance was `c7019vnge` and the
worker-side provider session was `ff5eeb1b-26d0-485a-af26-160218f6006b`. None of James's
real worker nodes was touched.

### Check 2 — healthy link and gap-free replay: **PASS**

- A healthy-link baseline prompt returned exactly `WS15-BASELINE-OK`, proving that the
  ported LT-541 ordering fix delivers ordinary assistant output before any interruption.
- Worker outbound writes were blocked at `1790480730595`; `instance.sendInput` dispatched
  as `coord-18` at `1790480734059`. The Claude CLI produced the complete response at
  `1790480765183`, while the link was still blocked.
- The coordinator deregistered the silent node at `1790480823801`, parked the in-flight
  work RPC at `1790480853809`, and the worker re-registered at `1790480879852` after the
  scheduled 145-second interruption. The log then recorded
  `Durable stream resume completed { instances: 1, replayed: 4 }`.
- The coordinator transcript contained exactly one matching assistant reply: 302 lines
  total, markers at both ends, and all 300 numbered lines unique and in exact order. Its
  assistant timestamp remained `1790480765183`, the original worker timestamp.
- The worker's Claude JSONL transcript contained exactly one matching assistant text
  block. It matched the coordinator text byte for byte: 5,747 characters and SHA-256
  `4206923832c5ebd9afb344e2b2b9cc595a03a6bf4b1313679db3a6fa55f9fbfa` on both sides.
- The instance returned to `idle` without intervention. No replay gap, duplicate or
  transport error was observed.

### Check 3 — parked-work reconnect window, both branches: **PASS**

- **Inside the window.** The same 145-second interruption held a real `instance.sendInput`
  RPC in flight. The coordinator logged `Parking in-flight work RPCs for durable worker
  reconnect { windowMs: 60000 }` at `1790480853809`, then `Durable worker reconnected —
  parked work RPCs resume` at `1790480879852`, about 26 seconds later. The promise was not
  rejected, replay delivered the completed turn, and failover reconciliation restored the
  instance to `idle` unaided.
- **After the window.** A second interruption swallowed 236 worker writes for 210 seconds.
  `coord-43` dispatched at `1790481087378`; heartbeat timeout closed the socket with real
  work in flight at `1790481179920`; the coordinator parked work at `1790481209921`.
  `coord-43` then rejected at `1790481269924` with `SEND_FAILED: Node disconnected:
  15000000-0000-4000-8000-000020260927 (parked-work window elapsed)`, exactly 60,003 ms
  after parking. The worker's block released at `1790481294058`, it re-registered at
  `1790481298930`, durable replay reported four events, and reconciliation restored the
  instance to `idle`.

### Cleanup

The test instance was terminated and `listInstances()` returned `[]`; the remote-node
server stopped; the worker exited cleanly on SIGINT; ports 4967, 9761 and 9763 had no
listeners; and the isolated `/tmp/aio-lt-ws15-runtime.zNcbSU` directory, including its
one-time pairing material, was removed after `lsof +D` showed no open handles. The shared
renderer dev server on port 4661 was intentionally retained for later campaign checks.

## Method for checks 2, 3, 5 (reusable — no James/production worker needed)

Proven 2026-08-25 (Batch E). A fully disposable worker-agent process, paired to an isolated
dev-app coordinator over loopback, is a real worker node connected over a real, agent-controlled
link — nothing in the check text requires it to be James's own node. None of James's real nodes
(`windows-pc`, `Noah3900x`, `noahlaptop`) need to be touched.

1. Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-<id>`, a dedicated `--remote-debugging-port`).
2. `npm run build:worker-agent` → `dist/worker-agent/index.js`, a standalone Node CJS bundle.
3. Set `remoteNodesEnabled`/`remoteNodesServerPort`/`remoteNodesServerHost` via `setSetting` on the
   dev app's own profile and **restart the dev app** — these are `readOnly()`-gated for the
   `set_setting` MCP tool only, not for the renderer's own settings IPC. Setting them without a
   restart starts only the WS listener with nothing subscribed to `rpc:request`; registration then
   silently never reaches the registry. (Cost real time to diagnose 2026-08-25 — do not repeat.)
4. `remoteNodeIssuePairing()` → a one-time credential; `node dist/worker-agent/index.js pair
   '{"authToken":...,"host":"127.0.0.1","port":<port>,...}' --config <path> --start` registers a
   real, disposable worker that appears in `remoteNodeList()` as `connected` with a full capability
   report (`streamDurability: 1`, `streamEpoch`, real CPU/mem/CLI capabilities).
5. `createInstance({ provider: 'claude', forceNodeId: <this node>, ... })` → genuine
   `executionLocation: { type: 'remote' }`, runs for real on the disposable worker.
6. To interrupt only the *link*, not the worker process: relaunch the worker under
   `node --inspect=<port>` and install a `net.Socket.prototype.write` monkeypatch over the Node
   Inspector Protocol (`process.mainModule.require('net')` — `require` is not in scope for a bare
   `Runtime.evaluate`) that silently swallows only outbound writes on the socket to the coordinator
   port while a global flag is true. The worker process and its spawned CLI child keep running and
   producing real output throughout, matching "the worker process must stay alive."
7. **Asymmetry gotcha:** blocking only the outbound direction is asymmetric. The coordinator's own
   forced close (once its 90s heartbeat-timeout fires) is a write on the *coordinator's* socket,
   unaffected by a worker-side patch — but the worker's automatic close-frame reply IS a worker-side
   write, and if still blocked, the client socket wedges in `CLOSING` forever with no reconnect
   attempt. Fix: schedule the unblock with an in-process `setTimeout` installed in the same Inspector
   call that enables the block (removes round-trip latency from the race); if a socket is ever found
   wedged in `CLOSING`, enumerate `process._getActiveHandles()` for the matching `net.Socket` and call
   `.destroy()` on it directly.
8. Coordinator-side introspection: `kill -USR1 <electron main pid>` opens the Node inspector on port
   9229 (no restart needed), from which `process.mainModule.require(<absolute path into dist/main>)`
   reaches the live singletons (`getWorkerNodeConnectionServer()`, etc.).

**Cleanup each run:** terminate all test instances (`terminateInstance()`, confirm via
`listInstances()`); kill both worker processes by exact pid; sweep `ps` for stray CLI children; tear
down the `/tmp/aio-lt-*` dev-app profile and any legacy-build checkout.


## Evidence run — 2026-09-20 (queue worker)

Run from the queue worktree `queue/2026-07-13-fable-ws15-332c74` on branch
`queue/2026-07-13-fable-ws15-332c74`, using the disposable-worker method recorded above.

**Environment.** Isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-03332c74`,
`--remote-debugging-port=9629`, focus emulation enabled on every CDP connection, a production renderer
build served statically on `127.0.0.1:4629` with `PORT=4629` so the dev app loads it). Coordinator WS
server on `127.0.0.1:9647`. Disposable worker built from this worktree
(`npm run build:worker-agent`), paired over loopback, run under
`node --inspect=127.0.0.1:9630`, registering as node `dd1ff360-…` with `streamDurability: 1`. None of
James's real nodes were touched. Coordinator internals were read live through the Electron main inspector
(`kill -USR1`, port 9229) with read-only wrappers around
`registry.on('remote:instance-output')`, `connection.on('rpc:notification')`,
`StreamDurabilityCoordinator.prototype.accept` and `…prototype.resumeNode`.

**Link interruption.** A `net.Socket.prototype.write` patch inside the worker swallows only outbound writes
to port 9647, leaving the worker process and its Claude CLI child running and producing real output. The
coordinator therefore stops receiving heartbeats and tears the connection down on its own
`DISCONNECT_THRESHOLD_MS = 90_000` path. Unblocking destroys the coordinator socket, which is what a restored
link leaves behind. Deviation from the check text: the outage is ~145 s rather than "~20 s", because a 20 s
outage never reaches the coordinator's disconnect threshold and so exercises no durability at all.

### Blocking defect found first: LT-541

Before any link interruption, the baseline turn failed. `Reply with exactly the word BASELINE-OK` produced
`assistant | 17:08:32 | BASELINE-OK` in the Claude CLI's own transcript
(`~/.claude/projects/-private-tmp-aio-lt-ws15-worker-work/<session>.jsonl`) and nothing in the instance's
`outputBuffer`. Four more probes and a 400-word essay behaved identically — across the whole session
`registry.emit('remote:instance-output')` fired **zero** times.

```
notif  instance.context  seq 18                              t=…497607
notif  instance.output   seq 17  assistant "PROBE6-OK"       t=…497659
notif  instance.complete seq 19                              t=…497679
accept durableSeq=18 cursorBefore=16 accepted=true
accept durableSeq=17 cursorBefore=18 accepted=false   ← the assistant reply
accept durableSeq=19 cursorBefore=18 accepted=true
```

The worker batches `instance.output` on a 50 ms timer while `instance.context`/`instance.complete` go out
immediately, so a later-recorded frame overtook the reply with a higher `durableSeq`, and the coordinator's
strict high-water-mark cursor discarded the reply as a replay duplicate — at `debug` level, so invisibly.
Present since the WS15 landing commit `c3d3714a` (2026-07-17). Filed as **LT-541** (P0) and fixed in this
branch; checks 2, 3 and 5 could not be evaluated at all until it was. After the fix and a rebuild of both
halves, the same probe produced ascending seqs 1→4, all accepted, and `FIXED-OK` in the transcript.

### 2 — Gap-free delivery across a real drop: **PASS**

- Baseline turn first, so the coordinator held a real cursor (`[56b9b818-…, 4]`) before the drop.
- Outbound writes blocked at 17:39:04; `instance.sendInput` dispatched immediately after
  (`requestId: coord-12`). The Claude CLI produced the full 4021-character essay at **17:39:23**, entirely
  inside the outage, confirmed in its own on-disk transcript.
- 17:40:39 coordinator heartbeat timeout → deregister → socket close (`inFlightWork: 1`).
- 17:41:33.786 worker re-registered; 17:41:33.791
  `StreamDurability | Durable stream resume completed { instances: 1, replayed: 3 }`.
- The instance transcript then contained the essay exactly once, at its **original** 17:39:23 timestamp and
  the same 4021 characters as the response in the worker's own transcript. No duplicates, no out-of-order
  entries, and the instance returned to `idle`.

### 3 — Parked work RPC completes after reconnect: **PASS** (after fixing LT-542)

First attempt reproduced a second defect. `RemoteCliAdapter.sendInput()` dispatches with `timeoutMs: 0`, so
the work RPC genuinely is in flight for the whole turn — the 2026-08-25 note that "no run cleanly caught a
work RPC in flight" was the wrong diagnosis. What actually happened:

```
17:25:49 Node deregistered
17:25:49 Worker WebSocket closed   registryNode:"absent"  inFlightWork:1
17:26:19 Remote node: work aborted — node disconnected  method:instance.sendInput
                                     reason:"Node disconnected: <nodeId>"
```

No parking line at all. `isDurableNode()` read `streamDurability` from the node registry, but
`NodeHealthMonitor` deregisters a silent node *before* closing its socket, so at grace expiry every durable
worker looked non-durable. Filed as **LT-542** (P1) and fixed by recording the handshake value in
`ConnectionDisconnectLifecycle` itself.

Re-run after the fix, both branches of the check:

- **Reconnect inside the window (145 s outage).**
  `17:41:09.513 Parking in-flight work RPCs for durable worker reconnect { windowMs: 60000 }` →
  `17:41:33.786 Durable worker reconnected — parked work RPCs resume` →
  `17:41:33.788 Node failover: node reconnected — reconciling instances` →
  `17:41:33.791 Durable stream resume completed { instances: 1, replayed: 3 }`.
  The `sendInput` promise was **never** rejected (no `Node disconnected` error), the turn's output arrived,
  and the instance went back to `idle` with no manual intervention — which also closes the LT-525 residual
  (an instance `processing` at disconnect recovering without a nudge).
- **Reconnect after the window (210 s outage).** At `17:45:03.818`, exactly 60 s after parking, both
  in-flight `instance.sendInput` RPCs were rejected with
  `Node disconnected: <nodeId> (parked-work window elapsed)`.

Note on the RPC promise in the inside-window case: it stays pending rather than resolving, because the
worker's response frame was produced during the outage and is genuinely gone. That is correct for a real
link loss — the turn completes over the durable notification stream, not over the RPC — and it satisfies the
check's stated expectation of no `Node disconnected` error.

### 5 — Ring overflow surfaces a gap marker: **PASS** (method deviation)

- Fresh instance, baseline turn to establish cursor 4. Ring inspected live (see below): seqs 1–4,
  `droppedThroughSeq: 0`.
- **Deviation:** rather than generating >4 MB of real output, `maxEventsPerInstance` was set to 2 on the
  live ring and restored to 500 afterwards. Generating 4 MB through the Claude CLI is not practical — it
  truncates its own tool results well below that — and >500 events would need ~140 turns, which the
  coordinator's 90 s disconnect threshold makes impossible inside one outage. Everything else is the real
  path: real CLI output, real `record()` eviction, real `replayAfter()` gap detection, real coordinator
  marker. Only the ring's capacity constant was changed.
- Reaching the ring: the worker bundle exports nothing and holds no global, so the live instance was found
  through the Inspector — the bundle's whole module scope is visible as a closure scope of any top-level
  function, giving the `WorkerStreamDurability` binding, and `Runtime.queryObjects` on its prototype returned
  exactly one live object. (A first attempt used an unbounded property BFS and crashed the worker's V8
  inspector; the scoped walk in `_scratch/lt-ws15/node-inspect-classinstance.mjs` is the safe version.)
- Link blocked at 17:48:59, one real turn run during the outage. Ring after the turn: events `[7, 8]`,
  `droppedThroughSeq: 6`, against a coordinator cursor of 4 — i.e. genuinely evicted unacked events inside
  the range the resume would ask for.
- 17:51:28.977 `Durable stream resume completed { instances: 1, replayed: 2 }` and the transcript gained:

  > ⚠️ Some output from this remote session was lost while the worker connection was down (events up to #6
  > were dropped from the worker's replay buffer).

  `metadata.source: "stream-durability-gap"`. The most recent surviving events were replayed and the loss was
  surfaced explicitly rather than silently truncated.

### Verification

`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run build:worker-agent` and `npm run test:quiet` were
run on the branch after the fixes. Harness scripts are kept in `_scratch/lt-ws15/`.

### Cleanup

Test instances terminated (`listInstances()` returns `[]`), disposable worker killed, dev app stopped,
renderer static server stopped, `maxEventsPerInstance` restored to 500. No automations were created and no
settings outside the disposable `/tmp/aio-lt-queue-03332c74` profile were changed.

### As-built follow-up — 2026-09-20 (verification round 1)

An independent verifier reported that LT-541 and LT-542 were missing from the remediation register.
Re-checked directly: **they are present**, and have been since the branch's checkpoint commit
`b671e231`. The verifier grepped the root checkout, which is on `main` and does not carry this
branch's commits; the register is a tracked file, so per the queue rules its edits belong in the
worktree. Confirmed in the worktree at the start of this round, before any round-1 edit: a clean
`git status --short`, a 151-line register diff between the merge-base `f3e4ad91` and the checkpoint
commit `b671e231`, index rows in the Remediation Index table, and full sections
(observed behaviour / root cause / required behaviour / fix / acceptance) at the end of the file. (The
working tree is no longer clean — the corrections listed below are exactly what now shows as modified.) The
pointer added to the Status block above records where to look so the next reader does not repeat the
miss. `LT-539`/`LT-540` belong to the concurrent WS13 campaign, so the two new IDs do not collide.

Chasing that finding did surface three real documentation defects, all corrected in the worktree:

1. **LT-542's "Fix" paragraph named symbols that do not exist.** It described a `nodeStreamDurability`
   map on `WorkerNodeConnectionServer` read by `isDurableNode()`. The shipped fix instead moved the
   state into the object that makes the decision: `worker-node-connection.ts:582` calls
   `ConnectionDisconnectLifecycle.noteNodeDurability()`, the lifecycle stores it in its own
   `nodeDurability` map (`connection-disconnect-lifecycle.ts:57-64`), `beginGrace`'s expiry callback
   reads that map (`:75`), the per-node entry is deleted there before `onTrueDisconnect` (`:81`), and
   `clearAll()` (`:111`) — called from `stop()` (`worker-node-connection.ts:157-171`) — clears it. The
   `isDurableNode` dependency callback is gone. The paragraph now matches the code. The root-cause
   section's quotation of the old `isDurableNode` callback is historically correct and was left as-is:
   `git grep isDurableNode f3e4ad91` still shows it at `worker-node-connection.ts:68`.
2. **A stale line citation.** `worker-node-health.ts:100-111` → `:100-112`; `deregisterNode` is at
   :106 and `disconnectNode` at :112, which is the ordering the root cause depends on.
3. **LT-524 and LT-525 still read "live re-check pending".** That re-check is exactly what checks 2
   and 3 closed on 2026-09-20. Both index rows and both full sections now record
   `FIXED + LIVE-VERIFIED 2026-09-20`, keep the 2026-08-31 phrasing as a superseded status, link this
   evidence run alongside the Batch E one, and cross-link the defect each run uncovered.

Re-verification after those edits (worktree, 2026-09-20):

- `npm run test:quiet -- src/main/remote-node/__tests__/stream-durability-coordinator.spec.ts
  src/main/remote-node/__tests__/rpc-event-router.spec.ts
  src/main/remote-node/__tests__/worker-node-connection.spec.ts` → 3 files, 61 tests passed.
- `npm run test:quiet -- src/worker-agent/worker-instance-notifier.spec.ts
  src/main/remote-node/__tests__/connection-disconnect-lifecycle.spec.ts` → 2 files, 25 tests passed.
  (The notifier spec lives at `src/worker-agent/worker-instance-notifier.spec.ts`, not under a
  `__tests__/` directory; a first invocation silently ran only 3 of the 4 paths given.)
- Every spec file named in the LT-541/LT-542/LT-524/LT-525 retest columns was confirmed to exist on
  disk by `find`.
- Round-1 changes were documentation only — no production code was touched — so the full gate suite
  recorded under [Verification](#verification) above still stands; the targeted specs above were
  re-run to confirm the code those paragraphs describe still behaves as written.

> Plan Queue parked work: `queue/2026-07-13-fable-ws15-332c74` — 2 commit(s), reason: land-blocked.
