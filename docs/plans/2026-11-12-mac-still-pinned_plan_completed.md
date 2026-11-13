# Fill the PC and test Mac, keep this Mac as a backup

## Status

- **Done (12–13 Nov):** Parts A and C built. Seven independent review rounds ran; rounds 1 to 6 each found something, all
  fixed (the last fixes are in [the follow-up](2026-11-12-mac-still-pinned-followup_plan_completed.md)); round 7 passed.
  Switch off: test runs, commit-hook tests and `checks.js` go to the PC or test Mac, wait (20 min; commit hook 3 then
  commits; loop verify at most a quarter of its timeout; after-merge check 5) and otherwise exit 69 "Not run"; queue and
  loops hold, retry every 5 min. A confirmed far run with no tests is its result; named runs go as plain `vitest run <args>`;
  `-u`/`--coverage` stay here; Mac-only specs a run reaches run here.
- **Next:** [livetest doc](2026-11-12-mac-still-pinned_livetest.md) after James restarts on the new build; then the switch goes off.
- **Open:** one-spec far runs took 76–83 s on an idle PC, not under a minute: each rebuilds `dist` (~30 s). Kept as is until
  LT-A2b has measured a real day. A loop's 2-min quick verify has little room with the switch off.
- **Moved out:** Part B and Undistilled: [part B plan](2026-11-12-mac-still-pinned-part-b_plan.md). By design: no `smallSlots`
  on the Computers page (4 PC, 2 test Mac); the queue's after-merge type checks and other projects' checks still run here.

## The short answer

Yes, and about half of it builds on what already works.

- **Part A, test runs (weeks, not months).** Today only full runs go to the PC and test Mac. Small runs, work-finding's other suites
  and Undistilled stay here, because each is shorter than the far machine's set-up time. That was right when this Mac was idle; on
  12 November small runs took 8 to 22 minutes here because it wasn't. With this Mac switched off, every test run goes to the PC or
  test Mac, and waits for a free slot there instead of coming back.
- **Part B, whole unattended sessions (a bigger build).** Queue jobs, loops and automations then run their agent on the PC or test
  Mac, so the commands they run (`git`, `find`, builds) go too. Automations can already be pinned to a computer. Queue jobs and loops
  can't yet, because nothing moves their code checkout to another machine and brings the commits back.
- **The switch.** One switch on the Computers page: "Use this Mac when the others are busy or away". Off: the work waits and Harness
  says it's waiting for the PC or test Mac. On: this Mac takes over, as it does today. A few tests that only this Mac can run stay
  here either way.

Workload stays on 5 (Decision 1), so the relief comes from Part A itself.

Your own chats stay on this Mac unless you send one elsewhere, and so does Harness itself.

## What the two machines can take

Measured on 12 November at about 16:12 UTC (one `ssh` read each, plus Harness's computer list).

| | This Mac | Windows PC | Test Mac |
|---|---|---|---|
| Processor | M5 Max, 18 cores | Ryzen 9 9950X3D, 16 cores, 32 threads | M1 Max, 10 cores |
| Memory | 128 GB | 190 GB | 64 GB |
| Load now (1 / 5 / 15 min) | 33–50 earlier this afternoon | 0.0 / 1.7 / 5.0 (its Linux side) | 2.2 / 3.6 / 8.7 |
| Agent sessions now | about 22 | 0 of 10 | 0 of 10 |
| AI tools signed in | all | Claude, Codex, Copilot, Cursor, OpenCode, Antigravity | Claude, Copilot |
| Also does | your work | browser, Android emulator, test runs (in its Linux) | browser, iOS builds, test runs |

Between them the PC and test Mac have more than twice this Mac's threads. But the PC is fuller than its idle load suggests when it's
busy: three full runs of this project at once took it to a load of 41 (offload plan, Stage 5, "Load"). It has spare time rather than
spare width: on 12 November it ran 61 full runs, about 4 an hour, against the 19 an hour it managed in testing.

Running queue runs (read-only from Harness's queue database): 4 use Claude and 6 use Codex for their workers. Codex isn't signed in on
the test Mac (Decision 3).

## What I found on this Mac

### Measurements, 12 November 2026, about 15:25–15:45 UTC

`ps` and `top` are blocked in a session, so all of this comes from Harness's own process list (`list_host_processes`). Its CPU figure is a
short decaying average, and it lists at most 100 programs, so short-lived processes are undercounted. The visible programs added up to
1,100–1,400% of the 1,800% the Mac has.

| | Snapshot 1 | Snapshot 3 |
|---|---|---|
| Load average (1 / 5 / 15 min) | 40.8 / 46.1 / 49.9 | 32.7 / 41.6 / 47.7 |
| Processes | 1,575 | 1,489 |
| Test runs | 951% (68% of what I could see) | 644% (58%) |
| Harness (main process and its helper) | 122% (9%) | 71% (6%) |
| macOS (Spotlight, WindowServer and others) | 150% | 176% |
| Your own apps (Discord, Outlook, VS Code, Chrome, EVE) | 84% | 83% |
| Commands agents ran (`find`, `git` and so on) | 100% | 68% |
| Chat helpers (MCP servers and their `npm` launchers) | about 0% | 47% (4%) |
| The agent programs themselves | about 0% | 13% |
| Leftovers | 0% | 0% |

The last two snapshots (load 35) showed the same pattern: three test runs at once, all from unattended work.

| What was running | Where it came from | Routed? |
|---|---|---|
| Jest and Vitest suites in `apps/desk/web` and `apps/radar`, 8 or more test workers at 30–106% each | A work-finding Plan Queue job (`research-worker-p3-build-3b2b`) | No. Offload Stage 5 kept these suites on the Mac because each is under a minute |
| Playwright with 5 workers and 5 headless Chromes, about 1.2 GB and up to 96% each | An app-studio review in `_scratch/review-p5r41c/template/app` | No. app-studio has no hook to the offload |
| Vitest, 760 MB, workers coming and going for 9+ minutes | This project's Plan Queue job `2026-11-07-agent-issued-remote-688f24` | No. A run with named test files stays on the Mac |

### The test-run log (`~/.ai-orchestrator/remote-checks/runs.jsonl`)

| | 11 November | 12 November (to 15:45) |
|---|---|---|
| All runs | 482 | 370 |
| Full runs on the PC | 68 (527 min) | 61 (475 min) |
| Full runs on the test Mac | 10 | 11 |
| Full runs on the Mac | 0 | 3 (43 min) |
| Runs that fell back to the Mac | 0 | 5 |
| Small runs on the Mac (named files) | 251 (185 min) | 155 (133 min) |

149 of 12 November's 155 small runs named 0 to 9 test files, but some took 8 to 22 minutes because the Mac was already loaded. The five
fallbacks were: a failed snapshot; no free slot on either machine (06:46); a dropped connection (08:45); a run with
`AIO_REMOTE_CHECKS=off`; and at 15:14 "the Windows PC sent back no usable report; the test Mac sent back no usable report", which then
ran on the Mac for 27 minutes and failed. That last one was the 688f24 queue job, four minutes after the same job's full run passed on the PC.

The log only covers runs that go through the offload's runner. Other projects' runs that stay on the Mac, Playwright, `npx vitest` and
`ng test` aren't in it at all.

### The seven ideas in the prompt

| Idea | Verdict | Evidence |
|---|---|---|
| a. Every chat starts all its helpers up front | **True, but small for CPU.** | 7 or 8 `aio-mcp` processes per Copilot chat (about 93 MB each), each Harness helper its own process (`spawn-config-builder.ts:115-208`). Codex chats also start every server in `~/.codex/config.toml`. 206 helper processes, about 5.5 GB, 0% CPU once running |
| b. Nothing limits how many start at once | **Partly true.** | Limits on chats per provider and 24 in total, but nothing staggers helper start-up and nothing limits test runs here except the lock for full runs |
| c. Leftovers add up | **True for memory, not CPU.** | 39 programs with no parent, all at 0%. See Leftovers below |
| d. Harness is busy while idle | **True at times, cause unknown.** | Main process at 102%, 13% and 10% in three snapshots. Nothing records its own CPU (Part C) |
| e. Automations, loops and the queue all run here | **True, and the main cause.** | None of them picks another computer except automations pinned to one; at workload 5 the queue's limits are raised, not lowered |
| f. The offload doesn't work as claimed | **False for what it covers.** | Full runs went to the PC and test Mac as designed. What it leaves here is now the bulk |
| g. The test Mac being offline pushes work back | **Yes, when the PC is also busy.** | Only the last machine in the order waits for a slot (`run-remote.js:257,284-288`), so a busy PC plus an unreachable test Mac sends the run straight back here |

### The workload setting

`workloadLevel` is 5; the default is 3. `limitsFor` (`src/main/work-admission/workload-policy.ts`) only adds limits at levels 1 and 2.
At 4 and 5 it raises minimums instead: every queue run gets at least `level` worker slots and `level - 1` check slots, and the
queue's load ceiling becomes 2.5 or 3 times the number of cores. With 18 cores that's 54 at level 5, against each run's own default of 30
(`plan-queue.schemas.ts:663`). The queue pump only stops starting jobs when the 1- or 5-minute load is above that ceiling
(`plan-queue-pump.ts:119`). On 12 November the load sat between 32 and 50, so at level 5 the queue never held back; at level 3 it
would have held most of the afternoon.

I checked the saved settings of the queue runs that were active (read-only, `loop-mode.db`, table `plan_queue_runs`). There were 10:
4 in work-finding, 4 in this project and 2 in the communitytech folder. Every one has a saved load ceiling of 30. Their own job slots add
up to 15 (two runs have 3, one has 2, the rest 1, including the two live-test runs at 1 job and 1 check). At level 5 each is raised to at
least 5 jobs and 4 checks with a ceiling of 54, so together they may start up to 50 jobs. The queue's own history shows how many jobs
were actually working, fixing, checking or landing at once on 12 November: up to 8–11 every hour from 01:00 to 09:00 UTC and again
10–11 from 14:00, with a quiet 2 from 11:00 to 13:00.

## Decisions for James

1. **Workload from 5 to 3 now, while this is built?** **Answer: no, stays on 5.** (Was recommended.) Settings, Orchestration, no restart. Running work carries on; the
   queue starts fewer jobs at once and waits while this Mac is busy. It stops mattering for jobs that move in Part B.
2. **Send your own chats' test runs away too, not only unattended ones?** **Answer: yes.** So Step A6 isn't needed. A one-file run costs a few seconds more on the
   PC than here on an idle Mac, but this Mac is rarely idle, and it keeps the rule simple: with the switch off, no tests run here except the few only this Mac can run and tests started outside a runner (app-studio's Playwright,
   a direct `npx vitest`; see A5); other projects' type checks and builds follow later. If no,
   Part A needs the "unattended" markers described in Step A6.
3. **Sign Codex in on the test Mac?** **Answer: yes, James will do it.** 6 of the 10 running queue runs use Codex, so without it those jobs can only use the
   PC. You'd do the sign-in there yourself; logins are never copied between machines.
4. **Go ahead with Part B?** **Answer: yes,** after Part A has run for a few days. It's the larger build, it's the "whole sessions" item
   the offload plan held back, and on the PC it needs a Linux worker that has never been run for real.

## How it will work

1. **The switch.** "Use this Mac when the others are busy or away" on the Computers page, beside the pauses that are already there. It's
   saved in `~/.ai-orchestrator/remote-checks/config.json`, which the Computers page already writes (`src/main/computers/test-machine-file.ts`),
   so test runners read it even with Harness closed. It starts on (today's behaviour) so nothing changes the moment it's built; you
   turn it off once Part A has shipped, and the page and the scripts read the same default.
2. **Test runs, switch off.** Every test run goes to the PC or test Mac, small or full, in this project and each project wired to the
   offload. If both are full, it waits for whichever frees first. If both are away, it waits a while, then stops with a plain message
   ("not run: the PC and test Mac are busy or away, and this Mac is switched off") and an exit code that means "not run", never "failed".
3. **Sessions, switch off (Part B).** Queue jobs, loops and automations start on whichever of the PC and test Mac has the tool signed
   in, a free agent slot and the most idle processor; Harness's computer choice already scores free slots and idle processor
   (`worker-node-registry.ts:139-200`). When neither can take one, the job waits in the queue and says why.
4. **Switch on.** Today's behaviour: the PC and test Mac first, this Mac when they're busy or away.
5. **Browser, Android and iOS work** keep their own routing and are never queued behind tests (see "What must stay true").

## Part A — Every test run goes to the PC or test Mac

### Step A1 — The switch

- **Change:** add the switch to the Computers page (`computers-list.model.ts` and its component) and the file
  (`test-machine-file.ts`, a top-level field such as `useThisMac`). `route.js` reads it with the rest of the file.
- **How to prove it:** `test-machine-file.spec.ts` (written, read back, other fields kept), the Computers page spec, and a route test
  for each setting.
- **What must stay true:** a missing field means on (today's behaviour) for both the page and the scripts, so older copies of the
  scripts and a fresh install don't change, and the page never shows a setting the scripts aren't following.

### Step A2 — Small and named-file runs go too

- **Change:** in `scripts/remote-checks/route.js`, `decideRoute` sends every run `remote` (with `specs` for a named list) when the switch
  is off. Today any run that isn't a full run or a long list stays here (`route.js:111-115`). `run-tests-quiet.js` already sends named
  lists for long targeted runs, so this widens a path that exists.
- **Change:** small runs get their own slots on each machine (`remote-run.sh`, beside `SLOT_COUNT=3`), so a one-file run doesn't wait
  minutes behind three full runs. Start with 4 small-run slots on the PC and 2 on the test Mac, and adjust from the run log.
- **Rule for pauses and the override:** with the switch off, pausing both machines (or turning their test runs off) on the Computers
  page, or setting `AIO_REMOTE_CHECKS=off`, gives "not run" with the reason in the message, not a run here (`route.js:67-72,116-118`
  send it here today). Pausing is how you'd say "nothing anywhere"; flicking the switch on is how you'd say "use this Mac". The queue
  sets `AIO_REMOTE_CHECKS=off` itself for its comparison run on main when a job's failing check ran here
  (`plan-queue-gate-receipts.ts:47,214`); with the switch off that comparison runs on the far machine instead.
- **How to prove it:** `remote-checks.spec.ts` and `run-tests-quiet-remote.spec.ts` for the route, including paused and override cases, `remote-run.linux.spec.ts` for the
  slots. Then a day's `runs.jsonl`: small runs should mostly finish in under a minute, against 8 to 22 minutes here on 12 November.

### Step A3 — Wait instead of coming back

- **Change:** `scripts/remote-checks/run-remote.js` `runOnMachines`: with the switch off, keep trying the machines in turn until one
  has a slot, instead of asking only the last one to wait (`run-remote.js:257,284-288`). When the test Mac can't be reached, the PC
  becomes the one that waits. Every other result that isn't a usable report (set-up failed, connection lost, "no usable report",
  `run-remote.js:259-268`, the 15:14 case) is retried on the other machine and then counts towards the same limit; none of them
  runs here while the switch is off. Give up after a limit (20 minutes, the full-run lock's own limit) with the "not run" exit code.
- **Change:** this project's runner has its own fallback: when `runOnMachines` fails it calls `runFullSuiteOnMac`
  (`scripts/run-tests-quiet.js:356-363`). With the switch off it returns "not run" instead.
- **Change:** the Plan Queue treats "not run" from a check as "waiting for a test machine": the job holds and the check is tried again
  later, instead of the job being sent back to fix a failure (`plan-queue-gate-receipts.ts`, `plan-queue-landing.ts`).
- **Change:** a loop's verify step counts any non-zero exit as a failure (`src/main/orchestration/loop-spawn-verify.ts:157-163`), so a
  loop would start "fixing" tests that never ran. "Not run" instead pauses the loop and tries the check again later without using up a
  round.
- **How to prove it:** `run-tests-quiet-remote.spec.ts` cases for "both busy, waits, then runs", "test Mac unreachable, PC waits",
  "both away, gives up with not run", "both send back no usable report", a queue spec for "not run holds the job", and a loop spec
  for "not run doesn't use a round".
- **What must stay true:** with the switch on, nothing here changes. A real failure is never reported as "not run", and the reverse.

### Step A4 — Commit-hook tests and checks obey the switch too

- **Change:** two other entry points choose their own route and fall back here. `scripts/remote-checks/run-staged.js` (the commit hook)
  sends staged tests away only when they touch 50 or more spec files (`LARGE_RELATED_SPECS`, line 24) and runs them here after any
  far-machine failure or crash (lines 59-74, 117-123; `scripts/test-staged.js:142-144` also returns "run here"). With the switch off the hook sends
  every staged run away (see the next point). `scripts/remote-checks/checks.js` (type checks, lint and builds, which the Plan Queue reads through
  `--json`) has its own here-or-there route (`decideChecksRoute`, lines 57-64) and fallback (133-171). With the switch off, `checks.js`
  sends everything away and returns "not run" instead of running here, using the same waiting rule as A3. `harness-remote-check.js` (other
  projects' entry point) does the same instead of returning "stay here".
- **Commit hook and "not run":** `test-staged.js:85` hands any code other than 75 back to git, so "not run" would block every agent
  commit after a long wait, and agents would retry or skip the hook. Instead, with the switch off, the hook waits at most about 3 minutes,
  (for a free slot only, not the run itself), then lets the commit through with a clear "tests not run: no test machine free" line. The queue's and loop's own checks still run the
  tests before anything lands.
- **How to prove it:** cases in `remote-checks.spec.ts` (or the specs beside each script) for small commit, far failure, and checks with
  both machines away, each with the switch off and on.

### Step A5 — Other projects

- **Change:** named-file runs in other projects need three changes, because today the offload there only handles full runs: the
  runners' gate (`apps/desk/scripts/run-tests-quiet.mjs:130` calls the offload only with no extra arguments), `harness-remote-check.js`
  (line 40 always passes no arguments to `decideRoute`) and the per-project recipe in `remote-run.sh` (fixed arguments, lines 447-448).
  Each passes the file list through.
- **Change:** work-finding's other three suites go too: `scripts/remote-checks/projects.js` and the recipe in `remote-run.sh` learn
  `apps/desk/web`, `apps/radar` and `apps/runner` (today they only know `apps/desk`, `projects.js:30-33,80`), and each suite's runner
  calls `harness-remote-check.js` the way `apps/desk/scripts/run-tests-quiet.mjs:130-143` does, with the named-file change above: `apps/desk/web/scripts/run-jest-quiet.mjs`,
  `apps/radar/scripts/run-tests-quiet.cjs` and `apps/runner/scripts/run-tests-quiet.mjs`. The runner changes are made in that project.
- **Change:** Undistilled's tests go to the test Mac only, because they're built for macOS. Its recipe (`remote-run.sh:453`) and
  `projects.js` entry (lines 42-54) already exist; its runner doesn't call the offload because two browser tests fail in any fresh
  checkout (`projects.js:10-13`). Fixing those two tests, in that project, comes first.
  **Moved to the Part B plan** (that project had uncommitted work in the same test files on 12 November).
- **Stays here:** tests that need a real database (work-finding's `test:integration:postgres`), the 15 pixel-measuring layout tests, and
  the Mac-only checks (signing, Keychain, the sandbox fence), with the switch on or off. The switch only decides what runs here when
  the other machines can't.
- **Not covered:** other projects' type checks, lint and builds in the Plan Queue. `checks.js` only takes this project's fixed list
  (`BATCHED_CHECKS`, `plan-queue-gate-receipts.ts:48-55`), so work-finding's `tsc`, lint and builds still run here through the queue's
  own gate. Sending those away is a follow-on once Part A is proven; until then they're the main load left from work-finding jobs.
- **Not covered:** the queue's after-merge check (`postMergeGate`, by default `npx tsc --noEmit` and `npm run typecheck:spec`)
  runs its commands here directly, not through `checks.js`. A test run named there does go away and can be "not run".
- **Not covered:** app-studio's Playwright suite and anything an agent starts with `npx vitest`, `ng test` or `playwright test`
  directly, because those never reach a runner that knows about the offload. app-studio can call the same command from its own runner
  later; that's a change in that project.
- **How to prove it:** a real work-finding queue job: its four suites appear in `runs.jsonl` as remote, and `list_host_processes` here
  shows none of them.

### Step A6 — Not needed (Decision 2 was yes): mark unattended work

Your own runs would then stay here, so a run must know whether it's unattended. Queue sessions already carry `AIO_QUEUE_SESSION`
(`plan-queue-push-guard.ts:22,47`) and loops `ORCHESTRATOR_LOOP_CONTROL_FILE` (`route.js:85-87`). Add `AIO_QUEUE_CHECK=1` to
`QUEUE_TEST_ENV` (`plan-queue-process.ts:33`, used by the gate, landing and squash checks), `AIO_AUTOMATION_SESSION=1` for automation
sessions and their children in `instance-lifecycle.ts:834-838`, let both through Codex's shell filter (`codex-harness-shell-policy.ts:13-19`,
because your Codex settings use `inherit = "core"`), and add an `isUnattendedRun()` beside `isLoopRun()`, which stays as it is.

## Part B — Unattended sessions run on the PC or test Mac

Moved to [2026-11-12-mac-still-pinned-part-b_plan.md](2026-11-12-mac-still-pinned-part-b_plan.md) on 12 November 2026.

## Part C — Measure Harness itself (small, any time)

- **Change:** in `src/main/app/runtime-diagnostics.ts`, record the main process's own CPU (`process.cpuUsage()`) every minute and log the
  busiest recent activity when it stays above half a core for five minutes. Log each chat start with how many helpers it was given and
  which helper tools it called. Local log only.
- **Why it still matters:** Harness and your own chats stay here. Trimming helpers waits for this, and for Part B, since sessions that move
  stop starting their helpers here.
- **How to prove it:** a sampler test with a fake clock, then a day of logs compared against `list_host_processes`.

## What must stay true

- Your own chats, the Harness app, databases and dev servers stay on this Mac.
- Browser work never falls back to this Mac (`browser-remote-offload-policy.ts:239-285` asks instead), and Android only runs on the PC. Test
  and session slots leave room for both: the PC's Android emulator and browser, and the test Mac's browser and iOS builds.
- James's Codex servers stay as they are (`docs/decisions/rejected/provider-and-account-policy.md`). Nothing sends data anywhere but
  his own machines, so the rejected remote telemetry item isn't reopened.
- With the switch on, everything behaves as it does today.
- No branch is pushed and no job lands from the far machine; that stays on this Mac.

### Leftovers

The 35 idle Atlassian helpers can be stopped with `stop_leftover_processes`; it refuses anything a live chat owns or that it can't trace
to an ended Harness session. `mysqld` and `mariadbd` must be left alone. Your setting already stops leftovers automatically
(`leftoverProcessCleanup` is `stop-all`), but only for sessions that ended since Harness last started, and only an hour after they ended
(`ENDED_GRACE_SEC`, `leftover-process-sweeper.ts:55,258`). Harness had been up about two hours, so some of these (20–58 minutes old) are
still inside that hour and will go on their own; the older ones belong to sessions from before the restart, which the sweeper doesn't
know about. They use no CPU, so this isn't worth code work.

## When a machine is off or busy

| Situation | Switch off | Switch on |
|---|---|---|
| Both free | PC or test Mac | Same |
| PC busy, test Mac free | Test Mac | Same |
| PC busy, test Mac away | Waits for the PC (today it comes here) | This Mac |
| Both away | Waits, then "not run"; queue jobs hold | This Mac |
| Both paused on the Computers page, or `AIO_REMOTE_CHECKS=off` | "Not run", with the reason | This Mac |
| A session no other machine can take yet (e.g. Codex before Decision 3 or B3) | This Mac, and the queue says why | This Mac |
| A test only this Mac can run | This Mac | This Mac |

## How we'll know it worked

- Afternoon load average here under 15 on a normal working day with the switch off (it was 41–46 on 12 November).
- `list_host_processes` here shows no test runs from unattended work and, after Part B, no queue or loop sessions.
- `runs.jsonl` shows small runs, commit-hook tests and this project's checks finishing remotely, and none on this Mac with the switch off
  apart from the Mac-only ones.
- The PC's and test Mac's own load stays below their thread count, and browser, Android and iOS jobs still start on time.

## What I didn't measure

- What the far machine's set-up costs a one-file run. Full runs cost about 30 seconds; small runs may cost less once installed. A2 measures it.
- Whether Undistilled's folder and Node are on the test Mac.
- Short-lived processes here: about a quarter of this Mac's CPU didn't show up in any snapshot.
- What makes Harness's main process busy, what chat start-up costs and which helpers chats use (Part C).
- How often automations fire.
- Why both remote machines sent back no usable report at 15:14 on 12 November.

## Not in this plan

- Renting a machine or a virtual machine (still Stage 6 of the offload plan, with its own conditions).
- Noah's computers.
- Moving your own interactive chats.
- Changing your Codex servers (a rejected decision).
