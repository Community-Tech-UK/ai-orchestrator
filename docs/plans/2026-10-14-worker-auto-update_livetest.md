# Worker auto-update — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-14-worker-auto-update_plan_completed.md](2026-10-14-worker-auto-update_plan_completed.md)

**Prerequisites:**

- The change is committed and pushed to the branch windows-pc tracks (James's approval).
- windows-pc (node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`), worker user `9950X3D\shutu`, checkout
  `C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator`.
- Coordinator log: `~/Library/Application Support/Harness/logs/app.log` (JSON lines). Worker logs:
  `C:\Users\shutu\.orchestrator\logs\worker-agent.log` and `worker-supervisor.log`.
- Evidence collection works by uploading a `.ps1` with `upload_to_node` and running it through
  `run_on_node` (provider `antigravity`); `exec_on_node` only allows literal-output PowerShell.

## Check 1 — One-time rollout onto the new code

Why deferred: the code must reach the PC by a push, and the running worker, supervisor and
Chrome extension all predate it. Old native hosts drop the new reload signal, so this first
transition needs one manual restart of each.

1. At the PC (or via a detached process), run the Desktop `restart-worker.bat`. It stops the
   supervisor too, so the relaunch builds from the pulled checkout and the new supervisor sets
   `AIO_WORKER_SUPERVISED=1`.
2. Restart Chrome (`scripts\windows\restart-chrome.bat`), so the extension runs 0.2.40 or later and
   its native hosts run the new bundle.
3. `list_remote_nodes`: `workerAgent.buildCommit` equals the checkout HEAD, and
   `workerAgent.autoUpdate.state` is `idle` (not `disabled`). `extensionRelay.extensionVersion`
   is the manifest version at HEAD.

Expected: worker log has `[WorkerSelfUpdate] Automatic updates are on`.

## Check 2 — Retire the old launcher's blind pull (optional but recommended)

Why deferred: needs an elevated PowerShell on windows-pc (a human), and the keep-alive task
disabled for the maintenance window.

1. `Disable-ScheduledTask -TaskName 'AI Orchestrator Worker'`, stop its running instance.
2. Elevated, `whoami` first, then:
   `powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 -RepoPath 'C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator' -InstallRoot 'C:\Users\shutu\.orchestrator' -WorkerUser '9950X3D\shutu' -RegisterTask`
3. Deployed `%USERPROFILE%\.orchestrator\start-worker-autoupdate.bat` contains no `git pull`;
   task `NextRunTime` populated.

Expected: `git reflog` on the PC shows no `pull --ff-only` entries after this point; updates
arrive as `merge --ff-only` from the worker instead.

## Check 3 — An ordinary pushed commit is applied end to end

Why deferred: needs a real pushed commit and the live PC.

1. With the PC idle (no `run_on_node` instances, no browser commands), push any commit.
2. Within about 10 minutes expect, in order: worker log `[WorkerSelfUpdate] Updating worker`,
   `New bundle in place`, `Restarting onto the new bundle`; supervisor log
   `Worker child exited to load an update`; coordinator `Node re-registered within disconnect
   grace`; `list_remote_nodes` `buildCommit` = the new commit.
3. If the commit changed `resources/browser-extension/`: `extensionRelay.extensionReloadedAt`
   moves forward and `extensionVersion` matches the new manifest. If it changed only the
   native host: the native host processes under Chrome have a start time after the update.
4. A browser command against a shared tab on windows-pc succeeds without anyone restarting
   Chrome or the worker.

## Check 4 — Busy worker defers the update

1. Start a long `run_on_node` task, then push a commit.
2. Expect `autoUpdate.state` `waiting_for_idle` while it runs, and the update only after it ends
   (plus three quiet minutes).

## Check 5 — A broken commit never takes the node offline

Only on a scratch branch the PC tracks, or skip: needs a deliberately broken push.

1. Push a commit whose worker build fails.
2. Expect `autoUpdate.state` `blocked` with the build error as `reason`, HEAD rolled back to the
   running build, the node still connected, and `.auto-update-failed` naming the commit.
3. Push a fix: the update proceeds and `.auto-update-failed` disappears.

## Status — 2026-10-14

Open: 5 · Closed: 0 · Failed: 0

The isolated Windows harness for the updater itself (real git, node build, self-check, swap,
rollback, restore, and the batch-file `& exit /b` resume) passed on windows-pc on 2026-10-14;
evidence is in the plan's "Windows harness evidence" section. The checks above still need the
real worker, Chrome and a pushed commit.
