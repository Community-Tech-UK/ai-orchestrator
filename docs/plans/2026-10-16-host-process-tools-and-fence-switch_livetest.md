# Host process tools and signal-fence off switch — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-16-host-process-tools-and-fence-switch_plan_completed.md](2026-10-16-host-process-tools-and-fence-switch_plan_completed.md)

**Prerequisites:**

- Rebuild the packaged app from this checkout (`npm run build`, which includes
  `build:aio-mcp-dist` for the MCP forwarder) and have James restart Harness when no live sessions
  need it. Never restart Harness with live sessions on an agent's own initiative.
- Why these are deferred: every Harness session runs inside the Seatbelt signal fence, so `ps`
  and `top` cannot run there, and a dev app launched from a session inherits the fence. The real
  `ps` output, a real signal, and a real unfenced spawn can only be seen from the restarted app.
  All parsing, refusal rules, spawn arguments and UI wiring are covered by unit tests.
- Use `kill -0 <pid>` to test signal permission. It sends no signal; exit 0 means "allowed",
  "Operation not permitted" means the fence blocked it.

## Checks

### LT-A1 — CPU listing works from a session

1. In a normal (fenced) Claude session, ask the agent to search the orchestrator tools for
   "process" and call `list_host_processes` with `limit: 10`.
2. Expected: 10 rows sorted by CPU, able to include programs owned by other users (with
   `nameFilter: "WindowServer"` a row with `ownedByYou: false` appears), real non-zero
   `cpuPercent` on at least one row, `summary.cpuCount` equal to the Mac's core count, and no
   `notes` entry (the environment table was readable).
3. Expected: no row shows a full command line, file path with arguments, or any `=` assignment.

Status: open

### LT-A2 — A session can stop its own leftover

1. In a fenced session, run `nohup node -e "setInterval(() => {}, 1e6)" >/dev/null 2>&1 &` then
   `disown`, and note the pid. Let the shell that started it exit (end the command), so the
   program is re-parented to launchd. `pgrep -P 1 -f "setInterval"` should show it.
2. Call `list_host_processes` with `nameFilter: "node"`.
3. Expected: the row has `parentPid: 1`, `leftover: true`, `stoppable: true`.
4. Call `stop_leftover_processes` with that pid.
5. Expected: outcome `stopped`; `pgrep -f "setInterval"` no longer finds it.

Status: open

### LT-A3 — A leftover from another live session is refused

1. Repeat LT-A2 step 1 in session A and keep session A open.
2. From session B, call `stop_leftover_processes` with that pid.
3. Expected: outcome `refused`, reason "belongs to another session that is still running". The
   program is still running. Clean it up from session A.

Status: open

### LT-A4 — Programs Harness did not start are refused

1. From any session, call `stop_leftover_processes` with the pid of Finder
   (`pgrep -x Finder`).
2. Expected: `refused` with a plain reason ("still has a parent program" or "was not started by a
   Harness session"). Finder keeps running.

Status: open

### LT-B1 — Per-session Fence OFF lifts the fence for that session only

1. In the new-session composer, confirm a "Fence ON" button next to "Hardened". Click it so it
   reads "Fence OFF" and start a Claude session.
2. In that session run `kill -0 $(pgrep -x Finder)`. Expected: exit 0.
3. In an ordinary session started with Fence ON, run the same command. Expected: "Operation not
   permitted".
4. Start another new session without touching the button. Expected: the button reads "Fence ON"
   again (the choice is not remembered).

Status: open

### LT-B2 — Settings switch lifts the fence for new sessions

1. Settings > Advanced > Security > "Session process fence": turn "Stop sessions from closing each
   other's programs" off.
2. Start a new session. In it, `kill -0 $(pgrep -x Finder)`. Expected: exit 0. The composer's
   Fence button reads "Fence OFF" and is disabled.
3. Ask an agent to run `$AIO_MCP settings set providerSignalFenceEnabled true`. Expected: refused
   as operator-only.
4. Turn the switch back on and start a new session. Expected: `kill -0` is blocked again.

Status: open

### LT-B3 — Codex app-server session honours Fence OFF

1. Start a Codex session with Fence OFF (app-server mode, the default).
2. In it run `kill -0 $(pgrep -x Finder)`. Expected: exit 0.

Status: open
