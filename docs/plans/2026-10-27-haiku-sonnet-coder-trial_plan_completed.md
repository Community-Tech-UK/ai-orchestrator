# Is Haiku, or Sonnet at a lower thinking level, good enough to code from Opus's plans? — plan

On main: no (an experiment; the Status below records no product code).

## Status

On main: yes (this landing commit)
ACTIVE, untracked. Updated 26 Nov 2026.
- Test 1 is closed as it stands by James's 20 Nov delegation (rules at the top of the livetest doc): 209 of 210 cells
  scored, the missing cell and second judge dropped, the seven-batch concurrency deviation accepted. Report:
  `..._report.md`.
- Test 2 prerequisites are done and on main (commit 339d21c9c): queue thinking-level control (tool schemas accept
  `effort`), LT-722 triage repair (3 of 3 real triage runs applied, test Mac), outcome report and reconcile scripts.
- Test 2 itself is not run. All 42 waiting plans are owned by queued or running queue items (six live runs), so no
  free documents exist for the matched Sonnet-low vs Sonnet-default split. Steps 8 to 12 stay open; the live check is
  in the livetest doc (check 3). Complete applied-history validation and the full-suite gate also stay open.
- Verification rounds 1 and 2: plan and livetest live only untracked in the root checkout (removed from the branch).
  The tracked report was rewritten to the 20 Nov decision (Test 1 closed, nothing about the dropped cell, second judge
  or approval left open) and its code citations corrected. Only blocker left: no unowned plan documents for Test 2.
- Not renamed; the coordinator owns completion.

Requested by James on 2026-10-27 after the Plan Queue step-up live checks: "create a plan to do those tests …
both for Sonnet (at different thinking levels) and Haiku. You can bounce between different accounts if we start
hitting the 5 hr limit/warning."

Related:
- [Plan Queue step-up](2026-10-27-plan-queue-stuck-worker-step-up_plan_completed.md): a stuck worker's document is
  handed once to a stronger model. Its live checks proved the mechanics only; Haiku's "failures" there were forced.
- [Plan/execute benchmark](2026-10-14-local-model-plan-execute-ab_plan.md) (active, another session's work): the test
  bench, the 10-task bank, the saved Opus plans and the hidden-test scoring this plan reuses.

## For James

Two tests, in this order.

1. **A fair head-to-head on known answers.** The 10 coding tasks from the earlier benchmark are real past changes
   from this repo and 12steps. Each has hidden tests that say pass or fail, and a saved Opus-written plan for each
   task already exists. Haiku and Sonnet each code every task from that same plan, three times, at different thinking
   levels. Opus on its own is the yardstick. This tells us how often each one gets it right, how long it takes and
   what it costs, without anyone's opinion deciding.
2. **The real thing.** The best-looking cheap settings from test 1 work through a batch of real, waiting plans in the
   Plan Queue, with Opus set as the stronger worker. This tells us how often a document gets handed to Opus in
   practice, how many check rounds it takes, and what a landed document really costs.

Limits to know up front:
- 10 tasks can only show big differences (roughly 20 points or more). If two settings come out close, the report
  says "too close to call" rather than picking one.
- In the earlier pilot even Opus solved only 3 of the 10 tasks, so the tasks are hard. That is useful for finding
  where cheaper models break, but it means many results will be "nobody solved it".
- When a Claude account gets near its 5-hour limit, the tests move to your next Claude account and carry on. Your
  never-use account is never touched, and your use-last account only when nothing else has usage left.

## What gets compared

Thinking levels are Claude Code's `--effort` setting (low, medium, high, xhigh, max). High is Claude Code's default.

| Setting | Model | Thinking | Why |
|---|---|---|---|
| H-high | Haiku 5.5 | high (default) | The cheapest option, as it runs today |
| H-max | Haiku 5.5 | max | Does more thinking rescue Haiku? Dropped if Haiku ignores the setting (step 3) |
| S-low | Sonnet 5.5 | low | Cheapest Sonnet |
| S-medium | Sonnet 5.5 | medium | |
| S-high | Sonnet 5.5 | high (default) | Same as the earlier pilot's arm D, re-run under the same conditions as the others |
| S-max | Sonnet 5.5 | max | Is Sonnet's ceiling near Opus? |
| A | Opus 5.5, no plan | default | The yardstick, re-run so every setting is measured with the same Claude Code version |

Every setting except A codes from the same saved Opus plan for each task.

## Test 1 — the head-to-head (benchmark)

### Before starting

- [x] **The bench is not on main.** It lives on branch `queue/2026-10-14-local-model-plan-ex-a7a00e` (latest; its
  queue item parked `worker-error` on 27 Oct), under another session's active plan. **Decision (changed from the
  first draft):** that branch is not touched. The bench at its tip (`78f0900`) was exported with `git archive` into
  the disposable folder `_scratch/coder-trial/` and the trial's changes were made there; they are listed under
  Progress so the bench's own plan can take them in later. No branch or worktree was created.
- [x] Read that plan's Test design, Scoring, Fairness controls and Honest limits sections, its README and
  `arms.ts`, `agent-cli.ts`, `runner.ts`, `decision-rules.ts`, `report.ts` and their specs. Its rules
  (frozen dependency installs, no `git log` leakage, hidden tests never shown to the coder) apply unchanged.
- [x] Baseline its tests before any edit (from the copy: `npx vitest run --config benchmarks/plan-execute-ab/vitest.config.ts`):
  211 of 212 passed; the one failure (`scoring-setup.spec.ts`, global module path) needs the repository's own
  `node_modules/tsx` beside the copy and is a copy-location artefact, unchanged by this work.
- [x] **Clean controls (free).** The bench's notes said scoring awaited a dependency-free export location. Exports now
  go to `/private/tmp/coder-trial/workspaces` (no `node_modules` above it). `verify-task` passed for all 10 tasks:
  hidden tests fail on the parent and pass on the fix (`_scratch/coder-trial/results/control-*.log`).

### Steps

1. [x] **Thinking level per arm.** Add `coderEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` to `ArmSpec` and
   pass `--effort <level>` in `buildClaudeInvocation` when set. Absent means no flag (Claude Code's default), so
   existing arms and their records are unchanged. Record the effort on every run record and in the report table.
   Tests: argv with and without effort; existing arm argv unchanged.
2. [x] **New arms** `H`, `HM` (Haiku high/max), `S1`–`S4` (Sonnet low/medium/high/max), all on the frozen plan.
   As built, simpler than drafted: no new phase; the batches run `--phase pilot --runs 3`. The decision rules
   below were fixed in this document before any result; the bench's own `decision-rules.ts` (written for its
   local-model questions) is not changed, and the trial's verdict is applied by hand in the report.
3. [x] **Probe that thinking levels take effect.** Done with one reasoning question per model and level (output
   tokens: Haiku low 564 / max 5,397; Sonnet low 3, wrong answer / max 845, right answer). Both honour `--effort`;
   `HM` stays. Raw JSON in `_scratch/coder-trial/results/effort-probe/`. One small task, each model at `low` and `max`, 2 runs each.
   Pass: the CLI accepts the flag and output/thinking tokens differ in the expected direction. If Haiku rejects or
   ignores it, drop `H-max` and say so in the report. Keep the probe's raw output as evidence.
4. [x] **Account rotation (the 5-hour limit).** As built (`accounts.ts`, env `PLAN_EX_AB_CLAUDE_ACCOUNTS`):
   ComTech, Adapt, Adapt-IT, then SUAS (use-last) — each checked with one Haiku call. One deviation: a run that
   finishes under the approaching-limit warning keeps its result (it was not cut short); the warning only moves
   later runs to another account. A run the limit stops is re-run on the next account. The bench spawns `claude` directly, so it needs its own rotation:
   - A run option `--claude-accounts <ordered list>` of Claude Code config directories (one per signed-in account,
     the ones Harness already manages). Build the list from Settings → Accounts, keeping only Claude accounts that
     are turned on and allowed for automatic work, leaving out the never-use list and putting the use-last list at
     the end. Log account labels, never tokens or file contents.
   - Before each run, skip an account whose recorded limit has not reset yet. When a run stops on a usage limit or
     the approaching-limit warning, mark that run `infrastructure: usage-limit` (never a model failure), note the
     account and reset time, and re-run that task from a fresh export on the next account.
   - Each run records which account ran it. Accounts must not change a result. The report checks this by showing
     the solve rate per account for A.
   - Risk: a CLI that cannot write back a refreshed login can get the whole login revoked (seen in October 2026). Run the
     bench where the CLI can write its own config directory, never inside a hardened jail.
   - Tests: rotation order, skip-until-reset, a usage-limit stop re-queued on the next account, never-use excluded,
     all accounts exhausted pauses with a clear message instead of failing cells.
5. [x] **Judging, only where it helps.** (`judgeOnlyPassingPairs` in the trial config.) Hidden tests and the no-damage checks decide. The two blind judges
   (Opus and Codex, both orders) run only for tasks where both the arm and arm A pass the hidden tests, to compare
   quality. That keeps judge spend proportional.
6. [x] **Run** (closed by James's 20 Nov decision: 209 of 210 cells scored; the 210th cannot change the result) the trial on the 10 tasks: arm A and the six new arms, 3 runs each (210 runs), up to 4 cloud runs at
   once, with the earlier fairness controls (same time limit, turn cap and Claude Code version for every arm; if
   Claude Code updates mid-run, re-run the affected arms). Run while the Mac is not under heavy load.
7. [x] **Report** (written: `2026-10-27-haiku-sonnet-coder-trial_report.md`) with the bench's existing tooling: solve rate with 95% ranges per arm and per thinking level, gap
   to A, time, Claude tokens, metered cost per solved task, how often each arm hit a limit, and the matching decision
   rule. Then a plain-English summary for James.

### Decision rules (agreed before seeing results)

- A setting is **good enough** when its solved rate is within 10 points of arm A on these tasks and its lower 95%
  bound is not more than 25 points below A's.
- Among good-enough settings, the **recommended default** is the one with the lowest cost per solved task. Ties
  go to the faster one.
- If no Haiku setting is good enough but a Sonnet one is, the recommendation is Sonnet at that thinking level.
- If nothing is good enough, the recommendation is to keep Opus as the queue worker and not run test 2.
- A thinking level that costs more without solving more than the level below it is called out as not worth it.

## Test 2 — real waiting plans in the Plan Queue

Runs only for the settings test 1 recommends (at most two), so real work is never done by a setting already
shown to be poor.

### Before starting

- [x] **Thinking level for queue workers (re-landed 14 Nov; live read-back done).** The Plan Queue could not set it (the step-up spec left it out of
  scope). Add `reasoningEffort` to `PlanQueueRouteChoiceSchema` (optional/nullable: absent retains the Harness default for persisted-route compatibility; null explicitly selects the provider default), pass it as
  `reasoningEffort` on the queue's `createInstance` call in `routeQueueSpawn`, add `effort` to the MCP route-choice
  argument schema and a "Thinking" select to each route editor on the Plan Queue page, and show it in
  `describeRouteChoice`. Same tests, gates and fresh-eyes review as any queue change. Its own small plan if it grows.
- [x] **Fix [LT-722](livetest-remediation-register.md#lt-722)** first: triage sometimes cannot find its reporting
  tool, which parks documents before any worker runs and would distort the numbers. Code repair and prompt regression
  are on main; three real-provider triage runs passed 3 of 3 on the test Mac on 16 Nov (livetest round 4).
- [ ] Account rotation needs no new code here: one worker choice per setting with `account_ids` listing every
  Claude account allowed for automatic work. The account pool already picks among them, switches before the limit
  at its threshold, and fails over inside that list; James's never-use and use-last lists still apply.

### Steps

Steps 8 to 11 run as the matched A/B split in the 20 Nov decision (Sonnet low against the current Sonnet default, up to 20
documents split by a recorded coin flip, run side by side); where they say "per setting" or "James sees the list",
that decision replaces them. Blocked on 26 Nov only by having no unowned documents (see Status).

8. [ ] **Pick the plans.** 8 to 10 waiting `*_plan.md` documents per setting: code changes of small or medium size,
   no livetests, nothing needing a person or an outside service, and none another session is working on. Spread
   sizes evenly between the settings. James sees the list before the run starts (decision 2).
9. [ ] **Run** one queue run per setting: workers = that setting with its accounts, step-up = Claude Opus (high),
   checkers automatic, the default 3 rounds. Work lands on the base branch as usual.
10. [ ] **Collect**, per document, from `plan_queue_items` and the session transcripts: passed on the first check
    or not, rounds used, handed to Opus or not, final outcome (landed or parked and why), spend and time, and the
    checker's findings by severity. Add a small read-only report script under `scripts/` that prints this table for
    given run ids. Tests for the script.
  Read-only per-document MiMo report: `npm run audit:queue-mimo-spend` (2026-10-28-plan-queue-mimo-spend Step 1).

11. [ ] **Compare** with recent Opus-worker queue runs on similar plans (same table, from history) for cost and
    rounds. Plain-English write-up: "Haiku with Opus as backup landed N of M documents; K needed Opus; a landed
    document cost about $X versus $Y with Opus alone."

## Finishing

12. [ ] Record results, the decisions they triggered and as-built notes here; tell James the recommended Plan Queue
    worker and step-up settings in one paragraph. Rename this plan `_completed` only when every step is done and an
    independent fresh-eyes review passes. Commit only if James asks.

## Cost and time

Metered-equivalent figures from the earlier pilot, where 10 Sonnet coding runs cost $4.98 and 10 Opus runs $23.04.
On subscription accounts this is usage-window time rather than money, which is why accounts rotate.

- Test 1: Sonnet arms about $5–10 per 10 runs depending on thinking level (max more), so about $60–120 for 4 levels
  × 30 runs; Haiku about a third of Sonnet, about $10–20; Opus yardstick about $70 for 30 runs; selective judging
  about $20–40. **Roughly $160–250 in total.** The saved plans cost nothing more.
- Test 2: real backlog work that would be done anyway; the extra is only the failed rounds and Opus handovers.
- Time: test 1 is about a day unattended at 4 runs at once. Test 2 runs at the queue's normal pace.

## Decisions for James

1. Approve test 1's spend (roughly $160–250 of usage across your Claude accounts).
2. When test 1 is done, approve the list of real waiting plans for test 2 (or say "pick them yourself").

## Progress

- 2026-10-27 20:18 UTC: test 1 started — `_scratch/coder-trial/run-trial.sh`, four batches in parallel in session
  `_scratch/coder-trial/results/coder-trial-2026-10-27` (A; S1+S4; S2+S3; H+HM), 3 runs per task, Claude Code
  2.1.311. Stop it with `kill $(cat _scratch/coder-trial/results/run-trial.pid)` and the runner processes
  it started; it resumes where it left off when re-run.
- 2026-10-27 22:50 UTC: restarted as one batch per setting (7 in parallel) and one attempt per task first
  (`RUNS=1 ./run-trial.sh`), then `RUNS=3` for the repeats. Reason: the runner does all repeats of a task before
  the next task, and after 2.5 hours only AIO-01 was covered (14 runs; many hit the 60-minute limit under machine
  load around 40-85). Four in-flight runs were stopped and their task copies removed; the 14 recorded runs were kept
  (every setting passed AIO-01). Running every setting at the same time also gives each the same machine load.
- Trial changes in the copy (for the bench's own plan to take in): `types.ts`, `arms.ts` (arms, `--effort`),
  `agent-cli.ts` (`rate_limit_event`), new `accounts.ts` + `accounts.spec.ts`, `runner.ts` (rotation, effort,
  judge filter, trial arms selectable), `config.ts` (`judgeOnlyPassingPairs`), `arms.spec.ts` (arm list).
  Bench tests from the copy: 219 of 220 pass (the copy-location artefact above).
- 2026-10-28 00:15 UTC: status check. 32 of the 70 first attempts recorded (S1 has finished its first pass; the
  others are on tasks 2-4), every run so far on ClaudeComTech, whose 5-hour window is under 10% used. Machine load
  about 35. **Claude Code updated itself to 2.1.312 at 00:09 UTC**, mid-run; one in-flight run (AIO-04 S3) started
  on it, none recorded yet. Per the fairness control the trial must be pinned back to 2.1.311. This session could
  not do it: the trial was launched from an earlier session, so this session is not allowed to signal its
  processes, and launching the bench from a locked-down session risks a Claude login revocation (step 4's risk).
  Prepared instead: `_scratch/coder-trial/bin/claude` (APFS clone of 2.1.311); `run-trial.sh` now puts it first
  on PATH with `DISABLE_AUTOUPDATER=1`, refuses to start on any other version, and appends to the batch logs;
  `quarantine-version.mjs` moves to `runs-quarantined.jsonl` / `quarantined/<time>/` every recorded run (and judge
  pair) whose log shows another version, plus the logs of stopped runs (the agent log is appended to on re-run);
  `restart-pinned.sh` stops the trial (its own process tree and processes inside its task copies only), removes the
  stopped runs' copies, runs the quarantine, then starts `RUNS=1` followed by `RUNS=3` detached. Tested: the
  quarantine on a temporary copy of the session with one run faked as 2.1.312, and the stop step on dummy
  processes. **Waiting on James to run `restart-pinned.sh` from Terminal.**
- 2026-10-28 00:30 UTC: James ran `restart-pinned.sh`; nothing needed setting aside except the 7 stopped-run logs, all
  32 records kept, new runs confirmed on 2.1.311. **ClaudeSUAS removed from the rotation at James's request** ("I
  don't need that going to 100%"): taken out of `run-trial.sh` (applies from the `RUNS=3` pass), and for the
  first-pass runners already running, `results/claude-accounts.json` marks it limited until 2099, so they wait
  for one of the other three to reset instead of using it (checked with the bench's own `AccountRotation`). No run
  had used it. Rotation is now ComTech, Adapt, Adapt-IT. This narrows step 4's account list (SUAS was use-last).
- 2026-10-28 09:20 UTC: first pass finished 06:49 (69 of 70; 12ST-01 H run 1 failed before scoring with "scoring
  dependency setup receipt missing", re-queued by the repeat pass). Repeats running: 117 of 210 recorded. Rotation
  worked: ComTech hit its limit once (reset 06:20), runs moved to ClaudeAdapt (22 runs), SUAS never used.
  First-try solved (of 10 tasks): A 3, H 3 (of 9), S1 3, S2 3, S3 3, HM 2, S4 2. Only AIO-01, AIO-02 and 12ST-02
  are solved by anyone; the other 7 by no setting, Opus included, so far the trial separates the settings only on
  cost and time. Metered cost per run so far: S1 $0.33, S2 $0.49, S3 $0.69, H $1.02, A $2.42, HM $4.24, S4 $5.50.
  No run passed the hidden tests while damaging other code.
- 2026-10-28 15:55 UTC: **the Mac restarted at about 12:37 UTC** (no panic report in DiagnosticReports) and the trial
  stopped at 12:24 with 148 of 210 runs recorded (S1 and S2 complete; A 20, H 17, HM 15, S3 20, S4 16 of 30).
  `/private/tmp` was cleared by the restart, so nothing is left behind. `restart-pinned.sh` now checks that the saved
  launcher number still belongs to the trial before stopping anything (a restart can hand it to an unrelated
  program; tested). Dry run of the cleanup: all 148 kept, 6 stopped-run logs to move. Results so far are unchanged in
  shape: every setting solves AIO-01 and AIO-02 every time and 12ST-02 (HM and S4 never), and nothing else; every
  repeat matched its first try. Cost per run: S1 $0.33, S2 $0.50, S3 $0.65, H $0.91, A $2.39, HM $4.32, S4 $4.75.
  **Waiting on James to run `restart-pinned.sh` again** for the remaining 62 runs.

- 2026-10-29 10:02 UTC: restarted from a Harness agent session rather than Terminal, after checking that this session
  can write the three Claude account folders (so the refresh/revocation risk in step 4 does not apply) and that
  `bin/claude` is 2.1.311. Started via `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' ./restart-pinned.sh` so the
  trial is in its own process session and is not tied to the agent session. All 148 runs kept; 6 stopped-run logs
  set aside; 62 runs remain. Machine load at restart about 35-45 (the work-finding Plan Queue run is active). Separately,
  that run's workers were switched to Claude Sonnet (step-up Claude Opus) the same morning. This is not test 2:
  it has no thinking-level control and no chosen plan list.


## Reconciliation scope, 2026-10-31

The queue readiness record requests reconciliation of existing evidence and a concrete proposal before more runs.
This pass does not spend further model usage, start test 2, change live queue routes, or infer approval.
No separate linked spec exists for this trial; the related benchmark plan remains another session's work.

- [x] Recompute all seven arms from saved run cells; identify missing/duplicate cells and apply task-level ranges.
- [x] Audit CLI versions, effort, turn caps, account distribution, limit events, costs and judge coverage.
- [x] Publish the corrected comparison and conditional recommendation with reproducible evidence.
- [x] Prepare a real-plan proposal, retaining eligibility/ownership and approval blockers explicitly.
- [x] Run focused tests and static checks; retain command receipts and evidence hashes for the verifier.

Implementation choice: add a standalone offline read-only reconciliation script in the assigned worktree.
It reads existing records/logs and emits JSON, without invoking any models or modifying the input session.
Tests cover denominator integrity, cumulative CLI cost, interrupted invocations, fairness and incomplete judging.
That initial scope left Test 2's prerequisites and campaign for later. Verification round 2 below adds local
production prerequisites; the live campaign remains behind the trial decision and approved list.

## Reconciliation as built, 2026-11-03 (initial scoped pass; round 2 supersedes delivery status)

1. Recovered the standalone offline script and its tests from the parked attempt's Git blobs into the assigned
   `queue/2026-10-27-haiku-sonnet-coder-f40630` worktree, without a branch operation or commit. The earlier report
   existed, but its linked evidence directory did not. Recomputed that evidence from the original saved session.
2. Strengthened checks for recorded frozen-plan use, consistent per-task scoring/dependency contracts and actual
   opposite judge orderings with matching task/arm/repeat identities. Added consumed-input hashes, per-category
   and per-arm unknown-cost counts and hidden-pass/damage summaries. Focused regressions failed before these fixes
   and now pass. Original outcome and available-cost totals are unchanged by the stronger audit.
3. [Corrected report and conditional recommendation](2026-10-27-haiku-sonnet-coder-trial_report.md): Sonnet low is
   the proposed candidate, with Opus high as step-up. It solved 9/30 repeats, the same three tasks as Opus, at
   $1.10 logged coding cost per solve versus $7.59. Ten independent tasks and broad overlapping ranges make quality
   too close to call. No live queue recommendation has been applied. Recorded session usage is at least $427.27;
   34 invocation segments have no final cost. This is metered-equivalent usage, not an invoice.
4. Refreshed a read-only queue snapshot and fully reread the ten shortlisted plans. None supplies an eligible,
   unowned eight-to-ten-plan batch: existing reservations, duplicate work, already implemented changes and external
   acceptance remain. The report proposes the exact setting and selection/comparison method, without inventing an
   approved batch. The route-snapshot item is now landed and its current document is `_completed`; this worker did
   not rename it. The migration/check plan has a newer parked item and an older queued reservation.
5. Current focused Node tests, script syntax, both repository typechecks, lint, TypeScript-size and UI-hint checks
   passed. Individual command receipts, full logs, reconciled JSON, source/input manifest and integrity seal are in
   `2026-10-27-haiku-sonnet-coder-trial_evidence/`. The full suite belongs to the queue verifier under the explicit
   worker instruction. Production builds and app/browser checks were not run for this standalone offline script;
   no production/renderer/IPC/generator input changed. No runtime or dependency installation was created; test
   fixtures are removed by teardown, and the earlier trial runtime was preserved.
6. Fresh review follow-up added independent fixtures for each scoring-contract mismatch/missing field and judge
   arm/verdict/rubric validation. Missing judge identities now remain incomplete. A failing quarantine-judge cost
   regression also led to including those nested logs; none is present in the real session. The final replay is
> Earlier journal sections moved to `2026-10-27-haiku-sonnet-coder-trial_plan_history_2961cd67d660e784b74aa6f5aeef7399d07fbe74cec81826d8acf054e6baf058_completed.md`.
## Verification round 2 repairs, 3 November 2026 (active)

The failed verification is accepted as evidence that the whole experiment is not complete. No checkbox for the
benchmark, historical fairness decision, real-plan approval, campaign or final recommendation is being closed.
The current queue item's recorded readiness answer explicitly permits saved-results reconciliation but supplies
no authority for new benchmark/judge calls, live routing changes or a second campaign. An asynchronous approval
question was sent; no response is treated as permission.

1. **Queue thinking control implemented locally.** Optional `reasoningEffort` is retained by stored route choices;
   MCP choices accept `effort`. The chosen worker/triage route atomically replaces stale effort, checker selection
   retains its own effort, and checker/triage-retry creation passes it through. The worker, checker and stronger
   worker editors expose Thinking; status summaries show explicit settings. Changing provider clears a stale setting; model edits preserve the selected level and show an error
   when a discovered Codex model does not support it. Codex levels come from discovered model capabilities. Tests exercise the contract, chosen-route
   replacement, checker selection and real Angular editor DOM/save behavior. No live queue configuration changed.
2. **LT-722 prompt repair implemented locally.** Triage now uses the same Harness discovery/invocation instructions
   as verification and reads `applied`/`unmatched` from the triage receipt. The new regression first failed on the
   absent discovery route, then passed after repair; existing verifier prompt expectations remain intact. The
   register's three real-provider triage trials remain unrun because further provider usage is not authorized.
3. **Outcome snapshot report added.** `npm run audit:queue-coder-outcomes -- --run <id> [--run <id> ...] --json`
   reads requested runs and all their items in one read-only SQLite transaction. It reports current outcomes,
   current-phase rounds, handovers, elapsed wall time, recorded provider/estimated costs including run overhead,
   and severity counts from the latest verdict. It was exercised against both disposable SQLite fixtures and the
   actual owning queue run. It explicitly leaves first-check pass, total historical rounds and complete spend
   unknown. An optional `--history-dir` reads accepted checker report receipts from archived sessions; it
   deduplicates outcomes and rejects failed calls. Complete applied-history validation and a matched Opus cohort
   are still step 10/11 work, not established by a partial archive. The queue resets rounds on handover/Resume and retains only its latest verdict;
   inferring missing history from those counters would falsify the trial.
4. **Reconciliation tests are gated.** A Vitest-discovered wrapper runs all eleven original Node regressions under
   the normal `test:quiet` gate. `npm run audit:coder-trial` exposes the offline audit alongside sibling audit tools.
   The original Node test cases and assertions were preserved.
5. **Dependency failures reproduced and repaired without weakening tests.** The shared install had glob 13.0.6
   where the lock requires 14.0.3 and lacked its nested minimatch. A real `npm ci --ignore-scripts --no-audit --no-fund`
   inside this assigned worktree succeeded. Both dependency regressions now pass, as does the reconciliation
   wrapper. No dependency versions or lockfile entries changed. Install hooks were deliberately skipped to avoid
   changing shared Git hooks/global ignore rules. The worktree dependency install is retained for the verifier.
6. **Missing-cell recovery investigated, not invented.** The saved patch and successful dependency receipt exist,
   with Node v24.22.1 and the original dependency fingerprint. The scoring workspace no longer exists. The actual
   benchmark `assertNoAncestorDependencies` guard rejects this checkout because the root repository has installed
   dependencies. The repair instruction forbids copying a source tree outside this worktree, and neither Docker
   nor Podman is installed. The recorded isolation probe exits 1 with that explicit guard error. Scoring cannot
   be made protocol-equivalent here by linking host dependencies or disabling the guard. No new runtime export,
   model call, synthetic score, or edit to the historical `runs.jsonl` was made. This remains an environmental /
   authorization blocker, not a completed live-test deferral.

Current command receipts and full logs are retained in this worktree's `_scratch/coder-trial-review/`;
review evidence, report, integrity seal and cleanup receipt are retained as small evidence in
`2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-2/`. No source tree or
installed dependencies will be placed beside the plan. The full experiment will remain ACTIVE.


Round-2 follow-up evidence:
- The fresh source reviewer identified archive-name/receipt/coverage edge cases. They are repaired with regressions
  for dotted tool names, structured receipt arrays, missing/unknown-end-time archives, duplicate rearchives,
  renamed checkers and unsafe archive identities. First-recorded pass is withheld when any relevant archive is missing.
- Tracing actual instance creation exposed two effort hazards: `undefined` selects the app default, while `null`
  requests the provider default; Codex's adapter silently drops Claude-only `workflow`. Queue creation now passes
  `null` for Provider default and refuses provider-incompatible thinking levels at route validation. Focused
  regressions failed on the old behavior and pass after repair. The existing shared resolver/factory was traced,
  not modified. Same-model higher-effort handover is also covered and permitted by the editor.
- A fresh full run exposed missing native SQLite binaries after the script-free install. The repository's
  `npm run rebuild:native` succeeded and verified Electron ABI 146. All affected file-backed/restart tests and
  dependency tests then passed. The initial full run was explicitly cancelled (exit 130) after its known setup
  failures; it is not a full result. The final full run completed against the prepared install; its two
   unchanged worker/adapter failures and isolated passing rerun are recorded below.
- A new read-only ownership census found 42 active root plan files. Every active plan suffix under docs/ is in
  that folder except one in a discovery-excluded archive. Forty have existing nonterminal queue-item ownership;
  only two have none, before any size or readiness filtering. An eight-to-ten-document batch cannot be proposed
  from these unreserved candidates without first resolving existing ownership. This supplements the earlier
  ten-document shortlist and does not cancel, release or adopt any queue work. Census: `candidate-inventory.json`
  in round-2 evidence. The two candidate filenames alone are not an approved trial list.

- A second source review prompted two final editor improvements: provider-level options are now shared by the
  contract module, main validator and editor; editing the model preserves an explicit thinking choice instead of
  silently resetting it. Known Codex model capabilities block an unsupported choice in the editor. A row without
  a discovered Codex model deliberately offers no guessed levels. Per-model backend support is not asserted by
  the provider-level guard: the adapter mapping and spawn resolver were traced, but further provider probes
  remain unauthorized. The existing trial's model/version/effort flags and saved probes remain its evidence.

- Final compatibility correction from the third source review: do not change the behavior of saved routes or
  legacy runs that never set an effort. The queue now uses the existing session tri-state convention: missing
  means the Harness app default, null explicitly means the CLI/provider default, and a concrete level is literal.
  Both choices are labelled in the editor and MCP exposes the same optional/nullable field. This deliberately
  refines the draft's shorthand "absent = provider default" to preserve persisted settings without rewriting live
  data. Regression evidence `legacy-default-red` showed the unwanted old-route behavior before correction.
  Concrete Sonnet-low and Opus-high trial choices are unchanged. No live settings or queue rows were migrated.


Round-2 current verification limitation: focused queue/report/dependency regressions, both typechecks, lint,
size/UI-hint checks, both production builds and IPC/export checks pass against the frozen source hashes. The
final full run completed with exit 1: two failures among 36,399 reported tests, in unchanged worker forced-timeout
output capture and Codex native partial-timeout fixtures. Both files then passed together in isolation (exit 0);
an earlier isolated worker run had reproduced the capture failure plus a missing child-PID fixture. Relevant
worker/adapter files match main. Standalone Node stdout/stderr first appeared after 175/176 ms, beyond the
worker test's 150 ms timeout. This implicates startup timing without proving the only cause. No unrelated code,
expectation or timeout was changed. The full gate remains failed; isolated success is not a waiver. Exact output,
full-run hashes and both rerun receipts are retained with the round-2 evidence. The latest fresh source review returned SOURCE PASS only for the code it read;
it had limited source coverage and no shell execution. It does not satisfy independent full-gate acceptance.


Round-2 handover checklist (not a completion ruling):

- Finding 1: partly repaired. Local queue effort/discovery/report prerequisites are implemented; original steps
  6–12, complete applied-history validation, tested judge-retry preparation and the campaign remain open.
- Finding 2: open. Still 209/210 scores, no complete second-judge pairs, no concurrency-deviation acceptance.
  Missing-cell isolation, further usage authority and an approved/unowned campaign batch remain blockers.
- Finding 3: repaired. All eleven Node cases run through the normal Vitest gate; full-run wrapper result passes.
- Finding 4: original dependency failures repaired. Locked local dependencies/native SQLite are retained. The
  final full suite fails two different unchanged timing-sensitive tests; both files pass in an isolated rerun,
  so full acceptance is still not claimed. Other canonical gates and new focused regressions pass.

No new benchmark/judge/provider trial, live queue route change or installed-app/browser session was run.
The fresh reviewer source PASS has partial coverage and no independent command execution; the full independent
gate and experiment remain unaccepted. No commit, branch/worktree operation or completion rename was made.


Round-2 runtime cleanup completed after report/receipts and the pre-cleanup seal were written. Removed this
repair's compiled dist subtrees, native download cache, Vitest compile cache, temporary probe/helper programs
and identified disposable test fixtures. Kept the assigned worktree, source edits and its complete local
dependency install/native SQLite binary for the verifier. No new cluster, browser runtime, copied checkout
or dev server was created. The earlier root benchmark/trial runtime was not created by this repair and is
preserved. Exact deletion/ownership checks are in `review-round-2/cleanup.receipt.json`; the runner PID is gone.
Final report, command receipts and integrity seal are in `review-round-2/`. The plan remains ACTIVE/untracked.

## Verification round 3: acceptance remains blocked, 3 November 2026

The latest verifier's findings were checked against this plan, the saved records and the existing branch diff.
The checkout began clean at `bc0c3a340`; its merge-base with main is `faac6d587`. The earlier local work is already
committed by the coordinator. This pass retains it and changes only untracked root documentation and evidence.
It does not restart the experiment or claim that the reconciliation scope completes the original plan.

The current instruction expressly authorises saved-results checking and a proposal, while excluding new
benchmark/judge calls, live routing changes and a second campaign. "Fix every finding" does not supply the
separate model-usage and batch authority that the same instruction preserves. No unanswered question or automatic
readiness answer is being treated as approval. James must approve any further usage and the exact real-plan batch
(or explicitly delegate its selection), as decisions 1 and 2 require. A fairness decision is also still required.

### Open preparation and blockers (not live-test deferrals)

- [x] **Recover a protocol-equivalent score for `12ST-03|H|2`.** (Dropped by James's 20 Nov decision; kept below for the record.) Retain the original patch, parent, hidden-test
  contract and frozen dependency receipt. Offline rescoring would need no new model call, but the original
  workspace is absent and the recorded isolation guard rejects exports under this checkout's installed ancestor
  dependencies. Source copies outside this worktree are forbidden. Resolve that environment constraint before
  attempting recovery; do not disable isolation, change the hidden-test contract or infer a score from CLI success.
  A new model invocation instead needs separate usage approval. The original step 6 remains unchecked.
- [x] **Prepare and test the second-judge retry offline (re-landed 14 Nov: `scripts/coder-trial-judge-retry.mjs`, five
  regressions in `scripts/__tests__/coder-trial-judge-retry.spec.ts`, passing).** The sixteen saved pairs it needs are no longer on disk,
  so executing it is still open. Original wording: Preserve all existing successful Opus orders and
  unavailable Codex evidence. Select the saved subject/baseline repeat identities and both blind presentation
  orders. The saved runner skips existing pair JSON, so a generic rerun is insufficient. This is implementation
  work, not a human or external-service check; no retry implementation is claimed by this pass. The benchmark
  remains another session's subsystem. Only approved provider execution belongs in the live checklist.
- [x] **Resolve the historical fairness deviation.** (Accepted by James's 20 Nov decision.) Seven simultaneous batches exceeded the agreed four, and
  high host load confounds timings. James's explicit acceptance of the qualified historical result, or approval
  for a replacement controlled experiment, is still absent. Filling one score cannot repair concurrency history.
- [ ] **Complete the Test 2 prerequisites and batch proposal.** Queue thinking/discovery/report code exists, but
  its full independent gate, complete applied-history validation, account-fence readback and LT-722 provider checks
  remain open. Refresh ownership, identify eight to ten eligible unowned plans and freeze a comparable Opus cohort
  before seeking batch approval. The round-2 census found only two unreserved filenames, not an eligible batch;
  it must be refreshed before selection. No existing queue ownership may be silently changed to reach eight.
- [ ] **Complete the outcome evidence.** Accepted checker tool receipts do not prove applied verdicts. The report
  deliberately leaves first-check pass, total historical rounds and complete spend unknown where evidence is
  absent. Complete validated history and a matched Opus cohort remain required by steps 10 and 11. Do not turn
  latest counters, missing archives or unknown costs into complete campaign measurements.
- [ ] **Obtain a clean full-suite result and independent acceptance.** The worker must not run the full suite;
  the current instruction reserves it for the verifier. Round 2's failed gate and the latest verifier's stopped
  attempts are not successes. A passing isolated rerun cannot replace the full gate. No timeout, assertion,
  reporter, configuration, dependency version or test expectation is weakened to obtain acceptance.

### Disposition of the six latest findings

1. **Open:** Test 1 steps 6 and 7. Saved-results reconciliation is reproducible but does not supply the missing
   score, second judge or fairness acceptance.
2. **Open:** Test 2 prerequisites and steps 8–11. Local code is a prerequisite, not a run or historical comparison.
3. **Open:** Step 12 and whole-experiment fresh-eyes acceptance. Sonnet low / Opus high remains a proposed setting,
   not an accepted queue recommendation. The plan must keep its active filename.
4. **Documentation repaired:** offline implementation, environment constraints and missing approval are now kept
   here. The companion live checklist contains only actual external runtime checks, conditional on future
   authority. None of these open requirements is used to qualify this plan for a completion rename.
5. **Open:** the full test gate lacks a clean result. Current isolated results are recorded separately in the
   round-3 evidence; even success there does not resolve the verifier's full-suite finding.
6. **Open:** the outcome report remains a partial step-10 prerequisite. Its explicit unknowns are retained.

Current command receipts, saved-evidence replay and independent review are retained under
`2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-3/`; worker logs are in the assigned worktree's
`_scratch/coder-trial-review-round-3/`. All ten current focused/static commands exited 0: the seven-file focused
queue/report/dependency run, both previously failing files together in isolation, both typechecks, lint, size,
UI hints, IPC, exports and diff whitespace. The standalone Node regressions run within the Vitest wrapper.
This does not replace the still-failed full gate. Builds were not repeated for this documentation-only pass;
the full suite was not run, as explicitly required by the worker instruction.

The saved replay is byte-identical to round 2, including all consumed JSON/log hashes. All sixteen separate
Codex judge logs were inspected by field name only: 105 JSON events, no cost or usage field at any nesting level.
Their usage is additional unknown cost, outside the 34 missing-cost Claude segments. The report now states that
scope explicitly. No prompt, diagnostic body or credential was copied into the new evidence.

The fresh read-only reviewer returned FAIL for the unfinished experiment; shell execution was refused in that
review context. Its speculative source observations were checked against the scripts, queue schema/store and
historical judge runner. `firstRecordedCheckPass` describes the first accepted archived call; actual first-check
pass remains null, as does complete cost per landed document. Neither placeholder is presented as campaign
measurement. The runner does select the first saved repeat and skips existing judge-pair files. No unsupported
source edit or independent PASS is claimed. Review coverage and the readback assessment are retained separately.

No separate linked spec exists. The assigned branch and tracked source remain unchanged; all three original
root documents remain untracked. Cleanup removes only this pass's newly created Vitest compile cache after the
report, receipts and pre-cleanup seal are written. Worktree dependencies and pre-existing runtime are retained;
the cleanup receipt and final seal record the actual disposition. No full-plan completion is claimed.