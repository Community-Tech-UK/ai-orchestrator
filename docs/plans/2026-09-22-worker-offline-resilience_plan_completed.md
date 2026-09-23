# Worker Offline Resilience — Plan

Status: implemented and verified in-loop; live checks deferred to [2026-09-22-worker-offline-resilience_livetest.md](2026-09-22-worker-offline-resilience_livetest.md)

## Why

Investigated 2026-09-22 after "the windows-pc worker goes offline when it updates". Evidence:

- The 09:27Z–13:03Z outage was the coordinator Mac's Tailscale being switched off
  (`WantRunning: false`). The worker process was alive and retrying the whole time; it
  re-registered seconds after `tailscale up`.
- The worker's only non-Tailscale route was a stale LAN address (`ws://192.168.0.95:4878`); the
  Mac's LAN IP changed around 2026-09-17, so the worker depended on Tailscale alone.
- Windows Update restarted the PC on 09-15 and 09-18; the worker only returns at logon.
- The 5-minute scheduled task `git pull`s but, when a worker is alive, exits before building or
  restarting. In the task-owned steady state (`IgnoreNew`) it never even runs. The live worker was
  still on the 2026-09-19 bundle.

## Items

1. **Coordinator advertises its current addresses.** After each registration the coordinator sends
   `node.coordinatorAddresses` (scope `service`) with its current reachable URLs (Tailscale
   MagicDNS, Tailscale IP, ranked LAN IPs). The worker validates, stores them as
   `advertisedCoordinatorUrls` (replacing the previous set, persisted), and tries them after its
   configured URLs. The MagicDNS lookup is async and never blocks registration. Old workers ignore
   the unknown notification.
2. **Warn when this Mac's Tailscale is off while workers depend on it.** A coordinator-side watcher
   polls the local Tailscale state (interface first, CLI `BackendState` only when the interface is
   missing). On a transition to stopped while paired nodes exist it raises one critical
   notification naming the nodes last seen over Tailscale. Disconnected roster entries carry a
   `connectivityHint` shown on the node card.
3. **Launcher restarts the worker onto new code.** `start-worker.bat`, when a worker is already
   running: if `HEAD` differs from the commit recorded at the last build, rebuild; then if the bundle
   is newer than the running worker child, stop the child only (the supervisor respawns it from the
   new bundle). Unsupervised workers are never killed. A lock prevents concurrent launches.
   `install-worker-launcher.ps1` registers a second "AI Orchestrator Worker Update" task so updates
   run even while the main task owns the worker.
4. **Windows Update restarts.** Provide `scripts/windows/configure-update-restart-signon.ps1`
   (elevated) that enables "Use my sign-in info to automatically finish setting up after an update"
   (ARSO) for the worker user, so the logon trigger fires after an update restart. Reads current
   state first; changes nothing without `-Apply`.

## Verification

- Unit tests for the address builder, worker candidate merge/persist, dispatcher notification,
  router advertisement, Tailscale watcher transitions, roster hint.
- Canonical gates (tsc x2, lint, max-loc, build:main, build:renderer, test:quiet).
- Batch/PowerShell changes: parse/dry-run checks on windows-pc where possible.
- Live checks (need rebuilt coordinator + redeployed worker) go to a `_livetest.md` doc.

## As-built notes

- Item 1: `coordinator-advertised-urls.ts` (shared builder, also used by the repair service),
  `coordinator-address-advertiser.ts` (wired on registry `node:connected` in
  `remote-gateway-initialization-steps.ts`), `node.coordinatorAddresses` in `worker-node-rpc.ts` /
  `rpc-schemas.ts`, worker side in `worker-coordinator-addresses.ts` with a two-line hook in
  `worker-agent.ts` (the dispatcher is at the 700-line cap). MagicDNS is read with the new async
  `readTailscaleSelfStatus()` and only advertised while Tailscale reports `Running`. `wss://`
  workers drop advertised `ws://` routes.
- Item 2: `coordinator-tailscale-watcher.ts` polls every 30 s (interface first, CLI only when the
  interface is missing), notifies `coordinator-tailscale-down` (critical, one per transition),
  exposes `getDisconnectedNodeHint()` to the roster (`connectivityHint`), and emits a
  `coordinator-route` renderer event so the Remote Nodes page and Settings → Computers refetch.
- Item 3: `start-worker.bat` gained a `launcher.lock` directory lock, a `.source-commit` stamp after
  every build, and hands a live worker to `update-running-worker.ps1` (rebuild when HEAD moved;
  after a rebuild, or when the bundle is newer than the child, stop the child so the supervisor
  respawns it; never stop an unsupervised worker; defer while busy, with the descendant walk
  stopping at Chrome/conhost/adb). `install-worker-launcher.ps1 -RegisterUpdateTask` adds the
  `AI Orchestrator Worker Update` task; `restart-worker.bat` stops it too.
- Item 4: `configure-update-restart-signon.ps1` (report by default; `-Apply` elevated sets the
  worker account's ARSO `OptOut=0`, optional active hours; respects the disabling policy).
  windows-pc baseline: ARSO not set, active hours 15:00 -> 09:00.
- Verification: tsc (both configs), lint, build:main, build:renderer, full test:quiet
  (2185 files / 25922 tests) pass. `check:ts-max-loc` fails only on `input-panel.component.ts`
  (1910 lines at committed HEAD, not this work); `verify:architecture` drift is another session's
  `INPUT_REQUIRED_RESOLVED` channel. Launcher paths verified on windows-pc with an isolated harness,
  25/25; all PowerShell parses cleanly there. Fresh-eyes review: PASS.
- Found in passing, not fixed here: the coordinator sends `node.streamAck` without
  `scope: 'service'`, and the worker drops unscoped notifications, so durable-stream acks are
  probably never applied (every reconnect replays the full buffer, e.g. 185 events on 2026-09-22).
