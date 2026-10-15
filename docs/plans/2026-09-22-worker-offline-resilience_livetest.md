# Worker Offline Resilience — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-22-worker-offline-resilience_plan_completed.md](2026-09-22-worker-offline-resilience_plan_completed.md)

**Prerequisites:**

- The updated checkout must reach windows-pc through an approved deployment step.
  The worker launcher no longer pulls code automatically.
- Rebuild and restart Harness on the Mac from this checkout (`npm run build:main`, then restart)
  so the coordinator runs the address advertiser and the Tailscale watcher. The restart replaces
  the process hosting the implementing session, which is why these could not run in-loop.
- windows-pc (node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`), worker user `9950X3D\shutu`, checkout
  `C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator`.
- Coordinator log: `~/Library/Application Support/Harness/logs/app.log`. Worker log:
  `C:\Users\shutu\.orchestrator\logs\worker-agent.log`.
- Tailscale CLI on the Mac: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (run outside the
  agent sandbox).

## 2026-09-23 investigation handoff

- The screenshot reported five paid compression fallbacks. At 21:15 UTC the coordinator logged
  that both worker-local model endpoints were unhealthy (`ollama` health-checking/unavailable;
  OpenAI-compatible endpoint heartbeat unhealthy). The worker had several short disconnects.
  This explains why AIO bypassed local models; the logs do not prove that an update caused the
  disconnects. At 22:22 UTC `windows-pc` was connected and Ollama generation calls completed.
- Local source change, still uncommitted: the deployed launcher template no longer pulls Git;
  `start-worker.bat` leaves a live worker alone; the installer disables the legacy update task
  and refuses to rewrite an armed/running launcher; `update-running-worker.ps1` is an explicit
  maintenance command with busy checks, manual retry status, and replacement confirmation.
  `restart-worker.bat` and `docs/WORKER_AGENT_SETUP.md` were aligned with that behavior.
- Independent completion review returned `VERDICT: PASS` on the final worker diff. TypeScript
  checks, lint, size gate, and main/renderer builds passed. The first full quiet suite passed
  26,372 tests before the final shell changes. Later full suites each hit one unrelated,
  concurrently edited test; each failing file passed alone. The last suite was stopped when a
  separate full Vitest run was found active in the shared checkout. Do not describe the final
  full suite as green. Relevant failure log: `_scratch/test-run.pid-69764.log`.
- Live Windows task state and deployed launcher remain **unverified and unchanged by this local
  work**. `list_remote_nodes` returned `EVIDENCE_CAPTURE_REQUIRED`; one SSH attempt to the
  worker's Tailscale address timed out. Browser Gateway connectivity does not grant Task
  Scheduler access. On 2026-09-24 James chose to keep the reviewed change local; do not commit,
  push, or deploy it under the current instruction.
- If James later authorizes rollout: deliver the reviewed checkout to Windows, perform Check 1
  in a maintenance window, then record the actual task state, launcher contents, worker
  reconnection, and local-model generation here. Until that check passes, do not claim that
  automatic updates have stopped on the live worker.

## Check 1 — Retire automatic worker updates and deploy the stable launcher

> **Superseded 2026-10-14.** James chose automatic updates done as one unit
> (worker rebuilds and restarts itself when idle, the extension follows). The
> "retire automatic updates" half of this check no longer applies. Deploying the
> stable launcher (steps 2–3) is still wanted, and is tracked in
> [2026-10-14-worker-auto-update_livetest.md](2026-10-14-worker-auto-update_livetest.md).
> Close this check against that doc rather than running it as written.

Why deferred: needs the updated checkout and Windows Task Scheduler access on windows-pc.

1. Inspect `Get-ScheduledTask -TaskName 'AI Orchestrator Worker Update'` and record its current
   state. If it exists and is enabled, disable it before updating the checkout to stop further
   scheduled pulls.
2. Once the updated checkout is present, disable the `AI Orchestrator Worker`
   keep-alive task, stop its running instance and the worker, and verify the task
   is no longer `Running`. Run the installer from the worker account with
   `-RegisterTask` to re-arm it after the launcher files are written. If the
   keep-alive task must be replaced, use an elevated shell with explicit `-WorkerUser` and
   `-InstallRoot` for the worker account:
   `powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath 'C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator' -InstallRoot 'C:\Users\shutu\.orchestrator' -WorkerUser '9950X3D\shutu' -RegisterTask`
3. Verify any `AI Orchestrator Worker Update` task has `Settings.Enabled = False`, and the
   deployed `%USERPROFILE%\.orchestrator\start-worker-autoupdate.bat` contains no `git pull`.
4. Start or restart the keep-alive task in a maintenance window. Verify the worker registers
   and local-model generation succeeds. A subsequent keep-alive trigger must not change the
   checkout commit, bundle stamp, or worker child PID while it is healthy.
5. In an isolated Windows harness, start a simulated provider child during the explicit
   updater's build step. Expect exit 3 and no worker stop. Repeat after the child exits;
   expect a restart of the supervised worker child only.

Expected: automatic triggers neither pull nor restart a healthy worker. An explicit invocation
of `update-running-worker.ps1` after a deliberate checkout update rebuilds the bundle and
restarts only the child if it is idle and supervised; otherwise it exits 3 and must be rerun
after the obstacle is cleared. The node reconnects
after that deliberate update. Check separately whether `exec_on_node` accepts commands; its
`trusted Windows ACL inspection failed` error may prevent this test and needs its own diagnosis.

## Check 2 — Coordinator advertises its addresses; worker stores them

Why deferred: needs the rebuilt coordinator and the new worker bundle from Check 1.

1. After Check 1, the worker re-registers.
2. Coordinator log: `grep "Advertised coordinator addresses" app.log | tail -1`.
3. On windows-pc: `(Get-Content $env:USERPROFILE\.orchestrator\worker-node.json | ConvertFrom-Json).advertisedCoordinatorUrls`

Expected: the log line lists `ws://macbook-pro.tail4fc107.ts.net:4878`, `ws://100.68.10.5:4878` and
the Mac's current LAN IPs (e.g. `ws://192.168.0.156:4878`); the worker config holds the same list.

## Check 3 — Worker survives the Mac's Tailscale being switched off

Why deferred: needs checks 1–2 in place and a deliberate Tailscale outage on the Mac.

1. On the Mac: `Tailscale down`.
2. Watch the coordinator log for the worker's socket closing, then re-registering.
3. `Tailscale up` afterwards.

Expected: windows-pc reconnects over a LAN address from `advertisedCoordinatorUrls` within about a
minute (registry `address` becomes a `192.168.0.x` address), instead of staying offline. If the PC
and Mac are not on the same LAN at the time, record that and treat this check as not applicable.

## Check 4 — "Tailscale is off" warning and node hint

Why deferred: needs the rebuilt coordinator and a Tailscale outage.

1. With windows-pc connected over Tailscale, run `Tailscale down` on the Mac.
2. Within 30 s (poll interval), expect one macOS notification: title `Tailscale is off on this
   computer`, body naming `windows-pc`.
3. If windows-pc disconnects (Check 3 not yet effective), open Remote Nodes and Settings →
   Computers.
4. `Tailscale up`.

Expected: exactly one notification per outage; the disconnected node shows `Tailscale is off on this
computer. This worker connects over Tailscale…`; the hint disappears after `Tailscale up` and
reconnection. Coordinator log shows `Coordinator Tailscale state changed` both ways.

## Check 5 — Update restart sign-on (ARSO) on windows-pc

Why deferred: needs an elevated PowerShell on windows-pc (a human), then a real update restart.

1. Elevated, on windows-pc:
   `powershell -ExecutionPolicy Bypass -File .\scripts\windows\configure-update-restart-signon.ps1 -WorkerUser '9950X3D\shutu' -Apply`
2. Re-run without `-Apply` and expect `Update sign-in ARSO : ON`.
3. Confirm in Settings → Accounts → Sign-in options that "Use my sign-in info to automatically
   finish setting up after an update" is on.
4. On the next Windows Update restart, expect the worker to re-register without anyone signing in
   (coordinator log `Node registered` for windows-pc within a few minutes of the PC's boot).

Baseline measured 2026-09-22 (report mode): ARSO `not set`, active hours `15:00 -> 9:00`.

## Status — 2026-09-24

Open: 5 · Closed: 0 · Failed: 1
Check 2's coordinator half was observed on 2026-09-24 and **failed** on one clause: the MagicDNS
URL was missing. That is filed and fixed in code as [LT-621](livetest-remediation-register.md).
Check 1, and everything that depends on it, remains blocked by James's 2026-09-24 decision to keep
the launcher change local and undeployed. Check 5 needs an elevated shell on `windows-pc`.

## Evidence run — 2026-09-24 (orchestrating session, packaged app built 2026-09-23 21:12)

- **Check 2, coordinator half — FAIL (one clause).** `app.log` `1790212171326`: `Advertised
  coordinator addresses to node {nodeId: bb62e3ee-…, urls: ["ws://100.68.10.5:4878",
  "ws://192.168.0.96:4878", "ws://192.168.0.156:4878"]}`. Both LAN IPs match this Mac's current
  `en0`/`en12` addresses, and the Tailscale IP is right. `ws://macbook-pro.tail4fc107.ts.net:4878` is
  missing although Tailscale reported `Running`. Root cause reproduced and fixed as LT-621. The
  worker half (reading `advertisedCoordinatorUrls` from `worker-node.json`) was not read, because it
  depends on check 1's worker bundle.

## Evidence run — 2026-10-04 (orchestrating session, packaged app built 2026-10-04 19:06)

- **Check 2 — PASS (both halves).** Coordinator: `app.log` 20:46:13 BST →
  `Advertised coordinator addresses` to `bb62e3ee-…` with
  `["ws://macbook-pro-2.tail4fc107.ts.net:4878","ws://100.68.10.5:4878","ws://192.168.178.103:4878"]`
  (copy: `_scratch/lt-2026-10-04/orch/advertised-addresses.log`). The MagicDNS clause that failed on
  2026-09-24 is now present, so **LT-621 is confirmed fixed live**. The Mac's own `tailscale status`
  reports `Running`, DNS name `macbook-pro-2.tail4fc107.ts.net.`, IP `100.68.10.5`, and its only
  current LAN address is `192.168.178.103` (the Mac's host name and network have changed since the
  doc was written; the advertised list matches the current machine). Worker: a read-only
  `run_on_node` (antigravity, instance `ihxifh199`, terminated afterwards) printed
  `advertisedCoordinatorUrls` from `%USERPROFILE%\.orchestrator\worker-node.json` as exactly the same
  three URLs, file last written `2026-10-04T20:46:13.4447345+01:00` — the same second as the
  advertisement. The running worker already stores the list, so this half did not in fact depend on
  check 1's undeployed launcher.
- Checks 1, 3, 4, 5 — **not run.** Check 1 is still held by James's 2026-09-24 decision to keep the
  launcher change local. Checks 3 and 4 require switching the Mac's Tailscale off, which would
  disconnect `windows-pc` from live sessions; that needs a window James chooses. Check 5 needs an
  elevated shell on `windows-pc` and a real Windows Update restart.

## Status — 2026-10-04

Open: 4 (checks 1, 3, 4, 5) · Closed: 1 (check 2) · Failed: 0.
