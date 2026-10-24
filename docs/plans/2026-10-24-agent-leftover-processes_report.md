# Why AIO agents leave programs running — findings report

**Written:** 2026-10-24. **Prompt:** `prompts/agent-process-cleanup_prompt.md`.
**Proposed fix:** [2026-10-24-agent-leftover-processes_spec_completed.md](2026-10-24-agent-leftover-processes_spec_completed.md).
No product code was changed. The probes used only short `sleep` processes (plus one 0.5 s `yes`
that was killed and confirmed gone). Each was confirmed gone by PID afterwards. The OpenCode database
was opened read-only.

Labels: **V** = verified (read the running code path including its non-test caller, or ran it);
**I** = inferred.

## Summary

- Every AIO session-level kill targets the provider CLI's own process group. Claude Code and OpenCode
  start each shell command in a new session, and Codex puts each child in its own process group, so
  those kills never reach programs an agent's command started (V, live process tables below).
- When a command exits normally, AIO runs nothing (V). OpenCode only kills a command's group when the
  command fails. The incident command ended with `echo "stress done"` and exited 0 (V, OpenCode database).
- AIO already has an on-demand leftover finder, but no automatic one. It relies on an environment tag
  that macOS hides for Apple binaries such as `yes` (V). It would have refused the incident's processes.
- The bash-validation layer sees only Claude's commands, and only outside auto-approve mode. It rates
  the incident command `safe` (V, ran it).
- AIO's own runners leak too: a plan-queue gate leftover with closed output survives (V, reproduced),
  and loop verify kills nothing after a normal exit (V).
- Right now, seven launchd-parented programs in work folders carry AIO's tag. Four belong to sessions
  that have already ended (V, census at 2026-10-24 00:10).

## Incident evidence (re-read 2026-10-24)

Source: OpenCode database, `part` table, session `ses_e974fdb5fffeVC3mGjt9k30GTa`, read-only.

| UTC | Command (abridged) | Exit | Outcome |
|---|---|---|---|
| 12:39:41 | `for i in 1 2 3; do yes … & … LOAD=$!; npm run test:quiet …; kill %1 %2 %3 %4; wait; done` | none | "shell tool terminated command after exceeding timeout 300000 ms". The group kill took that batch. |
| 12:44:56 | `pkill -f '^yes$'; …; pgrep -fl '^yes$'; echo "cleanup done"` | 0 | Nothing left to find. |
| 12:45:05 | `for i in 1 2; do PIDS=""; for j in 1 2 3 4; do yes > /dev/null 2>&1 & PIDS="$PIDS $!"; done; npm run test:quiet …; for p in $PIDS; do kill $p 2>/dev/null; done; done; echo "stress done"` | **0** | The eight survivors. Logs are `test-run.pid-7032.log` and `pid-8172.log`. |

The next tool call was at 12:46:15, so the shell that started the survivors lived about 70 s or less.

## A. Why AIO does not clean up

### A1. How providers and their tool shells are started

**AIO's side (V).**
- `BaseCliAdapter.spawnProcess` spawns the CLI with `detached = target.detached ?? !useShell`, which is
  true on macOS. That gives the CLI its own session and process group (`base-cli-adapter.ts:658-668`).
- On macOS it is wrapped by the signal fence (`sandbox-exec`, `sandbox/signal-fence.ts:28-36`), which
  execs into the CLI.
- The ACP adapter (OpenCode, Copilot, Cursor) uses the same path (`acp-cli-adapter.ts:581`).
- The spawn worker does the same (`cli-spawn-worker-main.ts:139-145`).
- The Codex app-server is spawned directly with `detached: !shell` and `unref()`
  (`codex/app-server-client.ts:426-437`).
- Plan-queue gates and hooks use `runInProcessGroup` (`plan-queue/plan-queue-process.ts:39-45`, detached
  on POSIX).

**Environment (V).** `spawn-config-builder.ts:244-274` adds `AIO_MCP`, `AI_ORCHESTRATOR_INSTANCE_ID`,
the socket and a capability token to each local CLI's environment. Child shells inherit it.

**What the CLIs do with tool shells.** V, from a live process table on 2026-10-24 using `libproc` and
`getpgid`/`getsid`:

| CLI | CLI process | Tool command / child | Reached by AIO's group kill? |
|---|---|---|---|
| Claude Code 2.1.309 | pid=pgid=sid 41319 | Bash tool `zsh` pid=pgid=**sid** 44227 (new session) | No |
| OpenCode | pid=pgid=sid 12293; MCP servers share pgid 12293 | `sleep 1500` pid=pgid=**sid** 29511 (new session) | No (MCP servers yes) |
| Codex app-server | pid=pgid=sid 23613 | Every child (MCP servers, exec) has its **own pgid**, same sid 23613 | No |

The research report (section B) confirms this from source. OpenCode's shell tool spawns with
`detached: true`, and Codex exec uses `setsid`/own group.

### A2. What happens to descendants

| Event | What runs | Reaches tool-command descendants? |
|---|---|---|
| Agent command exits normally | Nothing in AIO (V: every kill site in 55 non-spec files is a terminate, abort, timeout, interrupt or cancel path). OpenCode 1.19.4 kills the group only on a non-zero exit, with SIGTERM (research report §B6). | No |
| Interrupt | Claude resident: `control_request` (`claude-cli-adapter.ts:370-404`). ACP: `session/cancel` (`acp-cli-adapter.ts:1039-1045`). Codex app-server: `turn/interrupt`. Exec adapters: SIGINT to the CLI group (`base-cli-adapter.ts:390-397`). | No |
| Session stop / close / hibernate / idle kill / memory reclaim / respawn / runtime swap | All funnel to `instance-termination.ts:234` → `adapter.terminate()`. That runs `killProcessGroup(pid,'SIGTERM')`, then SIGKILL after 5 s only if the leader has not exited (`base-cli-adapter.ts:353-383`; `killProcessGroup` = `process.kill(-pid)`, `base-cli-process-utils.ts:30-43`). Gemini and Copilot null `this.process` on close, so a later terminate is a no-op (`gemini-cli-adapter.ts:334-337`). | No: the CLI group only |
| Plan-queue item lands / parks | Stops worker and verifier sessions (`plan-queue-item-landing.ts:126-127`; `plan-queue-item-flow.ts:580-581`). Then `removeWithProof` checks git state only, and force-removes the worktree (`plan-queue-worktree.ts:193-244`). No process check (the lsof helper `checkWorktreeProcesses` is used only by the leftover-worktree report). | No |
| Plan-queue gate/hook finishes | `runInProcessGroup` arms a 2 s group kill on exit, but `finish()` clears it when `close` fires first (`plan-queue-process.ts:58-66, 86-100`). **Reproduced**: `zsh -c 'sleep 20 > /dev/null 2>&1 & echo $!'` exits 0, and the `sleep` is still alive 3 s later. | Only if the leftover still holds the output pipe |
| Loop verify finishes | Spawned with no `detached` (`loop-spawn-verify.ts:54`). A normal `close` resolves and kills nothing (`:136-150`). On a timeout or cancel, `killProcessTree` walks `pgrep -P` from the still-running shell before killing it (`loop-spawn-verify.ts:97-105`; `loop-wait-on-pid.ts:140-172`). So it reaches live descendants, but not ones already orphaned. | Normal exit: no. Timeout: live descendants only |
| AIO quits normally | `before-quit` → `killActiveProcessesSync` (SIGTERM to tracked CLI groups) → `terminateAll` (SIGKILL to groups) → cleanup registry (includes running gate groups) → `killAllActiveProcessesGraceful`. The last is a no-op, because the set was already cleared (`index.ts:147-168, 366-402`; `harness-shutdown-operations.ts:46-95`; `base-cli-adapter.ts:162-226`). A tracked CLI is dropped from `activeProcesses` as soon as it exits (`:684-687`). | No |
| AIO receives SIGTERM / SIGINT / SIGHUP | The shutdown signal probe records the signal and re-raises it with the default action (`app/shutdown-forensics.ts:115-141`). `before-quit` does not run (I: Electron's own handling not confirmed). | No |
| AIO crashes / is force-quit | Nothing. The next launch has no process sweep: the startup steps only reconcile worktree pointers and delete Codex temp homes (`late-runtime-initialization-steps.ts:134, 296`). | No |

### A3. Can an escaped program be linked back to its session?

Probe (V): a non-interactive `zsh -c 'sleep 25 > /dev/null 2>&1 & echo $!'` in a temp folder exited 0.
The `sleep` then had `ppid 1`, `pgid = sid = <dead shell pid>`, and cwd = the temp folder. `killpg` of
the dead shell's pid still killed it.

| Link | Readable for Apple binaries (`yes`, `sleep`, `zsh`)? | Readable for third-party (node, java, postgres)? | Notes |
|---|---|---|---|
| Environment tag via `sysctl KERN_PROCARGS2` (same user) | **No.** It returns zero env entries. Tested on `/bin/sleep`, `/usr/bin/yes`, `/bin/zsh`. | Yes (node test: tag visible) | V |
| Environment tag via Harness's setuid `ps axeww` | **No.** The existing `list_host_processes` did not flag the two orphaned `zsh` shells or the orphaned Chrome, which do sit in AIO worktrees. | Yes (it flagged java, postgres, node, rtk, mysqld, Python) | V |
| Process group / session number | Yes, survives reparenting | Yes | V. Needs a record taken while the parent chain was alive. |
| Current folder (`proc_pidinfo PROC_PIDVNODEPATHINFO`) | Yes | Yes | V. Weak on its own: James's own programs can share a folder. |
| Seatbelt sandbox membership | Inherited, but no public query API | — | I |

### A4. Does bash-validation see every provider's commands?

No (V):
- The only runtime caller of the pipeline for agent commands is `ToolExecutionGate.evaluate`
  (`security/tool-execution-gate.ts:145-178`).
- That is reached only from `instance-permission-request-flow.ts:250`, for `deferred_permission`
  events. Those are emitted only by Claude's PreToolUse defer hook (`claude-cli-adapter.ts:1600`).
- The hook is installed only when not in auto-approve mode (`claude-cli-adapter.ts:1987-1990`;
  `claude-cli-argv-builder.ts:98-109`).
- ACP permission requests use `acp_permission_request` (`acp-cli-adapter.ts:1855`) and never reach the
  gate. Codex has no route to it.

Could it flag this pattern? The parser already records `backgrounded: true` per segment
(`command-parser.ts:52-53`), but no validator uses it, and `yes` is on the read-only list
(`intent-classifier.ts:8`). Running the incident command through `BashValidationPipeline.validate`
returned `risk: safe, intent: package_management` (V, ran it).

### A5. Other leftovers of the same kind

Census (V, `libproc` read-only, 2026-10-24 00:10). Same-user processes reparented to launchd whose
folder is under `~/work` or temp:

| Program | Age | Folder | AIO tag | Owning session live? |
|---|---|---|---|---|
| java (1.1 GB) | 14 h | one-more-floor plan-queue worktree | yes | **no** |
| postgres | 8 h | `/private/tmp/inbox-verifier-pg-*` | yes | **no** |
| node | 7 h | ai-orchestrator | yes | **no** |
| rtk | 22 h | myshellarts | yes | **no** |
| rtk, python (mcp-atlassian), mysqld | 2 h, 4 h, 8 min | work-finding worktree, binsout | yes | yes |
| zsh | 18 h | one-more-floor worktree `_scratch/lp-slice-…/server` | hidden | unknown |
| zsh | 21 h | undistilled plan-queue worktree | hidden | unknown |
| Chrome (+ crashpad) | 20 h | work-finding plan-queue worktree | hidden | unknown |

None was using much CPU at the time. They hold memory, ports and worktree folders.

Other AIO-side sources (V unless marked):
- **Browser Gateway Chrome** is launched by puppeteer with `detached` on POSIX
  (`@puppeteer/browsers/lib/launch.js:158`). It stops via its exit hooks or `closeAll` in the cleanup
  registry (`browser-process-launcher.ts:145, 264-278`), so it survives an AIO force-quit (I).
- **Codex app-server close** sends one group SIGTERM after a 3 s grace, with no SIGKILL
  (`app-server-client.ts:473-495`). The app-server's children are in other groups (A1).
- **Deliberate detached spawns** (terminal launchers, external editor, Ollama relaunch on Windows)
  are meant to outlive AIO and are out of scope.
- **Windows worker:** no Job Objects anywhere (repo-wide search). `taskkill /T` is skipped when the root
  has already exited (`worker-node-executor.ts:488-521`). Descendants whose parent has exited are not
  reachable through the tree.

### Earlier, related incident

On 20 October 2026, an implementer started 54 `while :; do :; done` loops and "cleaned up" with
`kill $PIDS` under zsh. Load sat at about 135 until the parent agent noticed. This is from agent
memory; I did not re-verify it from logs.

## B. Research: how to prevent it

Sources are XNU (`apple-oss-distributions/xnu`, main, Oct 2025), libuv `19bbf90e`, provider source at
the SHAs listed in B6, Microsoft Learn, and local man pages and short `sleep` tests on this Mac (macOS
27, zsh 5.9).

### B1. Process groups and sessions

How it works:
- A non-interactive `zsh -c` or `bash -c` keeps `&`, `nohup … &` and `& disown` jobs in the shell's own
  group and session (V, tested). zsh's `-o monitor` with no terminal does not change that (V).
- Only an explicit `setsid`, or `bash -c 'set -m; …'`, moves a job into a new group (V).
- Node's `detached: true` makes the child "the leader of a new process group and session" on POSIX
  (https://nodejs.org/api/child_process.html). That is why AIO's CLIs and OpenCode's tool shells each
  get their own session.
- macOS has no subreaper and no parent-death signal: orphans always go to launchd (`kern_exit.c` 2444,
  2473, `proc_reparentlocked(q, initproc, …)`) (V).
- `getpgid` and `getsid` work on any process without a permission check (`kern_prot.c` 217-273) (V).

What it would have done:
- A `killpg(<tool shell pid>)` after the shell exited, even with exit 0, kills the orphan (V, tested).
  So "kill the tool command's group after every command" would have stopped the incident.
- That kill lives inside each provider's shell tool, not in AIO, which never sees the tool shell's pid.

Limits:
- `setsid`, a daemoniser, or Node `detached` escapes the group.
- Group numbers can be reused once a group is empty (I).

Windows: there are no process groups in this sense. See B3.

### B2. Tracking descendants on macOS without cgroups

| Technique | What it does | Would it have found the incident's `yes`? |
|---|---|---|
| Environment tag via `sysctl KERN_PROCARGS2` / `ps eww` | XNU returns another process's environment only if the target is not `cs_restricted`, SIP is off, the build is a debug build, or the caller holds a private entitlement (`kern_sysctl.c` 1387-1403; `cs_restricted` = `CS_RESTRICT`, `kern_cs.c` 1739). Apple platform binaries are restricted. | **No.** Verified: empty env for `/bin/sleep`, `/usr/bin/yes`, `/bin/zsh`, and Chrome. Visible for nvm `node`, java, postgres, mysqld, rtk. |
| Parent-chain walk (`proc_listchildpids`, `pgrep -P`, npm `ps-tree` / `pidtree` / `tree-kill`) | Lists children by parent pid | **No.** Blind once the shell has exited and the orphan has moved to launchd (V). |
| Group listing (`proc_listpgrppids`) or a full scan matching `pgid`/`sid` | Lists group members regardless of parent | **Yes**, if the group number was recorded while the shell lived (V). This is the spec's "lineage". |
| Before/after snapshot (`proc_listallpids` plus start times) | New orphans whose start time falls inside a command window | **Yes**, with some risk of false positives from concurrent sessions in the same folder (I). |
| Current folder (`proc_pidinfo PROC_PIDVNODEPATHINFO`) | Where the program is running | Yes for Apple binaries (V), but weak: James's own programs share folders. |
| launchd per-session jobs | "When a job dies, launchd kills any remaining processes with the same process group ID" unless `AbandonProcessGroup` (`man launchd.plist`). `launchctl submit` keeps the job alive. | **No.** It is group-based, and tool shells `setsid` into new groups. |
| kqueue `EVFILT_PROC` | `NOTE_TRACK` / `NOTE_CHILD` are "no longer supported as of 10.5" (`ENOTSUP`, `kern_event.c` about 1105). `NOTE_FORK` does not report the child pid (`event.h` 255-262). | **No** practical route. `NOTE_EXIT` is fine for pids already known. |

### B3. Windows Job Objects

Microsoft documentation (Job Objects, JOBOBJECT_BASIC_LIMIT_INFORMATION, Nested Jobs):
- Children join their parent's job by default.
- `KILL_ON_JOB_CLOSE` terminates every process in the job, including nested jobs, when the last handle
  closes.
- `BREAKAWAY_OK` lets `CREATE_BREAKAWAY_FROM_JOB` children leave. `SILENT_BREAKAWAY_OK` makes every
  child leave.
- Nested jobs exist since Windows 8.
- Processes created through WMI `Win32_Process.Create` are not placed in the job, which is an escape
  route.

libuv, which Node uses (`src/win/process.c` 69-111, 1117-1166):
- It puts non-detached children in one global job with `BREAKAWAY_OK | SILENT_BREAKAWAY_OK |
  KILL_ON_JOB_CLOSE`. So only direct children die when Node exits; grandchildren silently break away by
  design.
- `UV_PROCESS_DETACHED` uses no job at all.
- An access-denied error when assigning to the job is swallowed.

AIO today: no Job Objects anywhere (repo-wide search). `taskkill /T` follows parent links that Windows
never updates after the parent dies, and it is skipped when the root has already exited
(`worker-node-executor.ts:488-521`).

What it would take: a job per CLI (or per command) with no breakaway, kill-on-close, and creation
suspended before assignment. Node needs a native addon or a helper exe for this. The job's process list
and its I/O completion port also give exact attribution.

### B4. Resource guardrails

| Guardrail | macOS behaviour | Windows equivalent | Verdict for the incident |
|---|---|---|---|
| `ulimit -t` (RLIMIT_CPU) | Per process, and a fresh budget at every fork (`kern_fork.c` 1118-1120). The soft limit sends one `SIGXCPU`; there is no SIGKILL at the hard limit, unlike Linux (`kern_resource.c` 1469-1497). The default action terminates. | Job `PROCESS_TIME` / `JOB_TIME` limits (user time only) | Each `yes` would have died after its CPU budget. It would also kill long test runs, builds and the CLI itself. Too blunt for agents. |
| `taskpolicy -b` / `PRIO_DARWIN_BG` | Inherited by children (`task_policy.c` 738-746). It can be applied from outside to a same-user pid with `taskpolicy -b -p <pid>`; verified, though the man page says otherwise. Read it back with `proc_pidinfo` flags, not `getpriority`. | Job `CPU_RATE_CONTROL` hard cap (Windows 8+), `LIMIT_PRIORITY_CLASS` | It throttles rather than stops. It is a good gentler first action for a sweeper on one runaway pid. Applied to whole sessions it slows every build and test. |
| `nice` | Priority only | Priority class | Softens; does not stop. |
| Kernel CPU-usage monitor (`RLIMIT_CPU_USAGE_MONITOR`) | Private, for diagnostics | — | Not recommended. |

### B5. Watchdog

The strongest per-command pattern is in each provider's shell tool: start the command as a group
leader, and after every exit list `proc_listpgrppids(leader)`, then report and stop what is left. That
needs upstream changes.

What AIO can do on its own:
- Record each session's groups while they exist.
- Sweep periodically for orphans in recorded groups (or carrying the tag).
- Measure CPU from cumulative CPU-time deltas.
- Throttle, warn, or stop according to policy.
- Repeat the sweep at startup to cover crashes.

The existing on-demand tool (`host-process-inspector.ts`) already has the stop rules and the safety
model. It lacks lineage, CPU deltas and a timer.

### B6. How other agent harnesses handle it

Read from source at these SHAs: OpenCode v1.19.4 `148842ef`, Codex `970111f6`, Gemini CLI `cd1b45c2`,
Goose `c3bfc5f7`, Aider `5dc9490`, OpenHands software-agent-sdk `acd96e6f`. Claude Code and Copilot are
from their docs and changelogs.

| Harness | Tool command group | Timeout / abort | Leftover `&` child after a normal exit | Reaps at session end |
|---|---|---|---|---|
| OpenCode 1.19.4 | `detached` (own session), `tool/shell.ts:299-309` | Group SIGTERM, then SIGKILL after 3 s (`cross-spawn-spawner.ts:292-312`) | Group SIGTERM **only on non-zero exit**; exit 0 leaves it alone (`cross-spawn-spawner.ts:376-405`). Explains the incident. | Only via scope finalisers |
| Codex | `setsid` / own group (`pty.rs:662`, `spawn.rs` pre_exec) | Group SIGKILL (`exec.rs:1034-1078`, `process_group.rs:92-115`) | Unified exec: group SIGKILL when the process entry is dropped (I, timing not traced). Legacy exec: left alone. | Yes, `terminate_all_processes` (`session/handlers.rs:313-317`) |
| Claude Code | Not documented | Moves to background on timeout | Not documented. Issue **#96625** reports the same orphaned `cmd &` CPU loops on macOS. | Docs: background tasks "are automatically cleaned up when Claude Code exits", including setsid'd ones (2.1.257) |
| Gemini CLI | `bash -c` (not the user's shell), own group | Group kill plus a `pgrep -P` walk | Left alone, but leftover PIDs are reported to the model via a `jobs -p` exit trap (`tools/shell.ts:133-150, 975-978`) | Tracked background shells only |
| Copilot CLI | Unknown | Whole tree since 1.0.57 | Unknown | Not stated |
| Goose | `process_group(0)` | Group SIGKILL | Deliberately left alive (`shell_process.rs:27`) | — |
| Aider, OpenHands | No group / persistent tmux shell | None / soft timeout | Left alone / held by the shell | OpenHands: at sandbox teardown |

Relevant issues: Claude Code #96625, #92399, #84625; Codex #41009, #15379, #41841; OpenCode #38564,
#30868; Copilot #1790, #4719; Gemini #20941. None of these harnesses has a general sweep for programs
that outlived their command, or a CPU watchdog.

### B7. Agent instructions

- Anthropic: CLAUDE.md is "context, not enforced configuration. To block an action regardless of what
  Claude decides, use a PreToolUse hook" (https://code.claude.com/docs/en/memory). Hooks give
  "deterministic control" (https://code.claude.com/docs/en/hooks-guide).
- IFScale (arXiv 2507.11538): the best frontier models reach 68% accuracy with 500 simultaneous
  instructions. AgentIF (arXiv 2505.16944): agents "generally perform poorly" on tool constraints.
  Abstracts only.
- Locally: the 20 October lesson was stored in Claude's memory, which OpenCode never reads (I). Its
  suggested `pkill -P <shellpid>` also cannot find orphans once the shell has exited (V).
- Weight: low on its own. It is worth shipping as the shared every-agent guidance block (which does
  reach every provider, unlike memory), but only alongside enforcement.

### B8. Ranking

"Catches" means: would it have stopped the 23 October incident?

| # | Option | Catches? | Work | Risk of stopping something James wanted |
|---|---|---|---|---|
| 1 | **AIO sweeper with lineage plus a CPU rule** (spec) | **Yes**, in about 10-15 min, on every provider, including Apple binaries and exit 0 | Medium: two new main-process modules, settings, notice, tests | Low: orphan-only, attributed-only, CPU-gated; idle leftovers notify by default |
| 2 | Upstream: provider shell tools kill the command's group after every exit (OpenCode) | Yes, immediately | Not ours; OpenCode's maintainers decide | Medium: deliberate `&` servers die unless they use the provider's background feature |
| 3 | Make the existing tag-based finder automatic | **No**: the tag is hidden on `yes` | Small | Low |
| 4 | `ulimit -t` on agent sessions | Eventually, per process | Small | High: kills long builds, tests and the CLI |
| 5 | Background QoS for whole sessions | No: it only softens | Small | None, but it slows all agent work |
| 6 | Fix AIO's own runners (plan queue, loop verify, terminate SIGKILL) | No: a different path | Small | Low |
| 7 | Extend bash-validation | No: OpenCode commands never reach it | Small to medium | Medium: false alarms on legitimate `&` |
| 8 | Agent guidance block | Maybe; unreliable | Trivial | None |
| 9 | launchd jobs, kqueue tracking | No (group-based / unsupported) | Medium | — |
| 10 | Windows Job Objects (phase 2) | Not applicable to the Mac; strongest on Windows for session end | Medium to high (native helper) | Low |

**Recommendation: 1, with 6 and 8 alongside, 10 as a later phase, and 2 offered upstream if James agrees.**
