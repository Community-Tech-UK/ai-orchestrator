# Worker Mode: keep working when Harness is closed (Windows)

**Status:** implemented and verified in-loop, 20 Oct 2026. Every real-Windows check is deferred to
[the live-test doc](2026-10-20-worker-mode-sign-in-worker_livetest.md) (needs the new Windows
machine). Originally written 20 Oct 2026. Requested by James ("yeah build that for the new machine") after
the Worker Mode "Install background service" button was found unusable (needs admin, WinSW never
shipped, service account cannot see the user's CLI logins). 

## Goal

On Windows, a paired Worker Mode computer can run its worker independently of Harness, the way
windows-pc does: it starts hidden when the user signs in, runs as that user (so it sees their
Claude/Codex/etc. logins and desktop), is restarted within about five minutes if it dies, needs no
administrator rights, and keeps running with Harness closed. Harness updates must reach it and must
not be blocked by it.

## Design

1. **Own copy of the worker.** Copy the bundled worker folder (`resources/worker-agent-cli`, i.e.
   `aio-worker.exe` plus `worker-tools`) into
   `%LOCALAPPDATA%\Harness\worker\versions\<build-id>\` (only `aio-worker.exe` and
   `worker-tools`). The build id is a short hash of the bundled exe's name, size and modification
   time. Running from a private copy means the
   Harness installer never meets a locked `aio-worker.exe`.
2. **Hidden launcher.** Write `%LOCALAPPDATA%\Harness\worker\run-worker-hidden.vbs`, which runs
   `"<copy>\aio-worker.exe" --config "%USERPROFILE%\.orchestrator\worker-node.json" --supervise`
   with window style 0 and waits for it. This is the windows-pc pattern
   (`scripts/windows/run-worker-hidden.template.vbs`): blocking keeps the scheduled task "Running"
   for the worker's lifetime.
3. **Per-user scheduled task** `\Harness\Harness Worker`, registered with `Register-ScheduledTask`
   (no elevation): an at-logon trigger for the current user, a separate time trigger repeating
   every 5 minutes as the keep-alive, `MultipleInstances IgnoreNew`, no execution time limit,
   battery-friendly settings, principal = current user, Interactive, Limited. Action:
   `wscript.exe "<launcher>"`. Mirrors `scripts/windows/install-worker-launcher.ps1`.
4. **Stopping** ends the worker by killing processes whose executable lives under the private
   versions folder (the supervisor and its child). "Stop Worker" also disables the task so the
   keep-alive does not bring it straight back; "Start Worker" enables and starts it.
5. **Updates.** On every Harness launch with this mode on: if the bundled build id differs from the
   deployed one, copy the new build, rewrite the launcher, re-register the task, stop the old
   worker, start the task, and prune older version folders that are no longer in use.
6. **Harness integration.**
   - New setting `workerMode.runAtSignIn` (Windows). When on, Harness does not start its own in-app
     worker; launch autostart reports `sign-in-task`.
   - Run mode `sign-in-task` in the run-mode IPC. Choosing it stops the in-app worker, deploys,
     registers and starts the task. Choosing "Only while Harness is open" removes the task.
   - Status: "running" for this mode is read from the worker's own single-instance lock file
     (same user, same temp folder) plus a process-alive check, so it reflects the real worker.
   - Re-pair, unpair and leaving the worker role stop the task worker first so it cannot keep the
     old credential or write the old config back. Unpair and turning the mode off remove the task.
     Leaving the worker role disables it; returning enables it.
7. **UI.** After pairing on Windows: "Keep working when Harness is closed" (recommended) or "Only
   while Harness is open" (with the existing "Open Harness when I sign in" box). The paired view
   says which mode is active and offers "Change how this worker runs".

## Known limits

- The launch-time update ends the running worker without checking whether it is busy, so a job on
  that worker when Harness first opens after an update is interrupted (the coordinator sees the node
  drop and reconnect).
- Uninstalling Harness leaves the task and private copy behind; `docs/WORKER_AGENT_SETUP.md` says to
  unpair first and how to clean up by hand.

## Out of scope

- macOS/Linux equivalents (launchd agent / systemd user unit). The old OS-service CLI stays.
- Uninstalling an old WinSW service (none can exist from the UI path).

## Verification

- Unit tests with injected PowerShell/filesystem for deploy, register, start/stop, remove, update
  and status; handler, autostart, lifecycle and component tests.
- Project gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run verify:ipc`, `npm run build:main`, `npm run build:renderer`,
  `npm run test:quiet`.
- Fresh-eyes completion gate.
- Real Windows behaviour (task registration as a standard user, hidden launch, survives Harness
  quit and a reboot, update hand-over) needs the new Windows machine and goes in a `_livetest.md`.

## As built

- `src/main/remote-node/worker-sign-in-task.ts`: deploy (copy prepared before the running worker is
  touched), hidden launcher, task registration, start/stop/remove, launch-time `ensureCurrent`, all
  serialised. Every PowerShell script ends `exit 0`; real failures exit earlier under
  `$ErrorActionPreference = 'Stop'`; "no such task" (`ObjectNotFound`) is tolerated, other faults are
  not. A failed switch-over re-enables a task that was running; a `switching` marker separates an
  interrupted switch-over from a user pause, and Stop clears it strictly so a user's Stop always wins.
  Force-killed workers' stale single-instance locks are removed.
- `src/worker-agent/single-instance-lock.ts`: `singleInstanceLockPath`, `isSingleInstanceLockHeld`
  (status for a worker Harness did not start).
- `src/worker-agent/extension-relay-native-registration.ts`: repairs a native-host wrapper that names
  a moved/pruned worker executable.
- Settings `workerMode.runAtSignIn`; run mode `sign-in-task`; handlers, autostart skip, role
  lifecycle, launch upkeep; Worker Mode UI ("Keep working when Harness is closed", "Change How It
  Runs", a "Starting..." state). A failed setup removes only a task it created and restarts
  Harness's own worker if it had been running.
- Docs: `docs/WORKER_AGENT_SETUP.md` ("Worker Mode in the Installed Harness App", uninstall note).

## Verification record

- Gates green: `npx tsc --noEmit`, `npm run typecheck:spec`, worker tsc, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run verify:ipc`, `npm run build:main`, `npm run build:renderer`,
  `npm run test:quiet` (full suite).
- Fresh-eyes completion gate: six independent review passes. Each round's findings were fixed and
  re-reviewed; the final pass, on the final code, returned PASS with no blocking findings.
- Not verified on Windows: a read-only PowerShell syntax check on windows-pc was refused by that
  node's command policy (20 Oct 2026). All real-Windows behaviour is in the live-test doc.
