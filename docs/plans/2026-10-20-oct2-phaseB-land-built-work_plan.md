# Oct-2 Phase B: land the October work that is already built, and put plans on a diet

## Status

On main: no (`queue/2026-10-20-oct2-phaseb-land-bu-863a90`).
Steps 2/4/5/7 code fulfilled. Step 3: 4/6 dieted (Phase 5 331→206 KB, Phase 3 538→402 KB, follow-ups 456→280 KB,
checkout-timeout earlier); Phase 4 part 1 completed by owner; Phase 1 after-landing by design. Step 5.2 built with
opt-in support and tests, but the runtime refusal is **warning-only** (`PLAN_SIZE_REFUSAL_ACTIVE = false`) until Step 3
is verified — see the coordinator checkpoint. Step 7.1: all 16+ active plans have "On main: no". Step 6: keep-3 policy,
migration, Storage card and single-pruner startup composition built (verifier round 2 fixed); first installed prune
remains the livetest. Remaining: Step 8 seven ordered landings (coordinator). Phase A still not integrated/installed —
prerequisite for Step 8. Revision 2 findings 2–4 fixed; verifier round 1 fixed (lockfile-valid install, fence
tracking, warning-only refusal); verifier round 2 fixed — backup pruners reconciled: clean-up/archive backups
and links stay, one pruner deletes per startup, `Codex backup keep-3 run` log equals the filesystem delta.
629 plan-queue tests + retention suites, typecheck, lint, LOC, build:main pass. Full suite reserved for verifier.
24 Oct: the coordinator's `main` base-sync merge conflicts (7 files) resolved with both sides' intent kept (settings
migrations, `StorageSettings`+`ObservationSettings`, both card tests; Codex prune steps merged into one).
Evidence: [history](2026-10-20-oct2-phaseB-land-built-work_history.md).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items L2, H1, T1 items 1, 3, 5 and 7, and K4 item 1
(early). **Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) · B (this) ·
[C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) · [D](2026-10-20-oct2-phaseD-tokens_plan.md) ·
[E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

### Coordinator integration checkpoint

After Phase A prerequisite code passes independent queue acceptance, resume the retained original item
`f6e51221-a3e4-4d0e-94e5-4a8308863a90`, branch `queue/2026-10-20-oct2-phaseb-land-bu-863a90`.
This checkpoint integrates the reviewed prompt, guard and runtime code needed to perform Step 8;
it does not close Phase B. Preserve all remaining Step 3 diets, Step 7 status reconciliation,
Step 5 refusal activation and Step 8 landings as active requirements. Keep the size refusal warning-only
until Step 3 is actually verified. No implementation dependency is a deferred passed live check.

Workers and assigned queue checkers must run commands in the foreground, poll yielded commands until
their actual exit status, await every helper review, and never end a turn to wait. The assigned checker
must call `plan_queue_report_verdict` before ending, including on failure. Before code integration,
independently review the entire retained diff after AIO's base sync using `task-completion-gate`, its
applicable audit escalation, and every canonical gate including the full suite. Any actionable defect
means FAIL and repair in this original item. A genuine code-integration PASS must use
`document_complete: false`; it does not certify the unfinished coordinator operations or permit closure.
No Land anyway, manual Git integration, duplicate attempt or waived/missing gate.

When AIO returns merge conflicts, preserve the base branch's newer behavior, including Phase A's safety
and checker changes. Regenerate committed output using `npm run generate:ipc`,
`npm run generate:aliases` and `npm run generate:architecture`; never hand-merge generated files.
Record integration evidence and remaining requirements in the root history, preserving existing content.

Recheck custody before choosing each retained job. The table below is historical: the newer Phase 3
branch `queue/2026-10-10-oct-phase3-calm-scr-5d08d9` now contains a 660-path checkpoint, not an empty
duplicate; the older `a4427f` branch contains 217 changed paths. Preserve both and reconcile their actual
requirements and unique work before resuming the appropriate original item. Root comparison evidence:
`_scratch/queue-resume-2026-10-21/phase3-retained-work-comparison.json`. Counts alone do not establish
acceptance or justify dropping either branch. A later read-only blob check found all 23 older-only
changed paths match current main on the newer branch, while every older tip differs; eight are absent
from both main and newer. This is a reconciliation lead, not proof of missing/currently required behavior.
Use `_scratch/queue-resume-2026-10-21/phase3-older-only-path-custody.json` to trace those requirements and
callers before choosing an implementation or declaring the older work obsolete. The explicitly identified Phase 1 `528c17`, tooltip
foundation `1b2e67`, Phase 5 `3e8047`, and repaired follow-ups `546c7e` remain the user's recovery targets.

Most of what James approved on 10 October is written but sits on side copies the plan queue gave up on: the calmer screen,
the tooltips, the "later" items and the follow-ups, plus the token-saving work still waiting for its final check. This plan
brings them into the main code one at a time, safely, and makes every plan say plainly whether its work is in the main code.

It also slims the plan files. Six active plans are about 250-600 KB, every worker and checker re-reads them, and a checker
cannot fit a 600 KB plan plus a large change in its memory. That is why several of these jobs failed in the first place.

## Measured on 20 Oct (`git rev-list` and `git merge-tree` against `main` 0190f9133)

| Plan | Branch | Behind / ahead | Files | Conflicting files |
|---|---|---|---|---|
| Phase 1 token levers | `queue/2026-10-10-oct-phase1-token-le-528c17` | 0 / 35 (37 later the same night) | 525 (545) | 0 (job live, still growing) |
| Phase 3 calm screen | `queue/2026-10-10-oct-phase3-calm-scr-a4427f` | 8 / 10 | 217 | 9 |
| Phase 5 later | `queue/2026-10-10-oct-phase5-later-3e8047` | 8 / 3 | 218 | 10 |
| Phase 4 part 1 | `queue/2026-10-10-oct-phase4-tooltips-1b2e67` | 25 / 1 | 125 | 13 |
| Phase 4 part 2 | `queue/2026-10-10-oct-phase4b-tooltip-8b1f09` | 8 / 5 | 116 | 9 |
| Phase 4 part 3 | `queue/2026-10-10-oct-phase4c-tooltip-7562c5` | 8 / 4 | 109 | 4 |
| Follow-ups | `queue/2026-10-11-oct-followups-bad1a7` | 8 / 5 | 673 | 14 |

Conflicts against `main` alone (each branch also overlaps the others; Phase 1 and Phase 3 share 38 files):

- **Phase 3:** `context-worker-import-isolation.spec.ts`, `src/preload/generated/channels.ts`,
  `cross-model-review-indicator.component.ts`, `input-panel.component.spec.ts`, `instance-header.component.{html,spec.ts}`,
  `user-action-request.{component,rules}.ts`, `settings-metadata-review-network.ts`.
- **Phase 5:** `compaction-runtime.ts`, `instance-lifecycle.ts`, `instance-spawn-preflight-chain.{ts,spec.ts}`,
  `orchestrator-tools-mcp-forwarder.spec.ts`, `provider-runtime-service.{ts,spawn-worker.spec.ts}`, `channels.ts`,
  `output-stream-context-menu.ts`, `output-stream.component.ts`.
- **Phase 4 part 1:** `headless-review-runner.spec.ts`, `review-prompts.{ts,spec.ts}`, `instance-header.component.spec.ts`,
  `loop-config-panel.{component,defaults}.ts`, `loop-control.component.{html,ts}`, and five files under
  `shared/tooltip/` (`aio-tooltip-panel.component.ts`, `aio-tooltip.directive.ts`, `tooltip-copy.ts`, `tooltip-policy.ts`,
  `tooltip-visible-text.ts`), which `main`'s own D1 fix changed.
- **Phase 4 part 2:** `sidebar-footer.component.ts`, `loop-past-runs-panel.component.spec.ts`, two plan-queue components,
  `provider-quota-chip.component.ts`, four `shared/tooltip/` files.
- **Phase 4 part 3:** `sidebar-footer.component.ts`, `context-bar.component.ts`, `provider-quota-chip.component.ts`,
  `aio-tooltip.directive.ts`.
- **Follow-ups:** `docs/generated/architecture-inventory.json`, `automation-loop-run.ts`, `claude-cli-adapter.ts`,
  `settings-control-policy.ts`, `context-worker-import-isolation.spec.ts`, `instance-system-prompt.spec.ts`,
  `campaign-loop-status.ts`, `session-continuity.ts`, `channels.ts`, `cost-page.component.ts`,
  `instance-header.component.spec.ts`, two verification components, `settings.types.ts`.

`src/preload/generated/channels.ts` and `architecture-inventory.json` are generated: regenerate them, never hand-merge.
Re-run the measurement before each merge, because `main` moves as each one lands.

**Which job to resume.** Each row's branch belongs to the older job that holds the work (set aside for a round limit,
land-block or checker problem on 12-16 Oct). These October queue branches have no commits beyond `main` (20 Oct): the
`queue/2026-10-1*-` branches ending `phase0-confirme-e4d864`, `phase3-calm-scr-546537`, `phase3-calm-scr-754b95`,
`phase4-tooltips-78d48c`, `phase4b-tooltip-0b85c5`, `phase4b-tooltip-7e68e3`, `phase4c-tooltip-ca8754`,
`phase5-later-33e309`, `followups-e59e4d`, `plan-queue-large-st-0cdb54`, `plan-queue-large-st-37952b` and
`local-model-plan-ex-2b95ea`. Never resume their jobs; discard them through the queue once the real job has landed. Other
October branches with commits that are not in the table (`phase5-later-e9f577`, `followups-6f4138`,
`phase4c-tooltip-4995f5`, `phase2-loops-co-5c8c24`, `housekeeping-c2ff86`, `evidence-startup-de-94a931`,
`mimo-quota-banner-a-f48038`, the older Phase 0 and Phase 1 attempts, the local-model A/B branches)
are out of scope: list each in the history file with its state and what it holds that the table's branch lacks (if
anything), and leave them to the queue's own clean-up or to James.

## Ground rules

1. **Read first**; line numbers are from 20 Oct; trust names. Read each branch's own plan status before merging it.
2. **No new branch or worktree.** Use the queue's own branches and worktrees through the queue (Resume reattaches the
   item's worktree). Do not delete or rename any queue branch; the queue removes its own after landing. Never `git stash`.
3. **Land through the queue, and let the queue merge.** The queue's base sync (`syncItemWithBase`,
   `plan-queue-landing.ts:72-98`) merges `main` into the job's branch and hands conflicts to the job's worker
   (`buildConflictPrompt`, `plan-queue-prompts.ts:125`); its document merge, squash, active-document refusal and post-merge
   gate then apply. Nobody runs `git merge`, `checkout` or any other hand git command inside a queue worktree: those
   folders are managed by Harness. A coordinator session only resumes jobs, watches them, and answers their questions.
4. **Files already modified in the root checkout belong to other sessions.** The `package.json` / `package-lock.json` edit
   (a `selfsigned` dev dependency) has blocked two landings, and `plan-queue-doc-merge.ts` has another session's
   uncommitted edit: ask James who owns each before touching it, and wait for that owner to commit or hand-merge with them.
5. **File size:** see `npm run check:ts-max-loc`; a conflict resolution must not push any file over its limit.
6. **No browser or desktop app on the Mac.** Screen checks go to each plan's existing livetest document, run on the
   Windows PC. If the Windows PC is down, stop and tell James; never fall back to the Mac.
7. **Each landed plan stays active for its unfinished steps.** Landing a branch does not close its plan. Phase 3, for
   example, still has steps 7-10, 12-14, 16 and 17 open: its plan stays `_plan.md` for those, except that Phase E
   supersedes its step 8b (the shared status presenter) and the U1-U3 slices of steps 7 and 8; record that in Phase 3's
   Status block when it lands.
8. **Never restart Harness yourself.** After each landing, rebuild; James restarts when it suits him.
9. Keep the Status block under about 1,500 characters; rewrite it in place.

**Settings keys:** `settings.types.ts` has about 4 lines of room (885/889): every new key in this plan goes in a separate
settings-types module that the main settings type extends, never in that file.

## Order of work

| Step | What | Size | Needs first |
|---|---|---|---|
| 1 | (moved to Phase A Step 0) | - | - |
| 2 | T1 item 1: the status-block rule, for every session and for queue prompts | S | Phase A Step 0 |
| 3 | T1 item 7: one-off diet of the six active plans over 100 KB (Decision 7) | S | Step 2; per plan, see the step for timing |
| 4 | T1 item 3: hand queue roles the lists, not the document | S | Step 2 |
| 5 | T1 item 5: size gate as a warning; step-sized jobs | S-M | Steps 2-4 |
| 6 | K4 item 1 early: Codex backup keep-3 | XS-S | none |
| 7 | L2 items 2-4: "On main", "Ready to review and merge", landing blocks that retry | S-M | Phase A Step 3 |
| 8 | L2 item 1: land the branches in order | M-L | Phase A Step 3; Steps 3 and 7 |

---

## Step 1. (Moved)

The `_history` guard moved to Phase A Step 0, so that it exists before any plan writes a history file.

## Step 2. T1 item 1: one replaceable status block, for everyone

**Why.** In the Codex sessions run in the AIO folder on 15-19 Oct, re-reading plan text was about 360M tokens, 8.5% of
those sessions' input. These were ordinary sessions in the root checkout, which read AGENTS.md and never see the queue's
prompts.

**Change.**
1. AGENTS.md, section "Plan and Spec Filename States" (lines 15-21), gains five lines: keep one `## Status` block at the
   top of an active plan, at most about 1,500 characters (done, next, decisions, open issues, pointers to sections),
   rewritten in place; never add dated sections; round evidence goes to `<stem>_history.md` beside the plan, which agents
   do not read unless the status block points there; history otherwise lives in commit messages and verdicts; and the
   states: `*_history.md` is active (never committed), `*_history_completed.md` is closed.
2. The same rule in the queue's worker, fix and resume prompts (`plan-queue-prompts.ts:80`, `:86`, `:121`, `:163`), which
   today say to update "status and as-built notes", with one difference: a queue worker writes round evidence to the
   history file in the **root checkout** (the prompt gives its absolute path), because a new file written inside the job's
   worktree would be committed on the job's branch, and an active history file there is refused at landing (`plan-queue-squash.ts:125-133`) and costs a round.
   Phase C Step 5's diet moves text into the same root file. Keep `plan-queue-prompts.spec.ts` in step, with a spec that
   the prompt names the root path.
3. AGENTS.md also gains one line naming this repository's generators, so a worker resolving merge conflicts regenerates
   instead of hand-merging: "Generated files are never merged by hand: run `npm run generate:ipc`
   (`src/preload/generated/channels.ts`), `npm run generate:aliases` and `npm run generate:architecture`
   (`docs/generated/architecture-inventory.json`)." (`build:main` alone does not regenerate them; the `prebuild` hook
   regenerates the aliases and IPC channels but not the architecture inventory.)
4. `docs/prompt-engineering-house-style.md` is untouched here (Phase D's T11 owns it).

## Step 3. T1 item 7: one-off diet of today's big active plans (Decision 7)

Active plans over 100 KB on 20 Oct: Phase 1 (about 600 KB and still growing), Phase 3 (464,905 bytes), follow-ups
(376,230), checkout-timeout (262,115), Phase 5 (256,086), Phase 4 part 1 (254,405).

**Timing.** The queue's document merge at landing is three-way (root copy, base, branch copy), and each stranded branch
carries its own edited copy of its plan. A root copy whose sections have moved could conflict with it. So: diet the
checkout-timeout plan now (no stranded branch); for each plan with a branch, first run the document merge on copies of the
three versions in `_scratch/` (a throwaway script calling the merge function, no writes to the real files) and record the
result. If it merges cleanly, diet before landing (cheaper landing runs); if not, diet right after that branch lands.
Phase 1's job is live and rewriting its own copy: diet it only after it lands, by agreement with its owning session.

For each plan:

1. Confirm no session is editing it (file not modified in the last hour).
2. Move every dated status block except the newest, and every dated as-built, continuation, repair or hand-off section,
   into `<stem>_history.md` verbatim. Leave a one-line pointer per moved section. Never delete text; check that the byte
   count of plan plus history equals the original plus the pointers.
3. Write one new `## Status` block of at most about 1,500 characters from the newest status and the step checklist, with
   "On main: yes / no (commit)" (Step 7) as its first line.
4. Leave the step bodies alone; their size is a design matter for Step 5.
5. The eight `_completed` plans over 100 KB are closed and stay as they are.

Done when each of the six is under about 120 KB, or the history file explains why the remaining step body is larger.
If James answers Decision 7(b), this step is skipped, and so are Step 5's refusal and step-sized jobs; Step 5 then only
shows the size as information.

## Step 4. T1 item 3: hand queue roles the lists, not the document

The coordinator extracts the unchecked `- [ ]` items and the step's "Done when" / acceptance bullets (at most about 4 KB)
and passes them inline to workers and checkers (`buildWorkerPrompt`, `buildVerifierPrompt`); checkers also get
`git diff --stat` and read plan sections by line range. Triage gets the 40-line header discovery already holds
(`plan-queue-discovery.ts:97-104`) instead of "read each one" (`plan-queue-prompts.ts:223`). Put the extraction in a new
`plan-queue-plan-extract.ts` with a spec over a real (copied, trimmed) plan fixture.

## Step 5. T1 item 5: size gate and step-sized jobs

1. **One shared "stopped by Harness" reason.** Add `stopped-by-harness` to `PlanQueueParkReasonSchema`
   (`packages/contracts/src/schemas/plan-queue.schemas.ts:33-44`) with a plain label ("Stopped by Harness") and a detail
   saying why, and the matching entry in the renderer's exhaustive `PARK_REASON_LABELS`
   (`plan-queue-item-list.component.ts:25-36`), which Phase C later replaces. It is never retried automatically. This step creates it; Phase C (park-reason help, retries) and Phase D
   (the runaway-turn ceiling) reuse it. `park_reason` is plain text in the database, so no migration.
2. Discovery and Start a run list a plan over about 120 KB as "Large plan: split it into step documents, or trim it first",
   as a warning only. After Step 3 has run, a plan over 200 KB is refused as `stopped-by-harness` with "This plan is over
   200 KB. Trim it or split it into steps." The refusal applies to new items at discovery and Start a run only, never to
   resuming an existing job (Step 8 resumes jobs whose plans are still large). This is the only size gate; Phase C's
   discovery work points here.
3. A plan above the warning size with `## Step N` headings becomes one queue job per step:
   - a `section` column on the item (loop migration, next free number, taken before Phase C's three); the prompt says "Implement Step 8, lines
     2002-2324; read the Status block and that step only";
   - **ownership:** today one document belongs to one job (`documentsOwnedByActiveRuns()`,
     `plan-queue-coordinator.ts:322-347`); step jobs of one plan share the document as one group owned by the run;
   - **order:** step N waits until step N-1 has landed, and branches from `main` after that landing; a failed step stops
     the later ones (they stay queued with "Waiting for Step N-1");
   - **the plan file:** each step job ticks only its own step's checklist; only the last step's job may write the
     as-built summary, and no step job renames the plan `_completed` (the coordinator refuses it at squash time);
     James or a closing session does that after the last step lands.

Tests: discovery spec for the warning; coordinator specs that a stepped plan creates one item per step, that step 2 does
not start before step 1 lands, and that a step job's `_completed` rename is refused.

As built: the refusal is implemented and tested as opt-in (`enforceSizeLimit`), but the runtime stays warning-only —
`PLAN_SIZE_REFUSAL_ACTIVE = false` in `plan-queue-plan-extract.ts` is the default of that option. After Step 3 is
verified, flipping it to `true` activates the refusal at every new-run call site; then rerun discovery/start/resume
checks and update the Status. The flag is off deliberately (coordinator checkpoint), not a deferred live check.

## Step 6. K4 item 1 early: Codex backup keep-3

`codex-state-backup-retention.ts` and its spec exist only on the follow-ups branch, which lands last. Copy those two files
to `main` as a separate small change with their wiring (find the call site on the branch with `git show`), so about 40 GB
of `~/.ai-orchestrator/codex/backups` (443 copies) is freed and 155 MB per start stops accumulating. When the follow-ups
branch lands, its worker keeps `main`'s copy (which now also carries the setting). Keep-3 was part of the storage work James approved on 10 Oct, and its first run deletes about
40 GB. James said yes to Decision 19 on 20 Oct: ship it behind a visible Storage setting ("Keep only the newest 3 Codex
backups"), default off for fresh installs, and turn it on for his install through a settings migration. Each run logs how many copies were removed
and the bytes freed.

As built for review finding 4: the early copy contains the retention policy only. Bring the follow-ups card selectors
and automatic-name producer together with their actual consumers at its landing, retaining this configured policy
and migration; keeping the early copy does not mean dropping those later consumers.

As built for verifier round 2: the two startup pruners are reconciled. `pruneCodexStateBackups` (keep 5, week age)
never removes clean-up (`state_5-before-aio-cleanup-*`) or archive (`state_5-before-aio-archive-*`) backups or
non-regular files, and reports removed/failed/bytesFreed. Startup runs exactly one pruner per run through
`pruneCodexBackupsAtStartup` (`codex-backup-retention-policy.ts`): the configured keep-3 policy supersedes the
safety net when on — stricter for every recognised reconcile copy — so the `Codex backup keep-3 run` entry equals
the run's whole filesystem delta (the livetest checks it against before/after observation), and the safety net alone
runs when the setting is off. The step list carries one 'Codex backup pruning' step. The combined startup path is
tested on the verifier's fixture (older clean-up/archive copies plus six reconcile copies) in both modes, and the
wiring has its own spec.

## Step 7. L2 items 2-4: say whether work is on `main`, and make landing blocks recoverable

1. **"On main: yes / no (commit)"** as the first line of every active plan's Status block (Step 3 adds it to the six big
   ones; add it to the other active plans by hand once). The queue updates that line itself when it lands a job (in the
   document merge, `plan-queue-doc-merge.ts`, which another session has uncommitted edits in: see ground rule 4) and when
   it parks one. Counts in status lines are pasted command output
   (for tooltips, `npm run check:ui-hints` once Phase 4 part 1 lands), never prose.
2. **Refuse a `_completed` rename at landing while "On main" would still be "no"** for work that lives on another branch
   named in the status line. Keep this a squash-time check with a spec.
3. **"Ready to review and merge"**: on the queue page (until Phase C rebuilds it), a set-aside job whose checker passed in
   an earlier round and whose branch has commits shows in its own group at the top with that label.
4. **Landing blocks name the file and retry by themselves.** "Waiting: your uncommitted change to package.json overlaps this
   job." Re-check when that file's status changes (poll its `git status` entry on the existing reconciler tick, no new
   timer), then retry the landing once.

## Step 8. L2 item 1 and H1: land the branches, in this order

**How instructions reach the worker.** A Resume carries no message (`resume(itemId)`, `plan-queue-item-flow.ts:563`;
`resume-item` at `plan-queue-coordinator.ts:460-461`), and a resumed job is merged with `main` only when it reaches
verification or landing. So, before any resume: (i) add standing guidance to `buildConflictPrompt`
(`plan-queue-prompts.ts:125-134`), which is what the worker sees when conflicts appear: "Prefer the base branch's behaviour
where both sides changed the same thing. Regenerate generated files with the repository's own generators instead of
merging them by hand (the job's plan Status block or the repository's AGENTS.md names them). Then run the repository's gates." The prompt serves every
repository, so it names no AIO command. AIO's AGENTS.md does not name its generators today, so Step 2 adds them (its
item 3). Add a prompts spec; (ii) put any job-specific instruction
(items 1 and 3 below) in that job's own plan Status block, which the worker reads first. Put the generator commands from
Step 2 item 3 in each resumed job's Status block too: a job's worktree has its own copy of AGENTS.md from its branch, so
an uncommitted AGENTS.md edit never reaches it, while untracked plans are read from the root checkout.

For each branch: (a) re-run the measurement table above; (b) Resume the job that owns the branch (see "Which job to
resume"), only once Phase A Steps 0 and 3, and this plan's Step 2 prompt change and Step 8 (i) conflict guidance, are running in
James's installed, restarted Harness (check the build commit in
Settings > About, Phase A Step 2); (c) the queue's base sync merges `main` and returns conflicts to that worker
with the guidance above; (d) the queue's checker verifies;
(e) a fresh-eyes completion gate on the branch diff, run by a new agent reading the branch read-only (`git diff
main...<branch>`), never editing the worktree; (f) let the queue land it (PASS) or, if its checker is the only blocker and
the fresh-eyes gate passed, use "Land anyway" (renamed "Merge without checks" by Phase C) with James's OK; (g) rebuild on `main`; (h) update the plan's "On
main" line and its livetest document's prerequisites.

1. **Phase 1 first.** Its job is live and owned by another session: ask that session (or James) to pause it before any
   merge, so the queue's own checkpoints and base sync cannot collide. At merge, set `ownChatContextCeilingTokens` and
   `machineContextCeilingTokens` defaults to 0 (the branch has 250,000 and 200,000 at `settings-defaults.ts:158-159`):
   machine ceilings stay 0 for good, and own chats move only after Phase D's recall check (T7). James's stored values are
   already 0. Check the branch's RLM migrations 078-080 against `main` before merging (no clash today). A12's delivery of
   Harness's guide on every path must land switched off (or keep today's behaviour) until Phase D Step 8 has cut the
   guide to its short core: today's guide sent to the sessions that skip it would add about 3.5K tokens to each, re-read
   every turn. Ask the owning session to put it behind a setting that defaults off, or write that instruction into the
   Phase 1 plan's Status block before resuming.
   *Note (20 Oct, Phase 1 session):* on the Phase 1 branch the always-on guide is `HARNESS_GUIDE`, 1,515 characters
   (about 400 tokens), only for James's own top-level sessions; the 14,080-character guide this item measured is deleted
   there. Phase D Step 8.4's 4,500-character core is therefore already met, and no off-switch was added. James asked the
   Phase 1 session to land Phase 1 itself ("I don't see another session, so merge it in").
2. **Phase 3**, then **Phase 5**.
3. **Phase 4 as one stack (H1).** Part 1 first; its plan's Status block tells the worker to resolve the five
   `shared/tooltip/` conflicts by keeping `main`'s D1 fix and dropping the branch's copy. Then parts 2 and 3, one at a time
   after part 1 has landed, with their Status blocks telling each worker to keep only template and copy changes: delete their own copies of the
   building blocks (part 2's 52-line `icon-button.directive.ts`, part 3's `mod-key-label.ts`) and use part 1's.
   Parts 1 and 2 share 46 files, 2 and 3 share 16, 1 and 3 share 11. Never queue the three in parallel again. Part 1's
   checker on today's `main` will find new debt in screens added since 10 Oct: record it in Phase F, do not fix it here.
4. **Follow-ups last.** Step 6 prepares keep-3; verify it has landed before this job. Retain its configured policy
   and migration while adding the card API and automatic-name producer with their actual consumers (Step 6 as-built
   note). Its RLM migration 081 must stay after Phase 1's 080.

Each landing is its own commit by the queue. After all seven: every plan's "On main" says yes, or the plan says why the branch
was closed instead.

---

## Final verification

The canonical seven on `main` after each landing (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`), summaries pasted into the
history file; the fresh-eyes gate (a new agent using the `task-completion-gate` skill) per landing (Step 8e) and once over
Steps 2-7, repeated with a new agent until `VERDICT: PASS`.

## Live checks

Each landed plan already has its own `_livetest.md`; this plan adds none of its own except Step 6's first keep-3 run on
James's install (create `2026-10-20-oct2-phaseB-land-built-work_livetest.md` with the standard header for it).

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file
`_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-phaseb-land-bu-863a90` — 3 commit(s), reason: verifier-unreliable.
