# AIO stops programs that agents leave running — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-24-agent-leftover-processes_plan_completed.md](2026-10-24-agent-leftover-processes_plan_completed.md)

**Prerequisites:**

- Harness rebuilt from this checkout and restarted by James. Never restart Harness while sessions are
  live.
- The setting **Programs agents leave running** (Settings › Memory) is at its default, "Stop runaway
  ones, report the rest", unless a step says otherwise.
- Why these cannot run in-loop: the agent sandbox blocks `ps`, so the real `ps` path of the sweeper
  only runs inside the unsandboxed Harness main process. The same mechanics were proven in-loop with
  real processes and a libproc stand-in for `ps` (`_scratch/proc-cleanup/real-replay.ts`), and
  `leftover-process-sweeper.real.spec.ts` runs them against real `ps` wherever `ps` is usable.
- Never use real CPU stress. CPU-hog checks use a CPU-light stand-in, as described in each step.

Open: 6 of 6.

## LS-1 The real `ps` table parses on macOS

Steps: after the restart, open `~/Library/Application Support/Harness/logs/app.log` and search for
`LeftoverProcessSweeper`. Expected: no "Leftover process check failed" warning in the first 5 minutes.
In particular, there must be no parse failure from the `time` column, whose BSD format (`MMM:SS.ss`)
was implemented from documentation, not seen locally. Also record the `rows` and `costMs` from the
`Leftover process table read` line. Expected: `costMs` well under 500. If it is not, open an LT item
for back-off. Status: open.

## LS-2 Leftovers from earlier sessions are reported, not stopped

Steps: leave Harness running for 65 minutes after the restart. Expected: one notice titled "Leftover
programs from agent sessions" lists programs such as the Java server, Postgres, Node and rtk found on
24 October, if they are still running. It describes them as "started by a session that Harness no
longer has open", with their process numbers and the Activity Monitor hint. None of them is stopped.
A second notice for the same programs does not appear. Status: open.

## LS-3 An exited tool command's background `sleep` is attributed on each provider

Steps: in a new session on each of Claude, Codex and OpenCode, ask the agent to run exactly
`sleep 900 > /dev/null 2>&1 & echo $!` and stop. Note the PID. In any session, call
`list_host_processes` with `leftoverOnly: true`. Expected: is the noted PID listed? With today's tool,
which is marker-only, a `sleep` is not listed; that is expected and not a defect. Then wait one
minute and check app.log for no sweeper error. Finally ask an agent to call `stop_leftover_processes`
on those PIDs, or kill them yourself. Status: open.

Note: the lineage attribution itself is not exposed by `list_host_processes`. LS-4 is the observable
check.

## LS-4 Worktree removal stops a leftover

Steps: run a small plan-queue item whose plan asks the agent to run
`sleep 900 > /dev/null 2>&1 & echo $!` inside its worktree and then finish. Let the item land.
Expected: app.log shows "Stopped leftover programs before removing a worktree", and the noted PID is
gone (`kill -0 <pid>` fails). Status: open.

## LS-5 A CPU hog from an ended session is stopped (stand-in, no stress)

Steps: this needs a temporary threshold, so do it only in a dev build. Set
`CPU_HOG_CORES = 0.0001` and `CPU_WINDOW_SEC = 120` in `leftover-process-sweeper.ts`, rebuild, and
start a session. Ask it to run `sh -c 'while sleep 0.01; do :; done' > /dev/null 2>&1 & echo $!`,
then close the session. Expected: within about 3 minutes a notice says it stopped one program, and the
PID is gone. Revert the constants afterwards. Status: open.

## LS-6 Settings control

Steps: in Settings › Memory, find **Programs agents leave running**. Switch it to "Do nothing" and
repeat LS-4. Expected: no "Stopped leftover programs" line, and the `sleep` survives (kill it by hand
afterwards). Switch it back to the default. Also confirm
`$AIO_MCP settings set leftoverProcessCleanup notify` is accepted. Status: open.
