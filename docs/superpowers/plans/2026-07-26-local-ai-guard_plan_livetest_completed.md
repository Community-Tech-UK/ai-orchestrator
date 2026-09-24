# Local AI Guard Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is not
> automatically a defect, but a *reproduced* one belongs there. Per-check evidence stays in this
> file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild and restart the Harness app from the completed Local AI Guard source,
> use a disposable coordinator-local Ollama endpoint, and pair a disposable worker that advertises
> a disposable Ollama endpoint and can be stopped/restarted without affecting user work. Run in an
> isolated test profile. See the source
> [implementation plan](./2026-07-26-local-ai-guard_plan_completed.md).

## Status — 2026-09-21

Open: 0 · Closed: 6 · Failed: 0
No check in this document is now outstanding. Checks 2 and 5 — the last two — passed on 2026-09-21;
the other four were not re-run today and stand on their 2026-08-18 to 2026-08-25 evidence, unchanged
from the previous status.

Checks 2 and 5 were closed by a disposable worker built for the run — a second worker agent from the
same commit, running on the coordinator Mac under an isolated `HOME` and pointed at an isolated
coordinator port, advertising a disposable Ollama-compatible endpoint — so nothing on `windows-pc`
or any of James's real services was touched. See
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-queue-worker-disposable-worker-checks-2-and-5).

One defect was reproduced while preparing that worker and is filed as
[LT-604](../../plans/livetest-remediation-register.md#lt-604-a-worker-server-started-after-launch-has-no-rpc-router-so-every-worker-stays-disconnected).
It is not a Local AI Guard defect — it is in the remote-node startup wiring — but it blocks worker
enrolment in the guard, so it must be fixed before a worker-local endpoint can be enrolled without
restarting the app.

### Previous status — 2026-09-06

Open: 2 · Closed: 4 · Failed: 0
Needs a disposable worker (or James's explicit authorization to stop/restart real services on
`windows-pc`) to close checks 2 and 5; everything else already passes.

The automated integration suite covers the same coordinator → worker/probe → health → routing →
incident → IPC contracts with real repositories and a native file-backed restart. The two
remaining checks stay open because they require stopping a real endpoint process on a paired
worker without disrupting the work it is actually doing.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Check 1 — Coordinator-local enrolment and health-centre projection | 2026-08-18 (Batch W) | IPC (`localAiGuardValidate`/`localAiGuardCreateTarget`/`localAiGuardRecheck`) — all 4 layers (worker/endpoint/model/inference) `ok`, two evidence timestamps advance; renderer `/local-ai` DOM readout showing Healthy target, per-layer ages, `Routing roles: Compression` (`/tmp/aio-lt-batchW`, port 9451) |
| Check 2 — Worker-local enrolment remains distinct from worker connectivity | 2026-09-21 (queue worker) | Disposable worker `lt-disposable-worker` Connected throughout; stopping only its Ollama endpoint left the `worker` layer `ok` (`workerConnected: true`, `rpcReachable: true`) while the `endpoint` layer failed `connection-refused`; `routableRoles` was already empty at the first captured post-failure check, before any incident existed; incident opened at the 3rd consecutive required failure (and immediately, as `flapping`, on the second reproduction). Rendered `/local-ai` showing `Endpoint · Connection Refused` with `Routing roles: None currently eligible`, alongside Remote Nodes showing the node `Connected` |
| Check 3 — Notify-and-allow paid fallback | 2026-08-18 (Batch W2); LT-189 fix live-verified 2026-08-21 (Batch Q2); fix confirmed committed 2026-08-25 (Batch D) | `local_ai_routing_events` row with populated `target_id`, `disposition: allowed`, `estimated_cost_usd` (post-[LT-190](../../plans/livetest-remediation-register.md#lt-190-local-ai-guard-fallback-cost-estimation-silently-returns-nothing-for-any-real-defaultcli-value)); rendered `.local-ai-fallback-notifications` banner + working `Dismiss` click ([LT-189](../../plans/livetest-remediation-register.md#lt-189)); `localAiGuardGetSummary` 24h panel matching |
| Check 4 — Confirmation wait and resolution | 2026-08-18 (Batch W2); [LT-188](../../plans/livetest-remediation-register.md#lt-188) fixed 2026-08-19 (unit-level); fix confirmed committed 2026-08-25 (Batch D) | `localAiGuardListPendingFallbacks`/`localAiGuardResolveFallback` IPC trace showing pending → allowed transition, no frontier call before resolve; `context-compactor.spec.ts` LT-188 regression block (3 tests, watched-failing revert) |
| Check 5 — Recovery and restart reconstruction | 2026-09-21 (queue worker) | App restarted with the incident open and the endpoint still down: same incident id restored `open`, target `checking` / `routableRoles: []` / `recoveryState: unavailable` — never routable from stale persisted health. Named action surfaced (`diagnose` → `restart-ollama`), guided message returned, automatic correctly reported disabled for the target; after the guided restart the first successful required check left it `unavailable` + not routable (`consecutiveSuccesses: 1`), the second restored `healthy` + `Compression` routable, resolved the incident and emitted exactly one `local-ai-recovered` notification |
| Check 6 — Dashboard history survives raw retention | 2026-08-18 (Batch W) | Seeded `local_ai_routing_events` (3 rows >90d, 3 within window) in profile `rlm.db`; post-restart sqlite reads of `local_ai_daily_aggregates` (idempotent, task/token/fallback/cost/breakdown fields intact) + `localAiGuardGetSummary` 24h/7d/30d totals + rendered `/local-ai` effectiveness panel, all matching exactly |

## Check 2: Worker-local enrolment remains distinct from worker connectivity

1. Pair the disposable worker and confirm its node status is Connected.
2. Enrol its advertised Ollama endpoint for `compression` and complete validation.
3. Stop only Ollama on the worker; leave the worker agent running and connected.
4. Trigger **Recheck now** on the Local AI target.

Expected result: the worker node remains Connected, while the Local AI target immediately leaves
routing and shows the endpoint failure separately. An incident opens at the configured threshold
or immediately for an unambiguous critical classification.

Why deferred: it requires an external disposable worker and permission to stop its Ollama process.

Latest status (2026-09-21, queue worker): **PASSED.** Run against a disposable worker agent built
for this run rather than `windows-pc` — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-queue-worker-disposable-worker-checks-2-and-5).
The historical blocker was "no disposable worker exists"; a second worker agent from the same commit,
run on the coordinator Mac under an isolated `HOME` and pointed at an isolated coordinator port,
removes it without touching `windows-pc` or any of James's real services.

Superseded status (2026-08-25, Batch D): unrun across every evidence run since 2026-07-29.
`windows-pc` is the only worker that has ever been connected during this doc's evidence history,
and it is James's real, currently-paired worker, not a disposable one — stopping its Ollama/LM
Studio would disrupt real work. As of 2026-08-25 all three registered nodes (`windows-pc`,
`Noah3900x`, `noahlaptop`) show `status: disconnected`, so there is currently no worker to use even
setting the "not disposable" objection aside. Blocked on either a disposable worker becoming
available or James explicitly authorizing a live stop/restart on `windows-pc`; otherwise
agent-runnable via CDP/IPC exactly as check 1 was.

## Check 5: Recovery and restart reconstruction

1. While the target has an open incident, restart the rebuilt app without repairing Ollama.
2. Reopen Local AI Guard immediately.
3. Confirm the target and incident are restored but the target is Checking/Unavailable and not
   routable before a fresh current-generation check.
4. Restart Ollama through the named supported action (or the documented guided action when
   automatic repair is not enabled).
5. Observe two consecutive successful required checks.

Expected result: restart never restores routing from stale persisted health. The first successful
check leaves the target unavailable/recovering; the second restores Healthy/routable state and
resolves the incident with one recovery notification.

Why deferred: it requires restarting the rebuilt desktop app and controlling a real endpoint.

Latest status (2026-09-21, queue worker): **PASSED** against the same disposable worker, with a
real app restart while the incident was open — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-queue-worker-disposable-worker-checks-2-and-5).

Superseded status (2026-08-25, Batch D): unrun, same blocker as check 2 — needs the same disposable
worker (or James's authorization to disrupt `windows-pc`), plus a controlled app restart while an
incident is open. Otherwise fully agent-runnable (app restart + CDP/IPC observation, as demonstrated
for checks 1 and 6).

## Evidence run — 2026-09-21 (queue worker, disposable worker, checks 2 and 5)

Run by the Plan Queue worker on branch `queue/2026-07-26-local-ai-guard-plan-58373b`
(base commit `b8fcbe88`), from the worktree
`.worktrees/queue/2026-07-26-local-ai-guard-plan-58373b`. All times UTC.

### Environment

| Piece | Value |
| --- | --- |
| Coordinator | Dev app (`npx electron .`) built from the worktree: `npm run build:main`, `npm run build:renderer`; profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-b658373b`; CDP `9554`; renderer served from `dist/renderer/browser` on `:4567` |
| Coordinator host | macOS 27.0, Darwin 27.0.0, Node v24.15.0 |
| Worker server | `127.0.0.1:4979` — deliberately **not** the default `4878`, which the packaged Harness owns |
| Disposable worker | `dist/worker-agent/index.js` from the same commit (`npm run build:worker-agent`), `HOME=/tmp/aio-lt-queue-b658373b-workerhome`, config `…/.orchestrator/worker-node.json`, nodeId `ade80f75-c930-4cb1-b7bd-d4b8d1b0b972`, name `lt-disposable-worker`, paired with a one-shot pairing credential issued by the dev app |
| Disposable endpoint | `_scratch/lt-2026-09-21-lag/fake-ollama.mjs` on `127.0.0.1:11434` — serves exactly the surface `WorkerLocalAiHealth` probes (`/api/version`, `/api/tags`, `/api/ps`, `POST /api/generate` returning the `AIO_HEALTH_OK` exact-token canary). Ollama.app and LM Studio are installed on this Mac but neither server was running, and ports 11434 and 1234 were both free before the run, so the disposable endpoint displaced nothing |
| Target under test | `fefe5d92-0102-4115-b185-8e35da4227de` — worker-located, provider `ollama`, endpoint `worker:ade80f75-…:ollama:127.0.0.1:11434`, required model + canary `aio-livetest-canary:latest`, `routingRoles: ["compression"]`, `recovery.automatic: false` |
| Evidence artefacts | `_scratch/lt-2026-09-21-lag/` (see its `README.md`) — CDP harness, every evaluated expression, worker logs, the fake-endpoint request log, and `app-log-slice.ndjson` (the cited main-process lines, copied out before cleanup because a dev app writes into the production `app.log`). The IPC results and DOM readouts quoted below were read live over CDP and are not stored as files; what is stored is the exact expression that produced each one |

**How the historical blocker was removed.** Both checks had been deferred since 2026-07-29 for one
reason: `windows-pc` — James's real, non-disposable worker — is the only node that has ever been
connected during this doc's evidence history, and the checks require stopping its model endpoint. Nothing required the worker to be a *separate machine* —
only that it be disposable. A second worker agent, built from the same commit and run locally under
an isolated `HOME` against an isolated coordinator port, satisfies every step. The fidelity limit
worth stating plainly: coordinator and worker share one host, so this exercises the worker RPC path
and the worker/endpoint layer separation, but not a real network partition.

### Check 2 — PASSED

1. **Worker paired and Connected.** Pairing credential issued by the dev app; the worker registered
   at 05:17:42.104–.106 — `NodeIdentityStore` "Node identity stored" → `WorkerNodeConnection` "Node
   registered via WebSocket" → `WorkerNodeRegistry` "Node registered" → `WorkerNodeHealth` "Health
   monitoring started" → `RpcEventRouter` "Node registered via RPC".
   `remoteNodeList` → `status: "connected"`, advertising
   `localModelEndpoints: [{provider: "ollama", baseUrl: "http://127.0.0.1:11434", models:
   ["aio-livetest-canary:latest"], healthy: true}, {openai-compatible, healthy: false}]`.
   `localAiGuardDiscover` returned the endpoint as
   `location: {type: "worker", nodeId: "ade80f75-…"}`.
2. **Enrolled for `compression` and validated.** `localAiGuardValidate` returned all four layers
   `ok` through the worker RPC — `worker` (`workerConnected: true`, `rpcReachable: true`),
   `endpoint` (`endpointVersion: "0.12.0-aio-livetest"`, `httpStatus: 200`), `model`
   (`advertisedModels: ["aio-livetest-canary:latest"]`, `missingModels: []`), `inference`
   (`canaryOutputValid: true`). `localAiGuardCreateTarget` + a functional recheck at
   05:18:22.031 → `state: "healthy"`, `routableRoles: ["compression"]`.
3. **Stopped only Ollama on the worker** at 05:18:29Z — the endpoint logged
   `2026-09-21T05:18:29.856Z SIGTERM — stopping`, and `curl` then returned exit 7, connection
   refused. The worker agent process stayed up and connected throughout: `worker2.log` shows one
   continuous session from `Connected to coordinator` at 05:17:42 until the first
   `Coordinator socket closed { code: 1001, reason: 'Server shutting
   down' }` at ≈05:20:24.9 (the next timestamped worker line, its watcher cleanup, is 05:20:25.621)
   — which is the check-5 app stop, after this check had finished.
4. **Recheck now.** Three `localAiGuardRecheck` calls, each also reading `remoteNodeList`:

   | Attempt | Node status | Target state | `routableRoles` | `consecutiveFailures` | `incidentOpen` | `worker` layer | `endpoint` layer |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 1 | `connected` | `degraded` | `[]` | 2 | false | `ok: true` (`workerConnected: true`, `rpcReachable: true`) | `ok: false`, `connection-refused` |
   | 2 | `connected` | `unavailable` | `[]` | 3 | **true** | `ok: true` | `ok: false`, `connection-refused` |
   | 3 | `connected` | `unavailable` | `[]` | 3 | true | `ok: true` | `ok: false`, `connection-refused` |

   Note on "immediately": the scheduler's own 60 s lightweight check consumed failure #1 in the few
   seconds between the endpoint stop and the first manual recheck, so the earliest state captured is
   failure #2 — already `routableRoles: []`. (That inference comes from the counter reading 2 on the
   first manual check; a refused connection leaves no server-side request log, so the scheduled
   check's exact time is not independently timestamped in the artefacts.) That routing leaves on the *first* failing sample
   rather than at a count threshold is a code-level property, not something this run observed:
   `deriveRoutableRoles` (`local-ai-health-engine.ts`) filters every role named in a failing
   sample's `affectedRoles` out of the routable set regardless of `consecutiveFailures`, which is
   also why the target was already unroutable while still merely `degraded` at attempt 1.

   Incident `a6e223f7-326a-45a3-a721-089955416ec4` opened 05:18:39.690,
   `severity: warning`, `failureCode: connection-refused`, `affectedLayers: ["endpoint"]`,
   `affectedRoles: ["compression"]`.

**Result: matches the expected outcome.** The worker node stayed Connected while the target was out
of routing from the first captured post-failure check onward — before any incident existed, and
while the aggregate was still only `degraded` — and reported the failure against the `endpoint`
layer, separately from worker connectivity. The incident opened at the configured threshold (3 consecutive required
failures); a second reproduction the same session, after the target had already cycled
healthy → unavailable → healthy, opened one *immediately* as `flapping` — the "unambiguous critical
classification" branch of the same expectation.

**Rendered evidence** (second reproduction, 05:22:57Z onward, built renderer with CDP focus
emulation enabled). Status chip `Local AI: Unavailable | 1 target`; `/local-ai`:

```
Worker endpoint
ade80f75-…: worker:ade80f75-…:ollama:127.0.0.1:11434
Currently advertised · Evidence 10s ago · 3 consecutive failures
Unavailable
Worker      1 ms                 10s ago
Endpoint    Connection Refused   10s ago
Model       1 ms                 1m ago
Canary      1 ms                 1m ago
Routing roles    None currently eligible
Active incidents 1 — warning incident — Flapping — endpoint
```

At the same moment `/remote-nodes` read `Worker Nodes — 1 connected` and, on the node card,
`lt-disposable-worker … 127.0.0.1 … Connected`. That is the separation this check exists to prove,
visible in the UI: node Connected, endpoint Connection Refused, routing empty.

### Check 5 — PASSED

1. **Restarted the app with the incident open and Ollama still down.** Pre-restart state at
   05:20:02: `state: unavailable`, `routableRoles: []`, `incidentOpen: true`,
   `recoveryState: unavailable`, `consecutiveFailures: 3`. The app was killed at ≈05:20:24.9 — the
   moment the worker logged `Coordinator socket closed { code: 1001, reason: 'Server shutting
   down' }`, which is the authoritative timestamp; the shell confirmed the process gone at
   05:20:32Z. The restarted app
   had its worker server listening again at 05:20:41.589 and the worker fully re-registered at
   05:20:48.632 (`RpcEventRouter` "Node registered via RPC"). The endpoint stayed refused
   (`curl` exit 7) across the whole restart — nothing repaired it.
2–3. **Reopened immediately** — first guard snapshot after the restart, 05:21:02.250. The target and
   the *same* incident id
   (`a6e223f7-…`, still `open`, `openedAt` unchanged at 05:18:39.690) were restored, and the target
   came back `state: "checking"`, `routableRoles: []`, `recoveryState: "unavailable"`,
   `incidentOpen: true`. Routing was **not** restored from persisted health — no role was routable.
   The `checking` (rather than `unavailable`) reading is the engine's stale-evidence branch: the
   restarted scheduler re-checks a worker target as soon as its node reconnects, and with the
   endpoint still refused, the merged `model`/`inference` samples rebuilt from persistence were
   already older than the 120 s `freshnessLimitMs`, so no usable evidence cycle existed. Either way
   the check's requirement holds — `routableRoles` was empty both before and after that first
   post-restart check.
4. **Named action.** `localAiGuardDiagnose` → `recommendedActions: ["deep-check",
   "restart-ollama"]`. `localAiGuardRepair {action: "restart-ollama", mode: "guided"}` →
   `outcome: "guided"`, `supported: true`, message *"Open Remote Nodes, select the target worker, and
   restart Ollama on that host."* The automatic mode was also exercised and correctly declined:
   `outcome: "not-attempted"`, *"Automatic Local AI repair is disabled for this target."*
   (the target carries `recovery.automatic: false`, which is the documented guided-action case).
   Automatic repair was left disabled deliberately: a real `Ollama.app` is installed on this host,
   so an automatic `restart-ollama` would have launched James's actual Ollama on 11434 instead of
   the disposable endpoint. The guided action was performed literally instead — Ollama restarted on
   the worker host at 05:21:41Z.
5. **Two consecutive successful required checks.**

   | Check | Time | State | `routableRoles` | `consecutiveSuccesses` | `incidentOpen` |
   | --- | --- | --- | --- | --- | --- |
   | lightweight — not a usable cycle: the merged `inference` sample was still the 05:18:22 one, past the target's 120 s `freshnessLimitMs`, so `staleRequiredEvidence` held the engine in `checking` (`local-ai-health-engine.ts`, `evidenceIsUsable`) | 05:21:52.048 | `checking` | `[]` | 0 | true |
   | functional — **first successful required cycle** | 05:21:52.052 | `unavailable` | `[]` | 1 | true |
   | lightweight — **second successful required cycle** | 05:22:07.760 | `healthy` | `["compression"]` | 2 | **false** |

   Incident `a6e223f7-…` → `state: "resolved"`, `resolvedAt` 05:22:07.760. Exactly **one**
   recovery notification was emitted (`notificationList`, filtered to `local-ai*`, was empty
   beforehand):

   ```
   kind : local-ai-recovered
   title: Local AI endpoint recovered
   body : Endpoint: Worker Ollama endpoint #d5ce0ee0081c. Failed layer: endpoint.
          Affected slots: compression. Fallback impact: 0 paid dispatches; $0.00 known;
          $0.00 estimated. Duration: 3m.
   ```

**Result: matches the expected outcome.** Restart restored the target and incident without
restoring routing; the first successful check left the target unavailable and unroutable; the second
restored Healthy + routable, resolved the incident and produced one recovery notification. The
sequence was reproduced a second time later in the session (after the flapping incident): functional
→ `unavailable`/`successes: 1`, lightweight → `healthy`/`["compression"]`/incident resolved.

Rendered confirmation afterwards on `/local-ai`: `Current aggregate — Healthy`, `Enrolled 1`,
`Healthy 1`, per-layer ages for Worker/Endpoint/Model/Canary, `Routing roles: Compression`,
`Active incidents 0`.

### Defect found while preparing the worker — LT-604

Not a Local AI Guard defect, but it is what makes worker enrolment impossible without an app
restart, so it belongs with this evidence. Filed as
[LT-604](../../plans/livetest-remediation-register.md#lt-604-a-worker-server-started-after-launch-has-no-rpc-router-so-every-worker-stays-disconnected)
with a status section in `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`.

The first pairing attempt was made by enabling remote nodes in a running app
(`setSetting('remoteNodesEnabled', true)` + `remoteNodeStartServer`). The worker authenticated and
the server reported `connectedCount: 1`, but the roster showed it `disconnected` with fallback
capabilities and the guard discovered no worker endpoints. That first observation is confounded —
the same attempt also used a non-UUID `nodeId` — so it proves nothing on its own. The A/B below
removes the confound: one worker binary, one valid UUID config, one port, only the launch-time
setting differs.

| Launch state of `remoteNodesEnabled` | Coordinator log | Roster | Guard discovery |
| --- | --- | --- | --- |
| **true** at launch (05:20:48.629) | `WorkerNodeConnection "Node registered via WebSocket"` → `RpcEventRouter "Node WebSocket connected — awaiting registration"` → `RpcEventRouter "Node registered via RPC"` | `connected`, advertised `localModelEndpoints` | 2 worker endpoints |
| **false** at launch, server started from the renderer (05:24:54.710) | `WorkerNodeConnection "Node registered via WebSocket"` only — no `RpcEventRouter` lines at all, and none for the whole ~5 min the socket stayed up (next line for the node is `Node identity removed` at 05:29:52.206, the cleanup revoke) | `disconnected`, fallback capabilities, no local models | 0 worker endpoints; enrolled worker target stuck in `checking` |

`RpcEventRouter` is constructed only in `createWorkerNodeSubsystemStep`
(`src/main/app/remote-gateway-initialization-steps.ts:33-41`), which returns early when the setting
was false at launch; neither `REMOTE_NODE_START_SERVER` nor the pair-both
`ensureRemoteNodeServerRunning()` — which itself flips the setting mid-session
(`src/main/ipc/handlers/pair-both-handlers.ts:277`) — installs it. The evidence above was gathered
with the app launched *after* the setting was persisted true, which is the documented workaround.

One non-defect worth recording so the next run does not lose time to it: `node.register` requires a
UUID `nodeId` (`RPC_PARAM_SCHEMAS`), and a worker config with a human-readable id is rejected by the
router with `RPC validation failed … "Invalid UUID"` *after* the socket layer has already accepted
it. The pairing CLI generates a UUID; a hand-written config must too. A small consistency gap falls
out of the same asymmetry: the socket path persists whatever id it authenticated, so a non-UUID
identity lands in the store and `remoteNodeRevokeNode` — whose payload schema demands a UUID — can
never remove it. Only reachable by hand-writing a config, and it stayed inside the disposable
profile that was deleted at the end of this run, so it is recorded here rather than filed.

### Cleanup performed

Disposable target retired (`lifecycle: retired`, 0 remaining target configs), the UUID node identity
revoked, worker server stopped, worker agent and disposable endpoint stopped, dev app and the
`:4567` renderer server stopped, `/tmp/aio-lt-queue-b658373b*` profiles removed. The one leftover —
the first, non-UUID node identity — could not be revoked through the API (see the note above) and
was destroyed with the profile. `windows-pc`, the packaged Harness on port 4878,
`~/.orchestrator/worker-node.json` and `~/.orchestrator/logs/` were never touched. What was actually
checked after cleanup: the packaged Harness is still running as the same pid and still holds port
4878; `~/.orchestrator/worker-node.json` still shows its pre-run size and mtime (1012 bytes,
2026-09-20 18:06) and `~/.orchestrator/logs/worker-agent.log` its pre-run mtime (2026-09-20 18:52) —
size and mtime, not a byte comparison.

## Recommended for deletion

None — no check in this doc is obsolete. Checks 2 and 5 were the last outstanding ones and were run
on 2026-09-21; both passed.

## Completion

Record the app build/commit, coordinator and worker platform/version, endpoint/model identifiers,
timestamps, and exact observed results for each check. Remove all disposable targets and stop the
test endpoints. Rename this file to
`2026-07-26-local-ai-guard_plan_livetest_completed.md` only after all six checks pass with current
evidence.

> Plan Queue parked work: `queue/2026-07-26-local-ai-guard-plan-58373b` — 1 commit(s), reason: land-blocked.
