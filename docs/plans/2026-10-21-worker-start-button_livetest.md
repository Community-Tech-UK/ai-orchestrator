# Worker Mode Start Worker button — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-21-worker-start-button_plan_completed.md](2026-10-21-worker-start-button_plan_completed.md)

**Prerequisites:**

- A packaged Windows build of Harness from this checkout installed on James's **new** Windows
  machine (not windows-pc, which runs its own checkout worker on the same config file).
- The main Harness (this Mac) rebuilt from this checkout and running, Remote Nodes enabled.
- Why these cannot run in-loop: they need a second computer, a real Windows install, and the
  rebuilt main Harness. The worker side was proven in-loop against a stand-in coordinator.
- Run these alongside `2026-10-20-worker-mode-sign-in-worker_livetest.md`; several steps overlap.

Open: 9 of 9.

## LS-1 Start Worker after pairing connects

Steps: on the new machine choose worker mode, pair with the main Harness, confirm the code, approve
on the main Harness. Expected: the worker shows "Paired with your main Harness" and one **Start
Worker** button, with "Keep working when Harness is closed (recommended)" ticked. Press Start Worker.
Expected: "Connecting to your main Harness at ..." and then, within about 30 seconds, "Working in the
background, even with Harness closed. Connected to your main Harness at ...". Status: open.

## LS-2 The main Harness says what to do and when it worked

Steps: during LS-1, watch Settings → Remote Nodes → Pairing on the main Harness. Expected: after the
code is confirmed it says "Paired with <machine>. Now press Start Worker on <machine>."; after Start
Worker it changes to "<name> is connected. Your main Harness can now send it work." Status: open.

## LS-3 Cannot reach the main Harness

Steps: on the main Harness turn Remote Nodes off (or quit Harness). On the worker, watch Worker Mode.
Expected: within about a minute it says "Lost the connection to your main Harness... Reconnecting..."
then "Cannot reach your main Harness at ... Still trying." Turn Remote Nodes back on: it returns to
"Working. Connected ..." without pressing anything. Status: open.

## LS-4 Refused

Steps: on the main Harness remove/revoke the worker node (Settings → Remote Nodes → the computer →
remove), leaving the worker running. Expected: the worker page says "Your main Harness turned this
computer away (...). Press Pair Again to pair it again." Pair Again and Start Worker recover it.
Status: open.

## LS-5 Background setup fails, worker still starts

Steps: make the scheduled task impossible to create (from an administrator PowerShell register any
task named `\Harness\Harness Worker` so the standard user cannot replace it), then pair and press
Start Worker with the box ticked. Expected: a note "Windows would not let Harness set the worker up
to keep working with Harness closed, so it is running while Harness is open instead. Harness will
open when you sign in, so it keeps working after a restart." and the worker connects. Delete the administrator's task afterwards. Status: open.

## LS-6 Only while Harness is open

Steps: Unpair, pair again, untick "Keep working when Harness is closed", leave "Open Harness when I
sign in" ticked, press Start Worker. Expected: "Working. Connected to your main Harness at ...";
quitting Harness takes the computer offline on the main Harness. Status: open.

## LS-7 Re-pair an already connected computer

Steps: with the new machine connected, press **Pair Again** on it and pair with the main Harness
again (Settings → Remote Nodes → Pairing → Pair Another Computer). Expected: the main Harness's
card first says "Now press Start Worker on <machine>", then "<machine> is connected" once Start
Worker is pressed. If it stays on "press Start Worker" while the computer list shows the machine
connected, record it (known limit in the plan; decides whether a node-id match is needed).
Status: open.

## LS-8 Start straight after Stop

Steps: while a task runs on the worker (for example a long `run_on_node` prompt), press **Stop
Worker** and then **Start Worker** at once. Expected: either it starts and reconnects within about
10 seconds, or the page says "Another copy of the worker is still running on this computer...
press Start Worker again"; never a silent "stopped". Status: open.

## LS-9 Stop when Windows will not pause the schedule

Steps: in background mode, from an administrator PowerShell change the `\Harness\Harness Worker`
task's security so the standard user cannot disable it (or otherwise make `Disable-ScheduledTask`
fail for the user), then press **Stop Worker**. Expected: the page shows "Windows would not let
Harness pause the background worker's schedule, so the worker may start again by itself. To stop it
for good, open Task Scheduler and disable "Harness Worker" in the Harness folder." and the worker
process is gone. Undo the security change afterwards. Status: open.
