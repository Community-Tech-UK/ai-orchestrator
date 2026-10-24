# Worker Mode sign-in worker and pairing fixes — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-20-worker-mode-sign-in-worker_plan_completed.md](2026-10-20-worker-mode-sign-in-worker_plan_completed.md)

**Prerequisites:**

- A packaged Windows build of Harness from this checkout, installed on James's **new** Windows
  machine (not windows-pc: windows-pc runs a checkout worker on the same
  `%USERPROFILE%\.orchestrator\worker-node.json` and must not get a second one).
- A main Harness (coordinator) on another computer with Remote Nodes enabled.
- Signed in to Windows as an ordinary user. Do not run Harness as administrator.
- Why these cannot run in-loop: they need real Windows Task Scheduler, Windows Script Host, a sign-out
  or reboot, and a second computer. The agent's only Windows machine (windows-pc) refused even a
  read-only PowerShell syntax check by policy on 20 Oct 2026, so the generated PowerShell has been
  unit-tested but never parsed or run on Windows.

Open: 16 of 16.

## LT-1 Worker Mode leaves the rest of Harness usable

Steps: on the new machine choose "Use this computer as a worker" (or Settings → Remote Nodes →
Computer Role → Worker). Expected: Harness opens the Worker Mode page with a Back button; Back, the
dashboard, chats and Settings all still work. Status: open.

## LT-2 Pairing survives a Harness restart

Steps: pair with the main Harness (code matches, approve). Choose either run mode. Quit and reopen
Harness. Expected: Worker Mode shows "Paired with your main Harness", not "Pair With Harness"; the
main Harness lists the computer as connected. Status: open.

## LT-3 "Keep working when Harness is closed" sets up without admin rights

Steps: after pairing choose **Keep working when Harness is closed**. Expected: no error and no UAC
prompt; no console window appears; Task Scheduler shows `\Harness\Harness Worker` (Running) with an
"At log on" trigger and a 5-minute repeating trigger; `%LOCALAPPDATA%\Harness\worker\versions\`
holds one folder; the main Harness shows the computer connected within a minute; Worker Mode says
"Working in the background, even with Harness closed." Status: open.

## LT-4 The worker keeps running with Harness closed

Steps: quit Harness (all windows). Wait two minutes. Expected: the main Harness still shows the
computer connected and can run a task on it (`run_on_node`). Status: open.

## LT-5 Reboot / sign-in

Steps: restart Windows and sign in, without opening Harness. Expected: within about a minute the
main Harness shows the computer connected; no console window was visible at sign-in. Status: open.

## LT-6 Keep-alive restarts a killed worker

Steps: in Task Manager end `aio-worker.exe` (both processes). Expected: within about five minutes
the worker is back and the main Harness shows it connected again. Status: open.

## LT-7 Stop and Start

Steps: in Worker Mode press **Stop Worker**. Expected: the task shows Disabled, the computer goes
offline on the main Harness, and it stays offline after five minutes and after a restart. Press
**Start Worker**: the task is Ready/Running and the computer reconnects. Status: open.

## LT-8 A Harness update reaches the worker and is not blocked by it

Steps: with the sign-in worker running, install a newer Harness build. Expected: the installer
completes with no "file in use" error; on the next Harness launch the versions folder holds only
the new build's folder and the running `aio-worker.exe` path is inside it. Status: open.

## LT-9 Switching back and unpairing clean up

Steps: **Change How It Runs → Only while Harness is open**. Expected: the task is gone and the worker
now runs as Harness's child (stops when Harness quits). Then switch back to the background mode and
press **Unpair this computer**. Expected: the task is gone, no `aio-worker.exe` is running from
`%LOCALAPPDATA%\Harness\worker`, and the versions folder is empty. Status: open.

## LT-10 Re-pair after Stop

Steps: in background mode press **Stop Worker**, then **Pair Again** and complete pairing with the
main Harness. Expected: no error; after choosing a run mode the worker connects with the new
pairing. Status: open.

## LT-11 Unpair when the task was deleted by hand

Steps: in background mode delete `\Harness\Harness Worker` in Task Scheduler, then press **Unpair
this computer**. Expected: unpair succeeds with no error; no `aio-worker.exe` is left running from
`%LOCALAPPDATA%\Harness\worker`. Status: open.

## LT-12 Browser extension relay after an update (only if the relay is enabled)

Steps: with the worker's extension relay enabled, update Harness (LT-8), then use a browser tool
that goes through the relay. Expected: the relay's native-host wrapper (the `.cmd` file in
`%USERPROFILE%\.orchestrator\browser-gateway\native-host\`) names the new
`versions\<build>\aio-worker.exe`, and the relay works. Status: open.

## LT-13 Error text is readable

Steps: from an administrator PowerShell, register any task named `\Harness\Harness Worker` so the
standard user cannot replace it; then, as the standard user, choose **Keep working when Harness is
closed**. Expected: Worker Mode shows "Windows task setup failed: ..." with a readable reason, not
an encoded command line or raw XML. Delete the administrator's task afterwards. Status: open.

## LT-14 Start while already running, and the starting message

Steps: choose **Keep working when Harness is closed**. Expected: the page says "Starting the
background worker..." and then, within about 30 seconds, "Working in the background...". Then, from
an elevated or normal PowerShell, run `Start-ScheduledTask -TaskPath '\Harness\' -TaskName 'Harness
Worker'` while it is running, and press **Change How It Runs → Keep working when Harness is closed**
again. Expected: no error, still exactly one supervisor and one worker `aio-worker.exe`. Status: open.

## LT-15 First-time setup with no task at all

Steps: on a machine where `\Harness\Harness Worker` has never existed, choose **Keep working when
Harness is closed**. Expected: success (the "no such task" checks are treated as absent, not as a
failure). Status: open.

## LT-16 Re-choose the background mode over a paused worker

Steps: press **Stop Worker** (task Disabled), then **Change How It Runs → Keep working when Harness
is closed**. Expected: no error; the task is enabled and running and the computer reconnects.
Status: open.

