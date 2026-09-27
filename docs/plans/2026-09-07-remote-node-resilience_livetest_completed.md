# Remote Node Resilience — Live Test

## Status — 2026-09-07
Open: 5 · Closed: 0 · Failed: 0

Nothing in this document has been run against a rebuilt app. Every code-level gate is green
(`tsc`, spec `tsc`, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`), the full
suite passed clean at 22,336 tests / 2,023 files before the `urgency: 'critical'` amendment,
and all three fixes are unit-covered including revert-and-watch-it-fail mutation checks — but
the whole point of this change is a behaviour that only exists at runtime, across two
machines. A green mDNS unit test proves the call is made; it does not prove a Windows worker
can hear it.

**Caveat on the final full-suite runs.** Later runs failed, every time in *different* files
(`browser-gateway/*`, then `orchestration/loop-review-reuse-anchor` +
`core/config/settings-migrations.auxiliary`, then `context-worker-import-isolation`). Each
was traced to concurrent work by another session in this live tree, not to this change:

- The first two rounds were torn reads — the failing files had mtimes *inside* the run
  window, imported nothing changed here, and passed on immediate isolated re-run.
- The last one was real and reproducible: `context-worker-import-isolation` asserts the
  worker's value-import closure stays under 144 modules. It reached exactly 144. Diagnosed by
  walking the closure against a pristine `git archive HEAD` copy and diffing: HEAD 143,
  working tree 144, with the single addition being
  `src/main/rlm/auxiliary-routing-diagnostics.ts` — an **untracked file created at 00:15** by
  another session. Whoever added it owns raising that ceiling with the diff-verified
  justification the spec's comments require.

Three files changed here (`settings.types.ts`, `settings-defaults.ts`,
`settings-metadata-integrations.ts`) *are* inside that worker closure, so this was checked
rather than assumed: the additions are a boolean field, a default literal and a metadata
object — no imports, so zero new modules and no Electron coupling. The closure diff confirms
exactly one addition and it is not from this work.

Re-confirm on a quiet tree if that matters to you.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is
> not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-07-remote-node-resilience_plan_completed.md](2026-09-07-remote-node-resilience_plan_completed.md)

**Prerequisites:** the coordinator app **rebuilt and restarted** (`npm run build`) — the
running instance predates this change and will not advertise. windows-pc connected and its
worker running. Both machines on the same LAN.

**Why these cannot run in-loop:** the coordinator advertises during
`createWorkerNodeSubsystemStep`, which runs once at app start, so the currently-running app
can never exercise it. The failover and notification checks additionally need a second
machine and a deliberately broken network path.

---

## LT-A — coordinator advertises over mDNS on a normal start

**Why deferred:** `publish()` runs inside the app-start initialization step. The running
coordinator was started before this fix existed.

**Steps**
1. `npm run build`, then restart the Harness app normally (do *not* toggle the remote-node
   server in Settings — that would exercise the old IPC path and invalidate the test).
2. `grep -a "mDNS service published" ~/Library/Application\ Support/Harness/logs/app.log | tail -3`
3. From the Mac: `dns-sd -B _ai-orchestrator._tcp` (leave running a few seconds).

**Expected:** step 2 shows a `mDNS service published` entry with `port: 4878` timestamped at
the restart. Step 3 lists a service named `orchestrator-<first 8 of namespace>`.

**Fails if:** no log line (the call did not run), or a `Failed to publish mDNS service`
warning (Bonjour could not bind — check for another copy of the app running).

---

## LT-B — no duplicate advertisement after a Settings toggle

**Why deferred:** needs the real Bonjour stack; the unit test mocks `bonjour-service`.

**Steps**
1. With the app running post-LT-A, go to Settings → Remote Nodes, toggle the server off, then
   on again.
2. `dns-sd -B _ai-orchestrator._tcp`
3. `grep -a "mDNS service unpublished\|mDNS service published" ...app.log | tail -6`

**Expected:** exactly **one** service listed, not two. The log shows publish → unpublished →
publish ordering.

**Fails if:** two services are advertised, or a stale one persists pointing at the old port.
That is the leak `publish()`'s idempotency is meant to prevent.

---

## LT-C — worker fails over to the LAN when the tailnet path dies

**Why deferred:** needs a second machine and a deliberately severed network path.

**Prerequisite:** LT-A passing — without an advertisement there is nothing to discover, which
is exactly the 2026-09-07 failure.

**Steps**
1. Confirm windows-pc connected (`list_remote_nodes`).
2. **Arrange recovery first.** On windows-pc, schedule an unconditional `tailscale up` ~5
   minutes out, so a failed test cannot strand the node. Do not skip this — if failover does
   not work, the tailnet is your only route back.
3. On windows-pc: `tailscale down`.
4. Watch the coordinator log for `Worker WebSocket closed`, then for `Node registered` with an
   `address` on `192.168.0.x` rather than `100.x`.

**Expected:** the worker reconnects over the LAN within ~1 minute, and the registered address
is the LAN one.

**Fails if:** it stays disconnected until step 2's restore fires. Note windows-pc's config now
also carries an explicit `coordinatorUrls` LAN entry, so a pass here does **not** by itself
prove mDNS worked — check the log for which candidate won, and consider temporarily removing
the static entry to isolate the mDNS path.

---

## LT-D — operator is notified when a node disconnects

**Why deferred:** needs a real Electron `Notification` and a real node drop.

**Steps**
1. Confirm `notifyOnNodeDisconnect` is on (default true) in Settings → General.
2. Cause a real disconnect — on windows-pc, stop the worker (`Stop-ScheduledTask` plus killing
   the supervisor and child, per the plan) — and wait ~90s for the health monitor to
   deregister it.
3. Observe the desktop.

**Expected:** a desktop notification "Worker node disconnected" naming the node.

**Also check:** trigger a second disconnect of the same node within the dedupe window and
confirm only one notification appears; then confirm a *different* node still notifies.

**Also check quiet hours explicitly.** The alert is raised at `urgency: 'critical'`, which
`NotificationService` treats as a deliberate bypass of both quiet hours and the per-kind
cooldown (`notification-service.ts:167,173`). Set quiet hours to a window covering *now*
(Settings → General), then trigger a disconnect. The notification must **still** appear.
That is the whole point of the critical urgency and is worth confirming against a real
Electron notification, since a silent regression to `normal` would be invisible until the
next overnight outage.

**Fails if:** no notification at all, or none while quiet hours are active.

---

## LT-E — simultaneous multi-node disconnect is tolerable, not a siren

**Why deferred:** needs two real worker nodes and a real shared-cause outage.

**Why this check exists:** the alert is `critical`, which bypasses the per-*kind* cooldown,
while dedupe is per `{kind, nodeId}`. Two nodes dropping together therefore produce two
separate alerts, both with forced sound and no digest. That is a deliberate accepted tradeoff
(see the plan) — this check confirms the reality is tolerable rather than assumed to be.

**Steps**
1. Connect two worker nodes (e.g. windows-pc and one other).
2. Cause a shared-cause outage that hits both at once — stop Tailscale on the coordinator, or
   pull the coordinator's network. Note each node runs an independent 30s grace timer
   (`DISCONNECT_GRACE_MS`), so the deregistrations land close together but not identically.
3. Observe the desktop.

**Expected:** one notification per node, close together, each naming its node.

**Judgement call, record the answer:** is that acceptable, or does a multi-node drop want a
single rolled-up alert? With three registered nodes this is at most a small burst. If the
fleet ever grows, this is the check that should force a digest path for critical
notifications.

## Status — 2026-09-24

Open: 5 · Closed: 0 · Failed: 1
LT-A was run against the packaged app, which started after this change, and **failed**. It is filed
as [LT-619](livetest-remediation-register.md). The app logs the publish, but macOS refuses its
multicast (`EHOSTUNREACH`), so the advertisement is invisible. The code half of LT-619 (each refused
answer became an uncaught exception) is fixed in the working tree. The other half is a Local Network
permission that only James can grant in System Settings. LT-B, LT-C and LT-D were not run: LT-B needs
the Settings UI of the packaged app (a hard-denied Computer Use target) or a dev app with the remote
server on; LT-C needs LT-A passing first; LT-D needs a real worker stop on `windows-pc`.

## Evidence run — 2026-09-24 (orchestrating session)

- **LT-A — FAIL.**
  - `app.log`: `mDNS service published {port: 4878, namespace: "default"}` at `1790197750247`, the
    packaged app's start, with no later unpublish.
  - `dns-sd -B _ai-orchestrator._tcp` (run through a pty, 5–8 s) found no instances. The control
    browse `dns-sd -B _companion-link._tcp` listed `MacBook Pro` on four interfaces at once.
- A `bonjour-service` `find({type: 'ai-orchestrator'})` also returned `[]`.
- Each query was answered by `Uncaught exception … send EHOSTUNREACH 224.0.0.251:5353` in `app.log`
  (12 hits, `1790212286194`–`1790212323231`), and Harness pid 60005 was the only Harness process
  on UDP 5353. Full analysis in LT-619.

## Final source status — 2026-09-27

Open here: 0 · Passed here: 0 · Transferred: 5 · Failed defect already registered: 1

All still-live acceptance work has moved to
[RES-027](2026-09-27-livetest-human-external-residuals_livetest.md#res-027--remote-node-lan-discovery-failover-and-notification-campaign),
so this dated source document is closed. LT-619 remains the owning defect for the multicast
permission boundary; no duplicate defect was opened.

## Evidence run — 2026-09-27 (isolated rebuilt coordinator)

- A real dev coordinator started its remote-node server on loopback port 4971. The live
  `DiscoveryService` buffer recorded `mDNS service published` for port 4971.
- The Settings-equivalent IPC toggle was then exercised directly: stop followed by start. The live
  log sequence was `mDNS service published` → `mDNS service unpublished` →
  `mDNS service published`, with no duplicate-publisher exception or stale server listener.
- A five-second real `dns-sd -B _ai-orchestrator._tcp local` browse returned no instance. The same
  run logged `mDNS answer could not be sent; other machines cannot discover the coordinator` with
  `EHOSTUNREACH 224.0.0.251:5353` and the exact Local Network permission hint. This re-confirms
  LT-619's remaining packaged-app permission prerequisite; it does not fail the stop/start logic.
- LT-C through LT-E were not disrupted into existence. They require the permission result, a
  scheduled recovery before cutting Tailscale, a real `windows-pc` stop, real Electron
  notifications, a second node and James's alert-burst judgment. Those constraints and rollback
  steps are preserved in RES-027.
