# Plan Queue — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-18-plan-queue_plan_completed.md](2026-09-18-plan-queue_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from this checkout (`npm run build:main && npm run build:renderer &&
  npm run build:aio-mcp-dist`, then restart) so the Plan Queue coordinator, its MCP tools, IPC
  channels and panel are loaded. These checks need that restart and real provider CLIs, which is
  why they could not run in-loop; the coordinator itself is covered by
  `src/main/plan-queue/plan-queue-coordinator.spec.ts` with scripted instances against temporary
  repositories.
- **Stop-and-confirm gate 2 from the plan:** run every check against a disposable scratch
  repository, never this repository's real backlog. Pointing the queue at the real plans is James's
  call after these pass.
- Scratch repository setup (reuse it across checks):

  ```sh
  mkdir -p /tmp/pq-scratch && cd /tmp/pq-scratch && git init -q -b main
  git config user.name "Plan Queue Scratch" && git config user.email pq@example.invalid
  printf '.worktrees/\nnode_modules/\n' > .gitignore
  printf 'export const version = 1;\n' > index.ts && git add -A && git commit -qm base
  mkdir -p docs/plans
  for n in alpha beta gamma; do
    printf '# %s plan\n\n- [ ] Create `%s.ts` exporting `export const %s = true;`.\n- [ ] Update the status line of this plan when done.\n' "$n" "$n" "$n" \
      > "docs/plans/2026-09-18-${n}_plan.md"
  done
  ```

  Keep the three plan files untracked. Open a Claude session whose working directory is
  `/tmp/pq-scratch`; that session is the parent in every check.
- Database: `~/Library/Application Support/harness/loop-mode.db`, tables `plan_queue_runs` and
  `plan_queue_items`. Coordinator log: `~/Library/Application Support/harness/logs/app.log`
  (`PlanQueueCoordinator`, `PlanQueueItemFlow`, `PlanQueueRecovery` entries).

## Status — 2026-10-04 (livetest campaign batch D)

Open: 2 (check 4 not run: needs a genuinely limit-hit provider account; check 7 not run: needs James's
authority to point the queue at the real repository) · Closed: 4 (checks 1, 2, 5, 6) · Failed: 1
(check 3 — two new defects, LT-700 and LT-701). Full write-up: [Evidence run — 2026-10-04 (batch
D)](#evidence-run--2026-10-04-batch-d).

## Status — 2026-09-18

Open: 7 · Closed: 0 · Failed: 0

## Outstanding checks

### 1. Three-item run end to end: rail nesting, panel, verdict round-trip, squash commits

1. In the parent session, ask: "Use plan_queue_start with kind plans, verifier_gates [] and
   post_merge_gate [] to work through the plans." (The scratch repository has none of this app's
   gate commands; the empty lists make the verifier use the repository's own documented checks
   and skip the post-merge TypeScript checks.)
2. Expected tool result: three items, each `discovered`, run `status: running`, `baseBranch: main`,
   `verifierGates: []`.
3. Expected in the rail: a `Queue triage` child, then three `Queue · 2026-09-18-…_plan` workers
   (at most 3 at once), each nested under the parent with the Plan Queue marker; each worker's
   working directory is `/tmp/pq-scratch/.worktrees/queue/…`.
4. Expected per item: a `Queue verifier · … (round 1)` child on a provider other than the worker's
   (`codex` when the parent is Claude), which calls `plan_queue_report_verdict`; after PASS the
   verifier and worker sessions end.
5. Expected in the Plan Queue panel (Control Center → Plan Queue): the run and its three items move
   through `working` → `awaiting-slot` → `verifying` → `landing` → `landed`, updating live.
6. Expected in git: `git -C /tmp/pq-scratch log --oneline main` shows one `Plan: 2026-09-18-…_plan`
   commit per item, each containing both `<name>.ts` and `docs/plans/…_plan_completed.md`; the
   untracked `docs/plans/…_plan.md` copies are gone from the root; `git branch --list 'queue/*'`
   and `git worktree list` show nothing from the queue; `.worktrees/queue/` is empty or absent.
   (The scratch repository has no hooks of its own, so only the global plan-spec guard runs; the
   hook path is covered by `plan-queue-landing.spec.ts` and check 7.)
7. Expected in the parent session: one message listing no questions and, at the end, a summary
   `Landed 3, parked 0, skipped 0`.

### 2. A question reaches James through the panel with radio controls

1. Add `docs/plans/2026-09-18-delta_plan.md` whose first lines are `**Spec:** [spec](./missing_spec_planned.md)`.
2. Start a run with `glob: "docs/plans/2026-09-18-delta*"`, `verifier_gates: []`, `post_merge_gate: []`.
3. Expected: the item is `needs-answer` immediately; the parent receives a message naming its
   `item_id` and options `proceed` / `skip`; the panel shows the question with radio buttons.
4. Choose "Work on it anyway" in the panel. Expected: the item starts (`preparing` → `working`) and
   later lands; the parent session's copy of the question needs no answer.

### 3. Restart mid-run

1. Start a run over two fresh plan files (with `verifier_gates: []`, `post_merge_gate: []` as in
   check 1). When one item is `working` (worker session busy), quit
   Harness normally and start it again.
2. Expected after restart: `PlanQueueRecovery` logs no failure; the working item gets a new worker
   session whose first message says it is resuming because "the app restarted", on the same
   `queue/…` branch, with the pre-restart files present in its worktree; an item that was
   `verifying` gets a fresh verifier; the run completes as in check 1.

### 4. Provider-limit park

1. Start a single-item run while the parent's provider account is at its usage limit (or with a
   provider account known to be exhausted), so the worker's final message is a limit notice.
2. Expected: the item is `parked` with park reason `provider-limit`, the notice text in its detail,
   its branch kept (`git branch --list 'queue/*'`), no worktree directory, and a line
   `Plan Queue parked work: \`queue/…\`` appended to the plan document. Panel → Resume re-queues it
   and, once quota returns, it lands.

### 5. Reconciler alert on a seeded unowned queue worktree

1. With Harness stopped: `git -C /tmp/pq-scratch worktree add -b queue/seeded-000000 .worktrees/queue/seeded-000000 main`.
2. Start Harness, open the Plan Queue panel, and refresh the alerts.
3. Expected: an `unowned-worktree` alert for that path and an `unowned-branch` alert for
   `queue/seeded-000000`. Nothing is deleted: the directory and branch still exist afterwards.
   Worktrees that are not under `.worktrees/queue/` (for example this repository's `task-*` loop
   worktrees) produce no alert.

### 6. Relaxation profile restore

1. Note the current values of `computerUseAutonomyLevel` and `providersExcludedFromAutomation`
   (`$AIO_MCP settings get <key>`).
2. Start a run with `relax_settings: true`. Expected: both settings show the relaxed values
   (`unrestricted`, `[]`) while the run is active; the run row's `relaxation_json` holds the originals.
3. Quit Harness mid-run and start it again. Expected: the originals are restored at boot and then
   re-applied because the run is still active.
4. Let the run finish (or cancel it). Expected: both settings are back to the values from step 1
   and `relaxation_json` is NULL.

### 7. The landing commit runs this repository's hooks (in the real repository)

Run only after checks 1–6 pass and James agrees to point the queue at this repository.

1. Start a run over one small, low-risk plan in this repository.
2. Expected at landing: `app.log` shows the pre-commit hook's generators and `test:staged` running
   in `.worktrees/queue/…`; the landed commit on `main` contains the code and the
   `_plan_completed.md`, with any regenerated artifact (`register-aliases.ts`,
   `src/preload/generated/channels.ts`, `docs/generated/architecture-inventory.json`) included;
   nothing from another session's uncommitted work appears in it
   (`git show --name-only main` lists only this item's files).
3. From the packaged app specifically: the hook finds `node`/`npm` (no `command not found` in the
   item detail). If it cannot, the item parks `land-blocked` after two refusals with that output.


---

## Evidence run — 2026-10-04 (batch D)

Batch D of the 2026-10-04 campaign. Dev app from the working tree (HEAD `3d05e250e`, `dist/main` built
23:20), profile `/tmp/aio-lt-1004-d`, CDP port 9491, shared renderer on `:4567`. Everything ran against
throwaway git repositories under `/tmp/aio-lt-1004-d-repos/` (`pq-scratch`, `pq-restart`, `pq-hook`); the
real `ai-orchestrator` repository was never given to the queue. Evidence is in
`_scratch/lt-2026-10-04/d/` (`pq-*.txt/json`, `pq-applog-slice-all.ndjson`, `NOTES.md`); the app log slices
were copied out because `app.log` is shared with the other batches' dev apps and rotates.

Two environment facts that affect anyone repeating this:

- Under the Seatbelt fence `npx electron .` exits silently: the GPU process cannot start its own sandbox
  (`sandbox initialization failed: Operation not permitted` / `GPU process isn't usable. Goodbye.`).
  Launching the Electron binary directly with `--js-flags=--max-old-space-size=8192 --no-sandbox --disable-gpu`
  worked (the heap flag skips the self-relaunch). This is a harness limitation, not a product defect.
- A fresh dev profile has `pauseFeatureEnabled`/`pauseOnVpnEnabled` **on** (the real profile has both off).
  At 23:45 a VPN interface event paused my dev app and interrupted the running Plan Queue triage session
  (`InterruptRespawn origin=pause`); nothing resumes an interrupted session, so the run sat at `discovered`.
  I turned the setting off in the throwaway profile (`pauseGetState` then `isPaused:false`), cancelled that
  run and redid it. Any other batch using a fresh profile may have been hit by the same pause.

Tuning: `worker_slots 2` / `verification_slots 1` for most runs (at most 3 provider sessions at once).

### Check 1 — three-item run end to end · PASS

Parent `c6ktufc4z` (Claude, yolo, cwd `pq-scratch`) was asked, in plain words, to call `plan_queue_start` with
kind plans, `verifier_gates []`, `post_merge_gate []` (plus the two slot limits). Run
`b3fad73d-a988-406e-826d-d82e28aa6932`.

1. Tool result (verbatim from the parent's transcript): `status:"running"`, `baseBranch:"main"`, three
   items each `state:"discovered"`, `excluded:[]`. **Doc text no longer matches the source:** the MCP result
   has no `verifierGates` field (`runSummary`, `plan-queue-tool-operations.ts:25-34`); the empty list is on the
   run's config (`planQueueList` → `config.verifierGates: []`, seen).
2. Rail: a `Queue triage` child and the workers appear as children of the parent (`parentId c6ktufc4z`),
   working directories `/private/tmp/aio-lt-1004-d-repos/pq-scratch/.worktrees/queue/2026-09-18-<name>-<hash>`.
   Rendered rail checked on a later run: `.instance-row.is-child` rows `└ Queue verifier · … (round 1)` with a
   `.plan-queue-marker` (`aria-label="Plan Queue verifier"`, `data-role="verifier"`).
3. Verifier: `PlanQueueVerifierSelect: workerProvider claude → provider codex (gpt-5.6-terra)`; each item passed
   in round 1 and its worker/verifier sessions were gone at the end (`listInstances` showed only the parent).
4. Panel/store states sampled every 15 s (`pq-timeline.log`): `discovered → working → awaiting-slot →
   verifying → landed`; `landing` was caught on the epsilon run in check 2. The panel (`/plan-queue`) showed the
   run, its summary counts and its items.
5. Git (`pq-check1-git.txt`): `main` = `b673eab Plan: …gamma_plan`, `12b2c2d Plan: …alpha_plan`,
   `faacf35 Plan: …beta_plan` over `base`; each commit has exactly `<name>.ts` and
   `docs/plans/…_plan_completed.md`; `git status` clean (untracked `_plan.md` copies gone); no `queue/*` branch;
   `git worktree list` shows only the root; `.worktrees/queue/` empty.
6. Parent: no question messages; final system message `Plan Queue run b3fad73d… (plans) ended: completed.
   Landed 3, parked 0, skipped 0.`

### Check 2 — a question reaches James through the panel with radio controls · PASS (with a doc update)

**The check as written no longer applies.** A plan whose `**Spec:**` link is missing is no longer a human
question: the triage agent investigates it and records an automatic technical decision (`plan-queue-readiness.ts`
`automaticDecisionPatch`; the prompt tells it to "investigate missing linked specs on existing plans
autonomously"). Observed: `delta` (missing `missing_spec_planned.md`) went `discovered` → `working` with
detail `Automatic technical decision (no new authority): implement-note-missing-spec …`, and landed
(`b9162b5 Plan: …delta_plan`). The question is raised only after triage, not "immediately".

To test the question path I used a plan that genuinely needs James (`epsilon`: "James must choose the
licence, MIT or Proprietary; nothing records his choice"). Run `63d96d89-e99c-474f-9e71-7ae4d8ceac46`:

- After triage the item became `needs-answer` with `decision.kind: human-authority` and options `mit`,
  `proprietary`, `skip` (`pq-items-now.json`, `NOTES.md`).
- The parent received the system message "Plan Queue needs James to decide on 1 document(s)…" with the
  `item_id` and the option ids, and relayed it without answering.
- Panel: `app-plan-queue-page` rendered three radios (`name=pq-question-0`, values `mit`/`proprietary`/`skip`)
  and a **Submit answer** button. I clicked the `mit` radio and Submit; the item went `working` → `verifying`
  → `landing` → `landed` (`d1e79ae Plan: …epsilon_plan`, containing `LICENSE.txt`, `epsilon.ts` and the
  completed plan).
- The earlier delta run was first spoiled by the environment pause above (triage interrupted); it was cancelled
  (`Run cancelled by James.`) and redone, which produced the result shown.

### Check 3 — restart mid-run · FAIL (new defects LT-700, LT-701)

Two normal quits (SIGTERM; the shutdown ran to `Cleanup complete {incompletePhaseCount: 0}`) of the dev app.

**Quit 1** (run `a3799290`, items `rone` `verifying`, `rtwo` `awaiting-slot`; this is also check 6): after
relaunch no `PlanQueueRecovery` failure was logged, the run stayed `running`, both items kept their branches and
worktrees. The `verifying` item got a fresh verifier (`xxo781iov`). **But** that verifier was spawned 6 s after the
coordinator initialised and 7 s *before* the orchestrator-tools socket was listening, with no orchestrator-tools
MCP; it ended its turn without a verdict and the item parked `verifier-unreliable` ("ended its turn without
reporting a verdict") → **LT-700**. The `awaiting-slot` item's worker and verifier, started later, worked and
`rtwo` landed in round 2 (`63f5c2b`).

**Quit 2** (run `0be3b82e`, `rthree`/`rfour` both `working`, `pq-restart2-pre.txt`): the shutdown itself ended
the run `completed` with both items `parked`, `worker-error`, `instance entered terminated`, so after relaunch
there was nothing to resume and no "app restarted" worker message → **LT-701**. A manual `resume-item` on
`rthree` re-queued it and it landed (`ef52301`). The workers had no uncommitted files yet at the moment of the
quit (only the worktree checkout), so "pre-restart files present in the worktree" was not exercised.

### Check 4 — provider-limit park · NOT RUN

Needs a genuinely exhausted provider account; none was available and I did not fake the notice. Related park
behaviour seen incidentally: a park with zero commits on the branch appends no `Plan Queue parked work:` line
(`appendParkedNote` only runs when `commitCount > 0`, `plan-queue-item-flow.ts:531-536`), and `resume-item` on a
parked item re-queues it and lands (rthree). Neither substitutes for this check.

### Check 5 — reconciler alert on a seeded unowned queue worktree · PASS

While the dev app was stopped: `git -C pq-restart worktree add -b queue/seeded-000000
.worktrees/queue/seeded-000000 main`. After relaunch `planQueueAlerts` returned `unowned-worktree` (that path,
branch `queue/seeded-000000`) and `unowned-branch` (`queue/seeded-000000`) — and nothing for the live run's own
`queue/…` worktrees (`pq-check5-alerts.json`). I then added `.worktrees/task-seeded-loop-abc123` (a loop-style
worktree): still no alert for it. The panel's alerts list rendered the same two alerts after **Refresh**. The
seeded directory and branch still existed afterwards; nothing was deleted.

### Check 6 — relaxation profile restore · PASS

Profile originals set beforehand: `computerUseAutonomyLevel: trusted`, `providersExcludedFromAutomation:
["copilot"]` (I set the second so the change is observable; the throwaway profile had `[]`). `relax_settings:
true` → both showed `unrestricted` / `[]` and `plan_queue_runs.relaxation_json` held
`{"entries":[{"key":"computerUseAutonomyLevel","original":"trusted","applied":"unrestricted"},
{"key":"providersExcludedFromAutomation","original":["copilot"],"applied":[]}]}`. Quit mid-run (settings file on disk
still relaxed). Relaunch: log `Plan queue restored a relaxed setting` ×2 then `Plan queue relaxed a setting for its
run` ×2 (`1791156565…`), settings relaxed again. When the run finished (`1791157221451`): settings back to
`trusted` / `["copilot"]` and `relaxation_json` NULL.

### Check 7 — landing commit runs this repository's hooks (real repository) · NOT RUN — needs James's authority

By definition it needs the real repository and the packaged app's `PATH`. **Supplementary only, not a pass:** in
a throwaway repo with a committed pre-commit hook (`core.hooksPath=.hooks`, the hook appends a line to a log),
a one-plan queue run landed `f7bbb32 Plan: …hooked_plan` (`hooked.ts` + `…_plan_completed.md`) and the log shows
the hook ran inside `.worktrees/queue/2026-09-18-hooked-5e5d30` at landing (`pq-hook-ran.log`).

### Defects filed

LT-700 (recovery spawns a verifier before the orchestrator-tools socket exists), LT-701 (a normal quit parks
every working item and ends the run). See `livetest-remediation-register.md`.

### Cleanup

All instances terminated, the dev app stopped, the profile and `/tmp/aio-lt-1004-d-repos/` removed (see the batch
report); no setting of James's real profile was touched. The shared `app.log` contained `Plan queue verifier
selected … provider copilot … licence-pinned` lines in my time window: those are not mine (my app never created a
Copilot instance and its profile has no Copilot account).

**Doc is not renamed:** checks 3 (failed), 4 and 7 (not run) remain.
