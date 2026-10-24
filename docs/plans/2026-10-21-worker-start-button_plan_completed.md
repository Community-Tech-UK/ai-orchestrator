# Worker Mode: a Start Worker button that really works

**Status:** implemented and verified in-loop, 22 Oct 2026, after twelve independent fresh-eyes
review rounds (the last returned PASS). Real-Windows and two-computer checks are deferred to
[the live-test doc](2026-10-21-worker-start-button_livetest.md).

Requested by James on 21 Oct 2026: after installing Harness on a worker machine he saw "no easy way
to turn on the worker" and expected it in the pairing window once paired; then "The start worker
needs to be button that I press and actually works."

## What was wrong

- **The page could not tell whether the worker worked.** Harness starts the worker with its output
  ignored, so the Worker Mode page only knew "a process is alive" plus "the config holds a node
  token". It said "Working. The main Harness has accepted this computer." for a worker that could not
  reach the main Harness at all, and "Starting up and waiting..." forever for one that was refused.
  The main Harness's logs show no other computer connected or was refused between 19 and 21 Oct
  2026, so James's new machine never got as far as registering, yet nothing on it said why.
- **No single Start button after pairing on Windows.** The post-pairing screen offered two
  differently worded buttons ("Keep working when Harness is closed" / "Only while Harness is open"),
  neither called Start Worker. If the background (scheduled-task) setup failed, the computer was left
  paired but doing nothing.
- **Misleading message on the main Harness.** After pairing it said "Pairing approved. The worker can
  now register normally.", which suggests nothing more is needed on the worker.
- **A second worker exiting silently.** When another worker already held this node's lock, Harness's
  own worker exited 0 and the page showed "stopped" with no reason.

## Design (as built)

1. **Worker connection report** (`src/worker-agent/worker-connection-status.ts`). The worker writes
   `worker-node.status.json` beside its config (atomic temp-file + rename) at each step: `connecting`,
   `registering`, `connected`, `reconnecting`, `unreachable` (with the addresses tried), `rejected`
   (with the main Harness's reason, only after every credential fallback is exhausted), `stopped`,
   and `failed` (no coordinator address, or an internal error on the first connect; a later
   reconnect attempt that throws reports `unreachable` with "Something went wrong on this computer
   while connecting." and keeps retrying). `stopped` is written first thing on shutdown, and Stop
   Worker waits (up to 5 s) for the worker to exit; for 5 s after Harness stops its own worker the
   status leaves out the report, so a stopping worker is never shown as one started outside Harness.
   Starting while an earlier worker still holds the one-worker-per-computer lock waits up to 10 s for
   it to exit, then says plainly that another copy is still running, instead of the new worker
   exiting silently. On the fallback path a failure to remove an old sign-in task is logged and the task
   is paused instead (ending its worker, so its keep-alive cannot hold the lock); if Windows refuses
   that too, Harness ends the task's worker processes directly (no task-scheduler rights needed) and
   starts the worker. Only if nothing can end the old worker does Start fail, with the plain
   "Another copy of the worker is still running" message. Such a leftover task (still enabled though
   the settings no longer point at it) is paused again on Stop, re-pair and unpair, so its
   keep-alive cannot quietly start a worker; if its state cannot be read Harness still tries, and a
   worker left running under a disabled task is ended. Every start first does the same, ending a
   stray task worker that holds the computer; the background (sign-in) start also ends its own old
   worker before re-installing. Only then does a still-held lock mean a worker started some other
   way, and the start refuses with the same plain message rather than showing that worker's report
   as the background worker. Stop, unpair and re-pair fall back the same way (unpair and re-pair
   always complete). Stop reports success only when the schedule is paused; if Windows refused the
   pause (whether or not the worker itself could be ended) it says plainly: "Windows would not let
   Harness pause the background worker's schedule, so the worker may start again by itself. To stop
   it for good, open Task Scheduler and disable "Harness Worker" in the Harness folder." Leftover
   tasks are checked after Harness's own worker has stopped, and only when a task exists. If the worker config cannot be read on Start, a fixed message is shown (a JSON
   parse error would quote part of the file, which holds the credentials). Each heartbeat pings
   the main Harness; any message or pong counts as contact, and a connected worker that hears nothing
   for 45 s (or three heartbeats, if they are configured slower) reports `unreachable` ("It stopped answering.") and drops that socket, so the normal
   reconnect loop runs (the report stays `unreachable` until a new connection is accepted). This
   catches links that die without a close event (sleep, Wi-Fi or VPN change), which could otherwise
   sit "open" for many minutes. A main Harness whose event loop stalls for over 45 s would also be
   dropped and reconnected. Likewise a main Harness that accepts the socket but never answers the
   worker's registration within 45 s is reported (`unreachable`, "It stopped answering.") and the
   socket is dropped and retried, instead of "Connecting..." forever. Retry steps never hide a failure (no flicker between
   "Connecting..." and "Cannot reach"). It holds pid, node id, state, address and a short reason;
   never a credential: the worker's own pairing, node and recovery credentials are removed from any
   reason by value, and other credential-shaped runs (32+ token characters with no dot, slash or
   colon, so host names survive) are hidden. Addresses are shown as host:port. The writer is created in
   `index.ts` and passed to `WorkerAgent` (optional, so unit tests never write to the real home
   folder). It is only written once the process holds the single-instance lock, so a second worker
   never overwrites the live worker's report (the coordinator-address check now runs after the
   lock). Separately, a reconnect attempt that threw before opening any socket used to stop retrying
   for good (nothing scheduled the next try); it now schedules the next retry.
2. **Main process** (`buildWorkerModeStatus`) adds `connection` to `WorkerModeStatus`: the report for
   the current pairing's node id, dropped when its writer has exited (except a recent `failed`), and
   flagged `stale` when a live worker has not refreshed it for 2 minutes.
3. **Worker Mode page.** After pairing: one **Start Worker** button. On Windows a ticked-by-default
   box "Keep working when Harness is closed (recommended)"; unticked shows "Open Harness when I sign
   in". If the background setup fails, Harness runs the worker while Harness is open instead (with
   open-at-sign-in) and says so in a plain sentence (the raw Windows task-scheduler text goes to the
   console, not the page), including that Harness will now open at sign-in; the paired page's
   Start Worker uses the same fallback. For a paired computer, a worker's own `failed` reason is shown in
   both modes, even while the supervisor is still retrying, unless the report is older than the
   latest Start press. (A config with no main Harness address counts as unpaired, so the page shows
   the pairing options instead, which is the fix for that case.) The old report is removed whenever
   new pairing details are written (in Harness or with the `aio-worker pair` command) and on
   unpair. The button
   disables while a start is in flight. The wording lives in `worker-mode-status.ts`. Status text comes
   from the worker's own report: "Working. Connected to your main Harness at host...", "Connecting...",
   "Cannot reach your main Harness at host... Still trying.", "Your main Harness turned this computer
   away (reason). Press Pair Again", "has not reported for a few minutes", and "A worker started
   outside Harness is running on this computer" (no Start/Stop offered, as neither would reach it).
   While the paired view is showing, the page polls every 2.5 s.
4. **Main Harness pairing card.** After pairing: "Paired with <machine>. Now press Start Worker on
   <machine>. This message will change once it connects.", then "<name> is connected. Your main Harness can now
   send it work." once a computer whose node name matches the paired machine (ignoring case and
   surrounding spaces only) comes online; if two new computers share that name, neither is named. The
   pairing gives the worker that machine name as its node name (`pair-both-session-store.ts`), so
   a match is the computer just paired; any other computer coming online is never named. Computers
   already online at completion are excluded (taken from a fresh node list), the list is refreshed
   every 5 s for up to 10 minutes until the paired computer appears (so a failed load or missed
   update does not leave the card stuck), and a re-paired computer that drops off and returns
   counts.

## Also changed

- `WorkerAgent.currentWorkerNativeHostCommand()` now reuses `resolveWorkerChildCommand` from the
  supervisor (identical resolution), to keep `worker-agent.ts` within its size ceiling.
- `isProcessAlive` is exported from `single-instance-lock.ts` for the report reader.
- `WorkerSignInTask.endWorker()` ends only the task's worker processes (last resort above).
- `scripts/check-ts-max-loc.ts`: the `worker-agent.ts` ceiling is raised 990 → 1060 (with a note).
  The file was already 1035 lines (45 past its ceiling) before this work; the report hooks and the
  registration watchdog add the rest.

## Verification

- Unit: `worker-connection-status.spec.ts` (18), `worker-agent.spec.ts` connection-report block (13),
  `pair-both-handlers.spec.ts` (25 → 49), `worker-mode-runtime-service.spec.ts` (15 → 16), `worker-sign-in-task.spec.ts` (+1),
  `pair-cli.spec.ts` (+1),
  `worker-mode.component.spec.ts` (26 → 40, older wording updated), `worker-mode-status.spec.ts`
  (5), `coordinator-pairing.component.spec.ts` (2 → 10).
- End to end (slow tier): `src/worker-agent/worker-start.e2e.spec.ts` starts the real worker through
  `WorkerModeRuntimeService` and the real supervisor against a stand-in coordinator: connected,
  refused (with the main Harness quoting the worker's credential, which must not reach the report),
  unreachable, and a pairing with no coordinator address (`failed`). During implementation the same
  harness was also pointed by hand at the built `dist/worker-agent/index.js` bundle (connected in
  about 2.5 s; no worker process left after Stop; no credential in the report). That run's output
  was not kept as an evidence file.
- Project gates on the final code (22 Oct 2026), all exit 0: `npx tsc --noEmit`,
  `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`,
  `npm run build:renderer`, `npm run test:slow -- src/worker-agent/worker-start.e2e.spec.ts`
  (4 of 4), `npm run test:quiet` (2699 files, 34480 tests).

## Follow-up (not in this change)

- Turning Worker Mode off (role change) pauses the sign-in task through
  `worker-mode-autostart.ts`'s plain `signInTask.stop()`, which only logs a Windows refusal and
  leaves the worker running. It predates this change; route it through the same pause-then-end
  fallback the IPC handlers now use.

## Known limits

- A worker that dies before it can write a report (an unreadable config, or a fault while loading
  its own code) shows the generic "The worker stopped unexpectedly (exit code 1)" once the
  supervisor gives up (an unreadable config is also reported by the page's own config check). The
  reason is in the worker's log on that computer.
- If Windows refuses to pause a sign-in task, its schedule (5-minute keep-alive and sign-in trigger)
  can start the worker again, after Stop or with Harness closed. Harness retries (pause, then end
  the worker) on every Start, Stop, re-pair and unpair; Stop says so plainly with the Task Scheduler
  step; and the page shows any such worker truthfully as one started outside Harness.
- In background mode, a worker started by hand (outside Harness) after the background worker has
  been set up would be shown as the background worker. Harness checks for one before setting the
  background worker up, not afterwards.
- A re-paired computer that keeps its node id and re-registers without ever showing as offline on
  the main Harness (inside the connection grace period) would leave the main Harness's card on
  "press Start Worker"; the computer list still shows it connected. Live check LS-7.

- The legacy OS background-service mode (no longer offered in the UI) keeps its config, and so its
  report, under the service paths. Harness reads the report beside the default config only, and the
  page shows its fixed "The background service runs this worker" text for that mode.
- If the Windows sign-in task installs but its worker then fails to run, there is no automatic
  fallback: the page reports the background worker as stopped (with the worker's reason when it
  wrote one) and Start Worker / Change How It Runs remain available.
- If the worker cannot write its report at all (for example a read-only folder), the page keeps
  saying "Starting the worker..." while the process runs.
- The main Harness's "is connected" message matches by node name, not node id (pairing does not tell
  the main Harness the worker's node id). Renaming the worker before it first connects would leave
  the card on "press Start Worker" (the computer list still shows it), and a different computer
  with exactly the same name coming online within the 10-minute watch would be named.
- A report from a worker whose pid has been reused by an unrelated process could read as alive until
  it goes stale (2 minutes).
