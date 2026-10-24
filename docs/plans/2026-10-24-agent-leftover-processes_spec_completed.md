# AIO stops programs that agents leave running — spec

**Status:** IMPLEMENTED 2026-10-24 (see the plan's as-built notes; live checks deferred to the livetest doc). Approved 2026-10-24. James chose every recommended option ("Go with the recommended").
**Plan:** [2026-10-24-agent-leftover-processes_plan_completed.md](2026-10-24-agent-leftover-processes_plan_completed.md).

**Decisions (section 9):**
1. Build it.
2. CPU burners are stopped.
3. Idle leftovers from ended sessions are listed in a notice, not stopped.
4. Hibernated sessions count as live.
5. Fix AIO's runners.
6. Add the guidance block.
7. Windows waits for a later phase.
8. No upstream reports for now.
9. Today's four leftovers are left alone.

**Amendments made while planning** (these override the body below where they differ):
- **One setting, not two.** `leftoverProcessCleanup`: `'off' | 'notify' | 'stop-cpu-hogs' | 'stop-all'`,
  default `'stop-cpu-hogs'`. The CPU threshold is a fixed 50% of one core over 10 minutes.
  `settings.types.ts` has two lines of headroom under its size ratchet.
- **Keep list (R4) deferred.** Under the chosen defaults, only an orphaned, attributed program burning
  CPU for 10 minutes is ever stopped automatically. A keep list adds settings surface without a case
  that needs it now.
- **Lineage uses a fixed 10 s table while sessions are live**, with no tool-call event trigger.
  Adapters do not share one tool-call event, and 10 s covers the incident's shell (about 70 s).
- **4.3 item 4 dropped** (the final group SIGKILL in `BaseCliAdapter.terminate()`). A timer still
  armed after `terminate()` resolves can fire a real `kill(-4242)` once a test's spy is restored. A
  SIGKILL sent at leader exit would also cut short MCP servers that close their own browsers on
  SIGTERM, which creates the very leftovers this work removes. The sweeper's `marker` attribution
  already covers CLI-group survivors, because MCP servers are third-party binaries.
- **CPU window depends on the owner** (made during implementation; tell James):
  - **Ended:** if this Harness run saw the owning session end, a burner is stopped after **10 min**.
  - **Live or unknown:** while the session is still open, or its owner is unknown, the window is
    **60 min**. Unknown means a crashed earlier run, or another Harness app on the same Mac.

  An agent may legitimately background a long test run or build and poll it. A 10-minute rule would
  kill that. The incident is still caught within about an hour instead of ten.
- **Unknown owners are never stopped as idle leftovers**, even in `stop-all`. They are only reported,
  because they may belong to another Harness app's live session.
- **Stopping at worktree removal honours the setting.** It is skipped in `off` and `notify`.
- **Stopping is per process, not per group.** A stop sends SIGTERM to the orphan and its same-user
  descendants (deepest first). Ten seconds later it sends SIGKILL to any whose pid and start time
  still match. Killing the whole group could reach members that are not orphans.
- **Table cost is logged, not throttled.** The first `ps` read, and any read over 500 ms, logs
  `Leftover process table read` with its row count and cost (livetest LS-1). Back-off is added only if
  the live numbers call for it.
- **Notices.** They name the session by its current title. Idle leftovers give their process numbers
  and point to Activity Monitor, because `stop_leftover_processes` is marker-only and cannot stop
  lineage-attributed Apple binaries.
- **Closed-session window.** Only CPU used after the session was seen closed counts toward the
  10 minutes.
- **Report correction.** On a timeout, the loop verifier's `killProcessTree` runs while the shell is
  still alive, so it does reach live descendants. It misses only ones already orphaned. A normal exit
  still kills nothing.
**Written:** 2026-10-24. **Evidence:** [2026-10-24-agent-leftover-processes_report.md](2026-10-24-agent-leftover-processes_report.md)
(the findings report; every claim below that says "verified" is backed there with file and line).
**Prompt:** `prompts/agent-process-cleanup_prompt.md`.

## 1. Problem

Agents run shell commands that start background programs. When the command or the session ends, those
programs can keep running for hours with nobody watching them.

- 23 October 2026: an OpenCode agent left eight `yes` processes burning about 72% of a core each for
  10 hours (load about 35).
- 20 October 2026: an implementer left 54 busy loops running (load about 135). It is recorded in
  agent memory, and nothing in AIO caught it either.
- 24 October 2026, at 00:10: a read-only census found seven programs reparented to launchd that carry AIO's session tag. Four of them
  belong to sessions that have already ended: a Java server (14 h, 1.1 GB), a Postgres test database
  (8 h), a Node process (7 h) and an `rtk` helper (22 h). Two more tagless leftovers, both `zsh` (18 h
  and 21 h), plus a Chrome (20 h), sat in AIO plan-queue worktrees.

Why nothing catches them (all verified; see the report, section A):

1. AIO's "stop session" kills the provider CLI's own process group. Claude Code and OpenCode run every
   shell command in a new session, and Codex runs each child in its own process group. So AIO's kill
   never reaches what an agent's command started, on any of the three main providers.
2. When a command exits normally, nothing in AIO runs at all. OpenCode only tidies a command's group
   when the command fails. The incident command ended with `echo "stress done"`, so it exited 0.
3. AIO's existing leftover finder (`list_host_processes` / `stop_leftover_processes`) only runs when an
   agent asks for it. It recognises leftovers by the `AI_ORCHESTRATOR_INSTANCE_ID` environment tag,
   and macOS hides the environment of code-signing-restricted programs, which includes Apple's own
   programs (`yes`, `sleep`, `zsh`) and, by test, Chrome. It would have refused to stop the incident's
   processes.
4. AIO's own command runners leak too. The plan-queue gate runner skips its own "stop what's left"
   step when a leftover has closed its output, which is reproduced with `sleep`. The loop verifier runs
   commands with no group and kills nothing after a normal finish.
5. On a crash or force-quit, nothing is stopped, and nothing sweeps on the next launch.

## 2. Goals

- G1. A program that an AIO session started, that has been orphaned to launchd, and that keeps burning
  CPU is stopped automatically within about 15 minutes, on every provider, with no agent cooperation.
  It must cover the incident exactly: Apple binaries, a command that exited 0, and a session that may
  still be open.
- G2. Leftovers from sessions that have ended are visible to James, and are stopped if he chooses that
  policy (decision 3).
- G3. AIO's own runners (plan-queue gates and hooks, loop verify) leave nothing behind.
- G4. After an AIO crash, the next launch finds and handles the previous run's leftovers.
- G5. Never stop a program AIO cannot attribute to one of its sessions, and never stop anything still
  attached to a live parent such as James's terminal.

## 3. Non-goals

- Windows worker containment. This is phase 2 (section 8), and it needs a native helper.
- Changing how providers run their own shells. Upstream fixes are suggested in the report and are
  James's call (decision 8).
- Per-command reaping at tool-call end. This is rejected in section 7, because it would kill dev
  servers that an agent started deliberately for its next step.
- Any remote telemetry. Everything stays local. Remote telemetry is a rejected stance in
  `docs/decisions/rejected/privacy-and-architecture.md`.
- A second policy engine. The sweeper is a process-hygiene service, not a permission authority. It
  reuses the existing host-process rules (same stance doc).

## 4. Design

### 4.1 Attribution: "which session started this program?"

Extend `src/main/process/host-process-inspector.ts` rather than adding a parallel inspector. Each
candidate gets an attribution source, strongest first:

| Source | How | Works for | Status today |
|---|---|---|---|
| `marker` | `AI_ORCHESTRATOR_INSTANCE_ID` in the process environment (`ps axeww`) | Third-party binaries (node, python, java, postgres, mysqld, rtk) | Exists |
| `lineage` | Process-group number recorded while the program's group was still under a live session CLI | Everything, including Apple binaries and Chrome | New |
| `worktree` | Current folder (cwd) inside an AIO-managed `.worktrees/*` checkout, or a session's working folder, and started while that session was live | Everything | New; supporting evidence only |

**Lineage recorder (new, `src/main/process/session-process-lineage.ts`).**
- While at least one local session is live, take one process table every 15 s, plus a debounced extra
  table on each tool-call start and finish event the adapters already emit.
- The table is `ps -A -o pid=,ppid=,pgid=,uid=,lstart=,time=,command=`, with no environment read.
- For every process whose parent chain reaches a live session CLI pid (`getLiveSessionPids()`, already
  in `host-process-instance-hooks.ts`), record `pgid → {instanceId, groupLeaderStart, firstSeen}`.
- Why this catches the incident (verified with a harmless `sleep` probe): when the tool shell exits,
  its background children are reparented to launchd but keep `pgid = sid = <dead shell pid>`. The
  shell was alive about 70 s, so a 15 s table records its group. The kernel does not reuse a group
  number while any member survives. The process start-time check (process started at or after the
  recorded `firstSeen` minus one table interval) rules out a reused pid from an older group.
- Persist the map (bounded; entries whose group has had no members for 24 h are pruned) to
  `userData/process-lineage.json`, so a post-crash launch can still attribute (G4).

`worktree` attribution alone never triggers an automatic stop. It only raises a candidate into the
"list and notify" tier (decision 3).

### 4.2 Sweeper (new, `src/main/process/leftover-process-sweeper.ts`)

- Singleton with `getLeftoverProcessSweeper()` and `_resetForTesting()`.
- Runs every 60 s while Harness runs, once at startup after crash recovery, and on demand from the
  existing MCP tool.
- Candidate filter, mirroring the existing stop rules and widened only in attribution:
  - same uid as Harness;
  - `ppid == 1` (orphaned, so nothing like James's terminal still owns it);
  - not Harness, and not a live session's own CLI pid;
  - attributed by `marker` or `lineage`.
- CPU is measured from the cumulative `time=` column, as a delta between sweeps over the window. The
  decaying `pcpu` figure is not used.

Rules:

| Rule | Condition | Action (default, see decisions) |
|---|---|---|
| R1 CPU burner | Attributed orphan averaging ≥ 50% of one core for ≥ 10 min | Stop. SIGTERM to its process group, SIGKILL after 10 s if any member is still alive. Then a notice: "Stopped `yes` (8 copies), left running by an OpenCode session in worktree X. It was using 6 cores for 10 h." Applies even if the owning session is still open. |
| R2 Ended-session leftover | Attributed orphan whose owning session is terminated or failed (or unknown to this Harness run) for ≥ 60 min | Decision 3: list and notify only (recommended), or stop. |
| R3 Hibernated owner | Owning session hibernated or errored | Treated as live. Only R1 applies. This matches the existing `DEAD_STATUSES` rule. |
| R4 Keep list | James marked the program "keep" | Never touched. Matched on program path plus working folder, until he removes it. |

- **Notices.** Use the existing `getNotificationService().notify(...)`, coalesced to at most one
  notice per sweep. Plain wording that follows `docs/screen-and-wording-guide.md`.
- **Settings.** Add `leftoverProcessSweeper` (`off` | `notify` | `stop-burners` (default) |
  `stop-burners-and-ended`) and `leftoverProcessCpuThresholdPercent` (default 50) through the existing
  settings registry, so `$AIO_MCP settings` can change them.
- **Cost.** One `ps` table every 15 s while sessions are live, and one table plus one environment read
  every 60 s. The existing inspector already reads both tables on demand. Measure the cost during
  implementation and back off to 30 s if a table costs more than 100 ms of CPU.
- **Logging.** A local log line for each attribution, stop and refusal, giving the program name only.
  No command lines or environments are logged, per the inspector's existing safety model.

### 4.3 AIO's own runners

1. `src/main/plan-queue/plan-queue-process.ts`: after the top process exits, always kill the group once
   the grace period ends, even if `close` has already settled the call. `finish()` currently clears the
   grace timer (line 62). Reproduced with `sleep 20 > /dev/null 2>&1 &`; the leftover survived.
2. `src/main/orchestration/loop-spawn-verify.ts`: spawn the verify shell `detached` on POSIX (own group)
   and kill that group after exit, after timeout and after cancel. Its current reaper
   (`loop-wait-on-pid.ts` `killProcessTree`) walks `pgrep -P` from a shell that has already exited, so
   it finds nothing.
3. `src/main/plan-queue/plan-queue-worktree.ts` `removeWithProof`: before deleting a worktree, ask the
   sweeper to stop attributed orphans whose working folder is inside it. The current check is git
   state only.
4. `src/main/cli/adapters/base-cli-adapter.ts` `terminate()`: after a graceful exit, send one final
   group SIGKILL if the group still has members. Today SIGKILL is skipped once the leader has exited,
   so group members that ignored SIGTERM survive. This is cheap. It does not reach tool-command
   sessions; that is the sweeper's job.

### 4.4 Agent guidance (cheap, weak, ship anyway)

Add `PROCESS_HYGIENE_SYSTEM_PROMPT` beside `DISK_HYGIENE_SYSTEM_PROMPT` in
`src/main/cli/adapters/adapter-guidance-prompts.ts`, pushed for every agent in
`adapter-spawn-helpers.ts` (the same block list that verifiably carries Disk Hygiene today). It should
be about five lines, following `docs/prompt-engineering-house-style.md`:

- Do not run CPU or memory stress, load generators or busy loops on the user's computer to test timing.
- Stop every background program you start before that same command ends, while your shell still owns
  it: `pkill -P $$`, or kill a PID array. Once the command has ended, the program has no parent and
  `pkill -P` cannot find it. The shell is zsh, which does not split `$VAR` into words; use an array
  (`pids+=($!)`, then `kill $pids`) or `${=PIDS}`.
- Confirm by PID (`kill -0` or `pgrep`) that they are gone, and do not hide the result of `kill` with
  `2>/dev/null`.
- Programs you are asked to leave running, such as a dev server, are fine. Say so in your final message.

How much weight this deserves: little on its own. Both recorded incidents involved agents that
believed they had cleaned up. The guidance reduces how often leftovers happen; the sweeper is what
catches them.

## 5. Acceptance criteria

1. **Incident replay (automated, harmless).** A vitest integration test runs
   `zsh -c 'for j in 1 2; do sleep 600 > /dev/null 2>&1 & done; echo done'` (exit 0) as the child of a
   fake session process. It records lineage while the shell lives, lets the shell exit, and then has the
   sweeper attribute both `sleep`s by `lineage` (not `marker`). It uses fake CPU deltas to trip R1 and
   asserts both are stopped and confirmed gone by PID. Real `sleep` processes, with hard cleanup in
   `afterEach`.
2. An Apple-binary orphan without lineage and without a marker is never stopped (G5).
3. An orphan with a parent other than launchd is never a candidate.
4. Pid-reuse guard: a process whose start time predates the recorded group is not attributed.
5. R2 respects the decision-3 setting, and R3 (hibernated owner) only applies R1.
6. Plan-queue runner: a `sleep` leftover with closed output is gone after the grace period (a new spec
   case beside `plan-queue-process.spec.ts`).
7. Loop verify: a backgrounded `sleep` is gone after a passing verify and after a timeout.
8. Startup after a simulated crash: persisted lineage plus markers attribute the previous run's
   orphans.
9. The guidance block is present for Claude, Codex, OpenCode, Copilot and Gemini spawns (extend the
   existing adapter-spawn-helpers spec).
10. The canonical verification checklist in `AGENTS.md` passes.

Live checks that need a rebuilt app go in a `_livetest.md`: real sessions on each provider leave a
harmless `sleep` behind, and the sweeper reports it. The R1 check uses a CPU-light stand-in with a
lowered threshold, never real CPU stress.

## 6. Risks

- **Stopping something James wanted.** Mitigated by orphan-only scope, attribution required, R2
  defaulting to notify, a keep list, and notices that name the program and session. A dev server an
  agent started for James and left orphaned after the session closed would be listed, not stopped,
  under the recommended defaults.
- **Process-table cost.** Bounded and measured (4.2).
- **Lineage gaps.** A command whose shell lives less than one interval is caught only by the tool-call
  event table or by `marker`. The incident shell lived about 70 s.
- **Tools that `setsid` or double-fork.** They get a new group. Lineage still sees them if they existed
  while the parent chain was intact, because the table records every group under the session at that
  moment. A daemon that forks away within the gap is caught by `marker` if it is a third-party binary.

## 7. Options considered and not chosen (details and sources in the report, section B)

- **CPU time limit (`ulimit -t`) on agent processes.** Per-process, inherited, and it would also kill
  long legitimate runs and the CLIs themselves. A blunt backstop at best.
- **Background QoS (`taskpolicy -b`) for whole sessions.** This would have softened the incident, but it
  slows every agent's builds and tests and makes timing tests flaky. Kept only as a possible gentler
  sweeper action (decision 2).
- **Per-command group reaping at tool-call end.** This kills dev servers that agents start on purpose
  for their next step (Claude `run_in_background`, Codex background terminals, OpenCode background
  shells).
- **Extending the bash-validation layer.** It only sees Claude's commands, and only outside
  auto-approve mode. It rated the incident command "safe". Coverage cannot be fixed from AIO for ACP
  and Codex.
- **Environment tag only.** macOS hides it for Apple and hardened binaries.

## 8. Phase 2: Windows worker (separate plan, after decision 7)

- Put each provider CLI on `windows-pc` in a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) so that
  closing the session kills every descendant, including ones whose parent has already exited.
  `taskkill /T` misses those today.
- The job's process list also gives the sweeper exact attribution on Windows, without needing lineage.
- This needs a small native helper (an N-API module or a signed helper exe). That is a new dependency
  and needs James's approval.

## 9. Decisions for James

1. Build the automatic sweeper (R1 on by default)? Recommended: yes.
2. What to do with a CPU burner: stop it (recommended), slow it to background priority and notify, or
   notify only.
3. Leftovers from ended sessions that are not burning CPU (databases, servers): list and notify
   (recommended), or stop after 60 min.
4. Treat hibernated sessions as live, so their leftovers are kept: recommended yes.
5. Fix AIO's own runners (4.3): recommended yes.
6. Add the agent guidance block (4.4): recommended yes.
7. Windows Job Objects as a phase-2 plan, which needs a native helper: recommended yes, later.
8. File upstream reports with OpenCode (exit 0 leaves the group alive) and add to Claude Code issue
   #96625: your call, since it publishes outside.
9. Stop the four leftovers found today (Java, Postgres, Node, rtk) now with the existing tool: your
   call.
