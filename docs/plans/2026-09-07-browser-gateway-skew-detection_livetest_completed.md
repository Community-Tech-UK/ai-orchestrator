# Browser Gateway skew detection — Live Test

## Status — 2026-09-08
Open: 4 · Closed: 0 · Failed: 0

Nothing in this document has been run against a rebuilt app. Every code-level gate for
the implementation is green (`tsc`, spec `tsc`, `lint`, `check:ts-max-loc`, `build:main`,
`build:renderer`, and the targeted suites). The full quiet suite reported 3 failures in
unrelated dirty-tree files (`loop-review-reuse-anchor`, auxiliary settings migrations),
not in this change.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is
> not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-07-browser-gateway-skew-detection_plan_completed.md](./2026-09-07-browser-gateway-skew-detection_plan_completed.md)

**Prerequisites:** coordinator app **rebuilt and restarted** (`npm run build`). `windows-pc`
connected with its current (pre-fix) worker still running for LT-A/LT-B, then the worker
agent redeployed for LT-C. At least one Chrome tab shared on the local Mac extension for
LT-D.

**Why these cannot run in-loop:** health, `list_targets`, and attach-tab all observe the
live packaged/dev coordinator plus a real worker socket and a real Chrome extension. The
currently running app predates this change. Redeploying `windows-pc` is operational and
was out of scope for the implementation plan.

---

## LT-A — health names the too-old worker before any command is sent

**Why deferred:** `browser.health` is served by the running main process. The current
instance does not carry `commandsDeliverable` or the skew warning.

1. Rebuild and restart the coordinator. Leave the existing `windows-pc` worker in place
   (do **not** redeploy yet).
2. Call `browser.health`.

**Expected:** top-level `status` is `partial` (not `ready`). `remoteExtensions.ready` does
not count `windows-pc`. The `windows-pc` node record has `commandsDeliverable: false` and
a reason containing `browser_worker_agent_too_old`. A warning names `windows-pc` and says
to redeploy the worker agent.

---

## LT-B — list_targets / attach blame the worker, not the extension runtime

**Why deferred:** the running coordinator still throws
`browser_extension_runtime_incompatible` for every `windows-pc` attach.

1. Same rebuilt app and unrepaired worker as LT-A.
2. Call `browser.list_targets` with `computer: "windows-pc"` (no refresh required).
3. Optionally trigger any attach/poll from the shared tab on that node.

**Expected:** the listing `reason` contains `browser_worker_agent_too_old` and
"redeploy the worker agent to windows-pc". It does **not** say
`browser_extension_runtime_incompatible`. Logs show the blocked-commands warning once
per transition, not once per request.

---

## LT-C — redeployed worker clears the error and health can go ready

**Why deferred:** redeploying the worker agent to `windows-pc` is operational and needs
the rebuilt coordinator plus a live extension session on that machine.

1. Redeploy the current worker agent to `windows-pc` and wait for a fresh heartbeat.
2. Confirm `list_remote_nodes` shows `extensionRelay.forwardsRuntimeEvidence: true`.
3. Call `browser.health` and `browser.list_targets { computer: "windows-pc" }`.
4. Drive one harmless read (`browser.snapshot` or `browser.query_elements`) against a
   shared tab on that node.

**Expected:** health no longer lists `windows-pc` as undeliverable. `list_targets` has
no `browser_worker_agent_too_old` reason. The read command is delivered (or fails for
an unrelated, named reason — not runtime-incompatible / worker-too-old).

---

## LT-D — `computer: "local"` stays on the coordinator

**Why deferred:** the live misroute was observed against the packaged app. The unit
tests cover the policy, but the rebuilt RPC path plus a connected `windows-pc` is the
proof that auto-offload no longer rewrites an explicit local request.

1. Rebuilt app, `windows-pc` connected, auto-offload still enabled.
2. Share at least one local Chrome tab through the coordinator extension.
3. Call `browser.list_targets { computer: "local" }` (no refresh).
4. Call `browser.list_targets { computer: "local", refresh: true }`.

**Expected:** every returned target has no `nodeId` / is not `windows-pc`. A local
refresh does not mention `inventory refresh FAILED for node <windows-pc id>`.
`browser.list_targets { computer: "definitely-not-a-real-computer" }` still fails with
`browser_computer_not_found`.

## Status — 2026-09-24

Open: 2 · Closed: 2 · Failed: 0
LT-C and LT-D passed on 2026-09-24 against the packaged app (built 2026-09-23 21:12) and the live
`windows-pc` worker. LT-A and LT-B are still open. Both need a worker older than the skew fix, and
`windows-pc` now runs a current one (`forwardsRuntimeEvidence: true`), so the "too old" state cannot
be observed there any more. A disposable worker built from a pre-fix commit and paired to an isolated
dev app over loopback (the WS15 livetest method) can stage it without touching `windows-pc`. That is
agent work, not James's.

## Evidence run — 2026-09-24 (orchestrating session)

- **LT-C — PASS.** `list_remote_nodes`: `windows-pc` `extensionRelay.forwardsRuntimeEvidence: true`,
  `registration: "ok"`, extension 0.2.34. `browser.health` (audit `8b9dff4c…`): top-level `status:
  "ready"`, `remoteExtensions {total: 1, ready: 1}`, the `windows-pc` node has `channelState: "fresh"`
  and `commandsDeliverable: true`, and `warnings: []`. `browser.list_targets {computer: "windows-pc"}`
  had no `browser_worker_agent_too_old` reason. Harmless reads were delivered: `browser.snapshot`
  (audits `46e4d857…`, `73538dab…`) and `browser.query_elements` (audit `1e41c2cd…`) all succeeded.
- **LT-D — PASS.**
  - `list_targets {computer: "local"}` (audit `0b804dff…`) returned the two local shared tabs with no
    `nodeId`.
  - `list_targets {computer: "local", refresh: true}` (audit `86e4f33d…`) also returned only those two
    rows, with the reason `inventory refresh FAILED for the local extension
    (browser_extension_command_timeout)`. It names the local channel and never mentions `windows-pc`.
  - `list_targets {computer: "definitely-not-a-real-computer"}` (audit `a5553a6a…`) was `denied`
    with `browser_computer_not_found … Available computers: local, windows-pc`.
- **Observed along the way, and recorded against LT-544:** the local Mac channel's refresh timed out
  while `health` called that channel `ready`. See the LT-544 note in
  [the reliability livetest](2026-07-17-browser-gateway-reliability_livetest.md#evidence-run--2026-09-24-orchestrating-session).

## Final status — 2026-09-27

Open: 0 · Closed: 4 · Failed: 0

LT-A and LT-B passed against a rebuilt coordinator and a disposable worker compiled from
`e29b41ba^`, the commit immediately before the worker began forwarding the capability marker. The
coordinator, worker profile, pairing credentials, relay socket and native-host registration were
all isolated under `/tmp/aio-lt-skew-20260927.fU75dD`; `windows-pc` was not downgraded or changed.

## Evidence run — 2026-09-27 (isolated legacy-worker fixture)

- **Precondition proved.** The connected node `LT legacy skew isolated`
  (`168d674c-0a1a-4300-9419-229dd37fbfc4`) reported an enabled and running extension relay plus
  fixture extension version `0.2.17-legacy-fixture`, while its relay summary had no
  `forwardsRuntimeEvidence` property. The current coordinator therefore received the real
  pre-fix capability shape rather than a mocked classifier input.
- **LT-A — PASS.** `browser.health` audit `bc22ea70-526a-4f12-86f3-dbee6390cfb4` returned top-level
  `status: "partial"`, `remoteExtensions { total: 1, ready: 0 }`, and the fixture node had
  `commandsDeliverable: false`. Both its reason and the top-level warning were
  `browser_worker_agent_too_old` and named `LT legacy skew isolated` plus the worker-redeploy
  remediation.
- **LT-B — PASS.** Two consecutive no-refresh `browser.list_targets` calls returned an empty target
  list with the same worker-specific reason (audits `3a2da5be-326b-4ab6-9579-1e99ddf67335` and
  `31085d33-e128-49b9-9d13-2e9e6d97d99c`). Neither response contained
  `browser_extension_runtime_incompatible`. The focused `remote-extension-bridge.spec.ts` suite
  passed 21/21 and includes the transition-dedupe assertion: two blocked attachment requests emit
  exactly one `Remote browser extension commands blocked` warning while the reason is unchanged.
- **Isolation correction.** An initial disposable run allowed the old worker to repair the real
  relay-host manifest, so the current local extension contacted that relay. The worker was stopped,
  the manifest was verified to point only into the disposable tree and removed, and the clean rerun
  used a process-local mocked home plus a new node ID, socket and relay token. The installed local
  channel remained healthy and polling throughout; none of that contaminated first run is used as
  pass evidence above.
