# Prompt: why AIO agents leave processes running, and how to stop it

Paste everything below the line into a fresh session started in
`/Users/suas/work/orchestrat0r/ai-orchestrator`.

---

## Goal

Agent sessions run by AI Orchestrator (AIO) sometimes start background processes and leave them
running after the command or the whole session ends. Find out why AIO does not catch and clean up
those leftovers. Then research and recommend how to stop it happening again, for every provider
AIO runs (Claude, Codex, OpenCode, Copilot, Gemini, and so on), not just the one in the incident
below.

This is an investigation and research task. **Do not change product code.** Deliver a findings
report plus a proposed spec, and James will decide what gets built.

Before you start, read `AGENTS.md` and everything in `docs/decisions/rejected/`. Do not recommend
anything that has already been rejected unless you explain what has changed since.

## The incident (verified on 23 October 2026)

Treat these facts as established. Re-read the sources if you need detail, but do not re-litigate
the diagnosis.

- At 23:30 on 23 October, eight `yes > /dev/null` processes were each using about 72% of a core on
  James's Mac (18 cores; the load average was about 35). They had been running for about 10 hours,
  their parent process was launchd (PID 1), and they had PIDs 7002 to 7005 and 8105 to 8108. They
  were killed by hand at 23:41.
- **Source:** OpenCode session `ses_e974fdb5fffeVC3mGjt9k30GTa` (model `mimo-v2.6-pro`, OpenCode
  run `5c79f5b9`), working in the AIO plan-queue worktree
  `.worktrees/queue/2026-07-19-livetest-failure-re-ffb4df`. It was checking whether
  `src/worker-agent/provider-runtime-diagnostics.spec.ts` was flaky when the CPU was busy.
- **Evidence:** the `part` table in `~/.local/share/opencode/opencode.db` (open it read-only; the
  file is 39 GB, so filter by `time_created` and `session_id`), and the permission lines in
  `~/.local/share/opencode/log/opencode.log`.
- **12:39 UTC:** it ran `for i in 1 2 3; do yes > /dev/null & … LOAD=$!; npm run test:quiet …;
  kill %1 %2 %3 %4; wait; done`. The `wait` hung, and OpenCode's shell tool killed the command at
  its 300-second timeout. That first batch did not survive.
- **12:44 UTC:** it ran `pkill -f '^yes$'; pgrep -fl '^yes$'`, saw no output, and reported "cleanup
  done".
- **12:45 UTC:** it ran:

  ```
  for j in 1 2 3 4; do yes > /dev/null 2>&1 & PIDS="$PIDS $!"; done
  npm run test:quiet …
  for p in $PIDS; do kill $p 2>/dev/null; done
  ```

  It did this twice and reported "stress done". **These are the eight survivors.** The test logs it
  wrote were `_scratch/test-run.pid-7032.log` and `pid-8172.log`, which sit just after the
  surviving PIDs.
- **Why the kill did nothing:** OpenCode's shell is `/bin/zsh`, and unquoted `$PIDS` does not split
  into words in zsh. So `kill` received one string, `" 7002 7003 7004 7005"`, failed, and the
  `2>/dev/null` hid the error. This was reproduced locally (zsh prints `[ 11 12]`, bash prints `[11]`
  then `[12]`).
- **Why nothing else caught them:** the command exited normally, so no timeout or process-group kill
  fired. The orphans moved to launchd, and nothing in OpenCode or AIO ever reaped them afterwards.

## Questions to answer

### A. Why AIO does not clean up (trace the code; do not infer from names)

1. How AIO starts each provider and its tool shells: which process group, session, and environment
   they get. Start with `src/main/cli/adapters/base-cli-process-utils.ts` (it already has
   `process.kill(-pid, …)`), `acp-cli-adapter.ts`, `opencode-cli-launch.ts`,
   `opencode-process-gate.ts`, the Codex app-server process utilities,
   `src/main/plan-queue/plan-queue-process.ts`, and the loop orchestration files
   (`loop-wait-on-pid.ts`, `loop-spawn-verify.ts`).
2. What happens to the descendants when an agent command finishes, when a session ends or is
   stopped, when a plan-queue item completes, and when AIO itself quits or crashes. For each case,
   give the file and line that runs, or state that nothing runs.
3. Whether a process that has escaped to launchd (the double-fork or orphan case) can still be
   linked back to the AIO session that started it. Check for environment markers, process-group or
   session IDs, and the worktree path as its current directory.
4. Whether the existing bash-validation layer (`src/main/security/bash-validation/`) sees commands
   from all providers, or only some of them. Could it flag patterns like this one?
5. Any other leftovers of the same kind: dev servers, watchers, `tail -f`, headless browsers, and
   `sleep` loops. Check the plan-queue and loop paths in particular.

### B. Research how to prevent it (cite your sources)

Cover at least the following, and give the macOS and Windows worker story for each, because AIO
also runs on `windows-pc`.

- Process-group and session containment (`setsid`, `detached`, killing the whole group), and its
  limits once processes daemonise or start their own groups.
- Tracking descendants on macOS without cgroups. Consider an environment-variable tag read with
  `sysctl KERN_PROCARGS2`, a process-tree snapshot taken before and after each command, `proc_listchildpids`,
  `launchd` per-session jobs, and `kqueue` `NOTE_EXIT`/`NOTE_FORK` tracking.
- Windows Job Objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- Resource guardrails: CPU time limits (`ulimit -t`), `taskpolicy` or background QoS on macOS, and
  nice levels.
- A watchdog: periodically find processes that started from an AIO session, have outlived it, and
  are burning CPU. Then kill them or alert James.
- How Claude Code, Codex CLI, OpenCode, and other agent harnesses handle background processes from
  tool calls. Do they track them, reap them, or warn? Check their documentation, source, and issue
  trackers.
- Guardrails in agent instructions: rules against CPU stress on the Mac, a requirement to verify
  clean-up by PID, and writing scripts for the shell that is actually in use. These are cheap but
  weak on their own. Say how much weight they deserve.

Rank the options by how reliably each one would have caught this incident, how much work each
takes, and the risk of killing something James wanted kept, such as a dev server he started on
purpose.

## Deliverables

1. A findings report covering section A, with `file:line` references, and the ranked options from
   section B, with sources.
2. A proposed spec for the recommended fix, written as an **untracked** file in `docs/plans/`. Use
   that folder's existing naming convention, ending in `_spec.md`. Do not stage or commit it. Tell
   James the exact path, and show `git status --short` listing it as `??`.
3. A review artifact for James, made with the `doc-review-artifact` skill into `.aio-review/`, which
   is never committed. Number the decisions he needs to make.
4. A short, plain-English summary for James: what went wrong, what you recommend, and what he needs
   to decide.

## Rules for this session (from James's global instructions; pass them on to any subagent you start)

- **Do not run CPU stress, load generators, or long-running background processes on the Mac** to
  reproduce this. If you need a live check, use a trivial, short-lived process such as `sleep 30`,
  give it a hard time limit, and confirm by PID that it is gone afterwards.
- No browser or desktop app on the Mac. Browser work goes to the Windows worker `windows-pc` through
  the AIO Browser Gateway. If it is unavailable, report that and skip the browser step. Web search
  and plain fetches are fine.
- Do not create branches or worktrees. Do not touch or clean up existing `.worktrees/*` checkouts;
  AIO owns them.
- Open the OpenCode database and the logs read-only. Never print credentials or tokens from
  `auth.json` or any other file.
- Label every claim as either verified (you read the code path that runs, or you ran it) or
  inferred. "No code does X" needs the same proof as "code does X".
