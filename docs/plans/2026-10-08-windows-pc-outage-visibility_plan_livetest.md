# Windows PC outage visibility live checks

Status: pending. Needs (a) James to install and launch a rebuilt Harness, and (b) a worker build on `windows-pc` that contains the host-boot and host-health changes.

Prerequisites:

- Coordinator: a packaged Harness built from a tree containing this change, installed and launched by James. Never restart the running Harness while live sessions exist.
- Worker: `windows-pc` deploys by `git pull` + rebuild in its launcher, which skips the rebuild while a worker is running. That needs the change committed and pushed (James must authorise) and a worker restart on the PC. Checks 1–4 need only the coordinator; checks 5–6 need the new worker.

Plan: [Windows PC outage visibility](2026-10-08-windows-pc-outage-visibility_plan_completed.md).

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md). Record any reproduced defect in [remediation register](livetest-remediation-register.md), with corresponding implementation status in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here; rename this document `_livetest_completed.md` only after these checks pass.

## Checks

1. **Browser computer remembered.** With `windows-pc` connected for at least 20 seconds, call `list_remote_nodes`. Expected: the `windows-pc` entry has `browserComputer: true`; `noahlaptop` and `Noah3900x` do not.
2. **Offline warning and alert.** Make `windows-pc` unreachable for over three minutes without rebooting it (for example, disconnect its network cable or switch Tailscale off on the PC). Expected within about two minutes of the drop (30 seconds after a clean socket close, up to about 100 seconds when only heartbeats stop): a red "windows-pc is offline (last seen HH:MM)" bar across the Harness window that cannot be dismissed, and a desktop notification reading "windows-pc is no longer connected. Agents will not use this Mac's browser without asking you first." Record whether the desktop notification was visible; if not, check System Settings > Notifications > Harness (allowed, style Persistent) and note the result.
3. **No silent Mac browser.** While the PC is still unreachable, ask a fresh Claude session and a fresh Codex session to "open bbc.co.uk in the browser". Expected: each tells James the Windows PC is offline and asks whether to use this Mac, wait or skip, without opening anything on the Mac. Then answer "use the Mac" in one of them. Expected: it opens the page on the Mac (explicit `computer: "local"`).
4. **Back online with a reason.** Reconnect the PC. Expected: the bar clears by itself, and a "windows-pc is back online" notification says how long it was offline and "The Harness worker program kept running but could not reach this Mac (a network drop, or the computer was asleep or frozen)." The Harness log has a `Worker node back online` line with `cause: "network"`.
5. **Host health reported (new worker).** After the new worker is running, wait 6 minutes. Expected: `[HostHealth]` lines in `C:\Users\shutu\.orchestrator\logs\worker-agent.log` every 5 minutes, and `list_remote_nodes` shows `workerAgent.hostBootedAt` and a `hostHealth` sample for `windows-pc`.
6. **Computer restart named (new worker).** At a convenient time, restart the Windows PC normally and log in. Expected: the back-online notification says "The computer restarted."

Why deferred: every code path is covered by unit tests run in this session, but the running Harness keeps the old code until James installs a new build, the worker on the PC only changes after a pushed commit and a worker restart, and checks 2–6 need the PC to actually drop or restart.
