# Oct-2 Phase C: a plan queue that finishes its work

## Status

On main: no.

IN PROGRESS: 0/13 verified end to end. Code remains on the supplied queue branch at checkpoint
`317e0c91f`; no integration or installed-app change. The 21 October resume corrected two test defects:
optional generation typing and a deadline expectation (2,000 + 60,000 = 62,000 ms).
Fresh verification: all 116 selected files/1,497 tests pass, zero failed/pending; both typechecks,
renderer/main lint, correction-file ESLint, LOC, main/renderer builds and IPC checks pass. Generators
leave tracked output unchanged. Production bytes are unchanged by this resume. Earlier scratch receipts,
including the pending 393-file run/review15, are absent; those results are not certified here.

Steps 1–8 still need Phase A's absent guards; 13 needs its absent minimal usage log. Step 9.4 and the
semantic quiet hint need Phase B A15. Step 11 queue recycling needs the guarded reset seam; remote usage
remains unsupported. Step 12 archive/header preserves its owner's dirty register; prompt/campaign work
remains open. Step 10's post-K2 measurement and installed checks remain pending. OS inventory again
fails with EPERM; older fixture absence is unknown. Full suite, fresh independent gate, integration and
completion rename remain coordinator-owned. This is a partial handoff, not whole-plan acceptance.
Evidence: [current report](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/report.md) ·
[history](2026-10-20-oct2-phaseC-queue-that-finishes_history.md).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items L4, L5, L6, L7, L9, L10, L12, T8, T9, K3.1, K3.2,
K3.6 (rest), and T1 items 2, 4 and 6. **Programme:** [Phase A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · C (this) · [D](2026-10-20-oct2-phaseD-tokens_plan.md) ·
[E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

The plan queue does the unattended work now. Its design is sound, but it loses work in the seams. After this plan:

- a checker's "pass" is checked against test results Harness ran itself, and the checker has to say what it did not check;
- one temporary problem (all work folders busy, a missing second model) pauses the run once instead of setting aside every job;
- the queue stops picking up hundreds of copies of plans from evidence folders, and remembers what it already decided;
- each new checker round sees what earlier rounds found, and an unchanged fix is not re-checked;
- the queue page shows three tabs instead of seven stacked sections, in plain words;
- scheduled jobs get a time limit, a token cap, a proper "nothing to do" result and one fair retry after a restart;
- second opinions that are already out of date are cancelled instead of finished and thrown away;
- queue spend shows real token counts and "not priced" instead of `$0.00`.

## Scope

In: the items listed above. Not in: the per-step job split and size gate (T1 item 5, Phase B), Codex and Claude token levers
(Phase D), the screen-wide error module (Phase E). L8 is T4 (Phase A).

## Ground rules

1. **Read first.** Line numbers below are from the 20 Oct working tree; several files have uncommitted edits from other
   sessions, so trust function names over numbers. Read the whole file, its callers and specs before editing.
2. **Prove it first.** Write the named failing test, run it, and see it fail on today's code before changing code.
3. **Current checkout only.** No branch or worktree (James's rule). Anything already modified when you start belongs to
   another session: never stage, revert, reformat or `git stash` it. Stage only your own hunks, and only when James asks
   for a commit.
4. **File size** (`npm run check:ts-max-loc`): files not on the allowlist are capped at 700 lines with no slack;
   allowlisted files at their ceiling plus 50. Tight files here: `plan-queue-item-flow.ts` and `plan-queue-coordinator.ts`
   (at the cap on 20 Oct; Phase A Step 0 frees about 40 lines in each, shared with Phase A's own steps, so count before
   every edit), `automation-store.ts` 930 (limit 934), `automation-runner.ts` 763 (limit 799),
   `cross-model-review-service.ts` 932 (limit 1,011), `codex-app-server-adapter.ts` 753/754 (Step 13: one line or a new
   module), `settings.types.ts` 885/889 (new keys in a separate settings-types module). New logic goes in new modules; call-site edits are a line or two.
   If a step cannot fit, extract more first; never raise a ceiling.
5. **Loop database migrations** live in `src/main/orchestration/loop-schema.ts` (`MIGRATIONS`, `runLoopMigrations`);
   `LOOP_SCHEMA_VERSION` is 23 and is asserted in `loop-schema.spec.ts`. Phase B Step 5 takes one first; Steps 1, 3 and
   7 here each need one: take the next
   free number when built, in step order, and update the version test. RLM migrations (scheduled jobs) are in
   `src/main/persistence/rlm/`; the next free RLM number after everything queued on the Phase 1 and follow-ups branches is
   082, so check both branches (Phase B lands them) before choosing one.
6. **IPC and tool schemas:** a plan-queue tool has two definitions that must change together: the JSON `inputSchema` in
   `src/main/mcp/plan-queue-tools.ts` and the Zod schema in `packages/contracts/src/schemas/plan-queue.schemas.ts`. New IPC
   channels follow AGENTS.md's IPC rule, then run `npm run generate:ipc`, `npm run verify:ipc` and
   `npm run verify:ipc-usage`.
7. **Settings** live in seven places (`settings.types.ts`, `settings-defaults.ts`, `settings-metadata-*.ts`,
   `settings-surfacing.ts`, `settings-control-policy.ts`, `settings-validators.ts`, `advanced-settings-sections.ts`). A
   changed default reaches James's install only through a settings migration (`settings-migrations.ts`, run at
   `settings-manager.ts:205`), because his `settings.json` stores every value.
8. **Words on screen:** plain English, "Harness", no internal codes; tooltips through `appTooltip`, never a new `title=`.
   Angular: standalone, `OnPush`, `inject()`, signals, `input()`/`output()`.
9. **No browser or desktop app on the Mac.** Renderer behaviour is tested headless in Vitest with seeded stores. Anything
   that needs eyes on the rebuilt app goes into this plan's live-test document and runs on the Windows PC. If the Windows
   PC is down, stop and tell James; never fall back to the Mac.
10. **Never write to James's databases or settings from a script.** Read-only queries use `?mode=ro`.
11. **Plan hygiene (T1):** keep the Status block above under about 1,500 characters and rewrite it in place.

## Order of work

| Step | Item | Size | Needs first | Main files (new in *italics*) |
|---|---|---|---|---|
| 1 | L7 part 1: event and verdict history tables; the shared progress fingerprint | S | Phase A | `loop-schema.ts`, `plan-queue-store.ts`, *`plan-queue-history-store.ts`*, *`plan-queue-progress.ts`* |
| 2 | L4: Harness runs the gates; receipts; `not_checked` | M | Step 1 | *`plan-queue-gate-receipts.ts`*, `plan-queue-landing.ts`, `plan-queue-process.ts`, `plan-queue-tools.ts`, `plan-queue.schemas.ts`, `verify-failure-keys.ts` |
| 3 | L5: transient errors wait; run-start preflight; worker retry; restart counter | S-M | Step 1 | *`plan-queue-error-class.ts`*, *`plan-queue-run-preflight.ts`*, `plan-queue-item-flow.ts`, `plan-queue-recovery.ts` |
| 4 | L7 part 2: earlier-rounds block, no-progress skip, same-finding step-back | M | Steps 1-3 | `plan-queue-progress.ts` (from Step 1), `plan-queue-prompts.ts` |
| 5 | T1 items 2, 4 and 6: coordinator plan diet, pinned criteria, close small | S-M | Step 4 | *`plan-queue-plan-diet.ts`*, `plan-queue-prompts.ts`, `plan-queue-squash.ts` |
| 6 | L6: discovery skips copies, remembers decisions, no triage for picked documents | S | Step 1 | `plan-queue-discovery.ts`, `plan-queue-triage.ts`, `plan-queue.schemas.ts` |
| 7 | K3.1, K3.2: honest queue spend | S | Step 1 | `plan-queue-spend.ts`, `plan-queue-spend-label.ts`, `loop-schema.ts` |
| 8 | L9: the queue page | M | Steps 2-7 | `plan-queue-page.component.*`, `plan-queue-item-list.component.ts`, *`plan-queue-park-reason-help.ts`* |
| 9 | L10: scheduled jobs | S-M each | Phase B (A15 pre-check from Phase 1) for item 4 only | *`automation-run-limits.ts`*, *`automation-restart-retry.ts`*, `automation-runner.ts`, `automation-tool-impl.ts`, `orchestrator-automation-tools.ts` |
| 10 | T9: second opinions | S | none | `cross-model-review-service.ts`, `reviewer-pool.ts`, *`review-staleness-abort.ts`* |
| 11 | T8: Copilot premium requests | S | none | model picker, *`copilot-events-tail.ts`*, CLI status page |
| 12 | L12: the live-check register | S | none | `livetest-remediation-register.md`, *`scripts/next-lt-id.mjs`*, `AGENTS.md`, `plan-queue-prompts.ts` |
| 13 | K3.6 (rest): one usage line per ephemeral Codex thread, full fields | XS | Phase A Step 6 | `codex-app-server-adapter.ts` |

Steps 10 and 11 share no files with 1-9 and may run alongside them. Step 12 edits `plan-queue-prompts.ts`, like Steps 2, 4
and 5: do it after them.

---

## Step 1. L7 part 1: keep every verdict and every state change

**What's wrong.** Only the last verdict survives: `startVerification` clears it (`plan-queue-item-flow.ts:353`,
`verdict: null`), `resume()` resets round, verdict and detail (`:563-567`), and the only copy of earlier findings is the
in-memory fix prompt (`:521-522`). No table records state changes, so park history, repeated findings and restart loops
cannot be measured.

**Change.**
1. New loop migration `NNN_plan_queue_history` with two tables:
   - `plan_queue_item_events(id, item_id, run_id, at, from_state, to_state, reason, detail_head, round, tokens)`;
     `detail_head` is at most 500 characters with absolute paths stripped.
   - `plan_queue_verdicts(id, item_id, run_id, round, at, verdict, findings_json, gates_json, not_checked_json,
     worktree_head, document_sha256)`. Each finding gets a stable id: SHA-256 of its normalised title and file.
2. A small `plan-queue-history-store.ts` (insert and read only), injected into the flow beside `PlanQueueStore`.
3. Write an event on every `transition(...)` in the flow (one helper call where `transition` is defined, not at each call
   site), and a verdict row in `finishVerification` before the item moves on.
4. Read API: `listVerdicts(itemId)`, `listEvents(itemId, limit)`, used by Steps 2-4 and 8.
5. `plan-queue-progress.ts`: one progress fingerprint `{worktreeHead, documentSha256, round}`, defined here once and used by
   Step 3's restart counter, Step 4's no-progress check and Step 5.

**Tests (fail today).** `plan-queue-store.spec.ts`: two FAIL rounds and a PASS leave three verdict rows; `resume()` keeps
them. `loop-schema.spec.ts`: version bumped, tables exist after migration.

**Done when:** every round of a test run leaves a verdict row and every state change an event row.

## Step 2. L4: Harness runs the gates; the checker gets receipts and says what it did not check

**What's wrong.** The checker runs the gates itself and reports exit codes; `reportVerdict` stores them as given
(`plan-queue-coordinator.ts:480-493`) and a PASS goes straight to landing (`plan-queue-item-flow.ts:509-513`). Nothing
compares PASS with the reported gates.

**Change.**
1. **Run the gates before the checker.** In `startVerification` (`plan-queue-item-flow.ts:352-379`), after the sync and
   checkpoint and before `selectAndSpawnVerifier`, run `run.config.verifierGates` in the worktree. Put the logic in
   `plan-queue-gate-receipts.ts`, built on `runInProcessGroup` (`plan-queue-process.ts:33-101`) rather than on
   `runPostMergeGate`, which stops at the first failure and keeps no per-gate record. Run every gate; record per gate:
   command, exit code, duration, a timed-out flag (today a timeout is only text in the output), a 2 KB tail, and worktree
   HEAD. Run under the item lock, before the tree snapshot at `spawnVerifier` (`:401`), so gate side effects do not count
   as "the checker changed files".
2. **Classify output** four ways: passed, failed, no tests found, not recognised (storybloq's `classifyEvidence` shape).
   A `test:quiet` run that prints its one-line summary is "passed"; exit 0 with no summary is "not recognised".
3. **Red goes straight back.** Any failed or timed-out receipt sends the item to `toFixing` with
   `buildGateFailurePrompt` (`plan-queue-prompts.ts:135`, already used by the post-merge gate) and the tail. No checker is
   spawned for that round.
4. **Base failures don't block.** Once per base commit, run the same gates on a clean checkout of the base (the queue's own
   throwaway worktree described below, not the root). Extract a state-free key diff from `extractVerifyFailureKeys`
   (`src/main/orchestration/verify-failure-keys.ts:28`): the loop's `classifyVerifyAgainstBaseline` is tied to `LoopState`
   and cannot be called as it is. The clean base checkout is a throwaway detached worktree created through the queue's
   own worktree service (`WorktreeManager`, counted against the worktree cap), removed after the run; never the root
   checkout, and never a hand-made `git worktree add`. Mark each failing receipt "also failing on base" or "new"; only "new" blocks. Cache base
   receipts by base commit SHA.
5. **Checker prompt** (`buildVerifierPrompt`, `plan-queue-prompts.ts:176-217`): replace "Run these gates … record each
   exit code" (`:202-204`) with the receipts table and "Do not re-run a green gate unless you change files."
6. **`not_checked: string[]`** becomes required on `plan_queue_report_verdict`, in the Zod args schema
   (`plan-queue.schemas.ts:298-305`), the JSON `inputSchema` (`plan-queue-tools.ts:209-245`), `PlanQueueVerdictSchema`
   (`:80-92`) and the coordinator mapping (`:485-491`). Empty is allowed; entries that are only "TODO", "n/a" or "not run"
   are refused. The handler already parses with Zod (`plan-queue-tools.ts:268`), so a refusal returns to the checker while
   its turn is open. Update the example call (`plan-queue-prompts.ts:208-215`); `plan-queue-prompts.spec.ts:84-96` parses it.
7. **A PASS must agree with the receipts.** In `finishVerification`, refuse a PASS while any receipt for the current HEAD is
   red and "new"; count it as a FAIL with the finding "Harness's own gate run failed: <command>".
8. **Load.** The canonical gates take up to 15 minutes each and up to five jobs can verify at once, which is enough to trip
   the host-overload watchdog. Run gate sets through one queue-wide slot (one job's gates at a time, others wait with
   "Waiting to run checks"), honour the existing load gate before starting, and reuse a job's receipts when its worktree
   HEAD is unchanged since they were taken.

**Tests (fail today).** `plan-queue-coordinator.spec.ts`: a PASS with a red "new" receipt is not landed. A red receipt sends
the item to fixing without spawning a checker. `plan-queue.schemas.spec.ts`: missing `not_checked` and `["TODO"]` refused.
New `plan-queue-gate-receipts.spec.ts`: per-gate records, timeout flag, base classification.

**Done when:** a PASS with an unexplained red receipt is refused by code, and the job card can show "Passed. Not
checked: …" (Step 8 renders it).

## Step 3. L5: one failure no longer sets aside the whole queue

**What's wrong.** `startItem` parks on any preparation error (`plan-queue-item-flow.ts:120-127`; the same at `:158-161` on
resume), so one condition true for every job (worktree cap, missing second model, account fence) sets aside job after job.
The global cap (`worktree-manager.ts:110-121`, default 5 from `worktree.types.ts:181`) is invisible to the queue's per-run
count (`plan-queue-coordinator.ts:543`). Checker selection runs only at verification time (`selectAndSpawnVerifier`,
`:381-390`), after the worker has spent a round. A failed worker turn is parked at once (`:279`, `:305-307`). Nothing counts
restart resumes (`recoverItem`, `plan-queue-recovery.ts:60-96`).

**Change.**
1. `plan-queue-error-class.ts`: classify preparation and spawn errors as `transient-capacity` (worktree cap, resource
   governor, load gate, provider concurrency, provider at capacity) or `this-job`, by error type or code, with message
   matching only as a fallback that its spec pins. A transient error returns the item to `queued` with back-off
   (30 s, 2 min, 5 min) and the detail "Waiting for a free work folder (5 in use)".
2. The scheduler asks for free global capacity before starting a job: expose `availableWorktreeSlots()` on
   `PlanQueueWorktreeService` from the manager's `getAllSessions()` and `getConfig().maxConcurrent`. Remember `reattach()`
   creates no manager session (`plan-queue-worktree.ts:122+`), so count queue worktrees separately.
3. After two identical `this-job` errors in a row across different jobs, pause the run once: "Paused: every job fails with
   the same error: <plain reason>. Fix it, then press Resume."
4. `plan-queue-run-preflight.ts`: at run start and on any routing change, resolve the checker
   (`selectPlanQueueVerifier`, injectable through `VerifierSelectDeps`), worktree capacity and account fences once. On
   failure, refuse to start (or pause a running run) with the reason and a link to the setting.
5. Worker turn retry: on a transient failure (allow-list only: transport closed, provider 5xx, adapter not spawned,
   timed out waiting for the turn to accept), retry once after 15 s and once after 45 s in the same session with "Finish
   the item with a real result." Deterministic failures are parked as today.
6. Restart counter: a `restart_resumes` column (or derived from Step 1's events) incremented in `recoverItem`, reset when a
   round completes. Three in a row parks the item as `restart-loop` ("Restarted 3 times without progress") with Retry.
   Uses Step 1's progress fingerprint so "no progress" is defined once.

**Tests (fail today).** Coordinator spec: five items, cap reached → none parked, all wait. Two identical prep errors → run
paused once, third item untouched. Preflight with no diverse checker → run refused before any worker spawns. Recovery
spec: three restarts without a round → `restart-loop`.

**Done when:** a forced worktree-cap condition leaves every job queued, and a forced "no checker" refuses the run at start.

## Step 4. L7 part 2: memory between rounds

**Change.**
1. Uses Step 1's progress fingerprint.
2. Rounds 2 and later: `buildVerifierPrompt` gains an "Earlier rounds" block of at most 12,000 characters from Step 1's
   verdict rows: each earlier finding with the worker's claimed fix or dispute, marked "unconfirmed, re-check", plus
   `git diff <last checked commit>..HEAD --stat` and the instruction to read that diff. The whole-diff read stays.
3. If HEAD and document hash are both unchanged since the last FAIL, do not spawn a checker. Re-prompt the worker once:
   "Nothing changed since the last check failed. Fix each finding or explain with file:line evidence why it is wrong."
   Still unchanged: park as `no-progress`.
4. Same finding id failing twice: add a three-line step-back note to the fix prompt ("Reproduce it and find the cause; if
   the finding is wrong, say so with evidence"). Surviving a third round would park as `stuck-on-same-finding`. Ship this
   log-only for a week (an event row, no park), then switch it on.
5. A new run on a document that already has a set-aside branch offers "Resume the set-aside job" instead of a new item
   (coordinator `startRun`, item creation at `:343-352`).

**Tests (fail today).** Prompts spec: round-2 prompt contains earlier findings and stays under 12,000 characters for the
block. Flow spec: unchanged HEAD and hash → no checker spawned, worker re-prompted once.

## Step 5. T1 items 2, 4 and 6: the coordinator keeps plans small

**Change.**
1. **Diet at checkpoint (item 2).** `plan-queue-plan-diet.ts`: at each checkpoint, if the document grew by more than 8 KB
   since the job started or holds more than one status block, move every dated section under the as-built heading into
   `<stem>_history.md` beside the root checkout's copy (never on the job's branch; see Phase B Step 2), leave a one-line pointer, and log bytes moved. Move, never delete. Compare the root
   copy's hash just before writing and skip (and log) if it changed meanwhile, because James and other sessions edit the
   same file.
2. **Pinned criteria (item 4).** When the job starts, store the plan's SHA-256 and its unchecked `- [ ]` items. Give the
   checker "Document changes since this job started" (`git diff <start>..HEAD -- <plan>`), so a deleted or reworded
   unchecked item is visible.
3. **Close small (item 6).** At a `_completed` rename made by a queue job, move journal sections to
   `<stem>_history_completed.md` and keep an as-built summary of at most about 3 KB. This applies only to plans completed
   from now on; existing `_completed` files are closed and are never edited.
4. `_history` is added to `ACTIVE_DOCUMENT_RE` in Phase A Step 0; this step relies on it.

**Tests (fail today).** New diet spec: a plan with three dated as-built sections → sections moved, pointer left, bytes
equal across the two files; a concurrent hash change → no write.

## Step 6. L6: discovery finds only real plans and remembers what it decided

**What's wrong.** `SKIPPED_DIRS` is fixed names only (`plan-queue-discovery.ts:26-36`); discovery walks up to 5,000 `.md`
files and filters by glob afterwards (`:78-95`, `:145-152`); `readHeader` reads the whole file for 40 lines (`:97-104`).
The glob is never saved on the run (used once at `plan-queue-coordinator.ts:320`). Every run re-triages unchanged documents.

**Change.**
1. Skip directories whose names contain `snapshot`, `evidence`, `observation` or `receipts`, and any plan folder nested
   inside another plan folder. Honour a per-repository `.planqueueignore` (gitignore syntax).
2. `readHeader` reads only the first 16 KB.
3. Save the glob as an optional field of `PlanQueueRunConfigSchema` (stored in `config_json`; no migration). Show
   "N documents found (M look like copies, hidden)"; above 25 documents the start form asks for confirmation. Add "Skip all
   not started".
4. Remember triage decisions and answers by SHA-256 of the document plus its linked spec (a small table in Step 1's
   migration, or a column on the events table). Unchanged → reuse with "Already decided on 14 Oct". Items of a cancelled
   run are "not reached", not "skipped".
5. A run whose glob is one non-wildcard path skips model triage: run the deterministic readiness checks and queue it. The
   worker can still ask through the existing "needs James" path.

**Tests (fail today).** Discovery spec: an `evidence/2026-10-01/docs/plans/x_plan.md` copy is not found; `.planqueueignore`
honoured. Coordinator spec: a single-path run never calls triage.

## Step 7. K3.1 and K3.2: honest queue spend

**What's wrong.** `plan-queue-spend.ts:21` records `inputTokens + outputTokens` only (cache reads and writes missing, about
20 times low); `:24` turns an unpriced call into `0`; the role (`metadata.planQueueRole`, `:19`) is not stored.
`plan-queue-spend-label.ts` prints `$0.00` for that zero.

**Change.**
1. Store processed tokens (input + cache read + cache write) and output separately; keep `costUsd` null when unknown.
2. New `plan_queue_spend(item_id, run_id, role, round, provider, model, processed, output, cost_usd, cost_basis)` table,
   modelled on `loop_run_spend` (`loop-schema.ts:426-433`), in the next loop migration.
3. "Exact" only when `costSource` is `provider` or `free` (`model-call-recorder.ts:16-23`). Check first whether the Codex
   adapter reports its own estimate as `usage.cost`, which would make it look "provider"; if so, label it estimated.
4. Labels: "$379.93 known · 17.2M tokens not priced"; averages only over known costs; never `$0.00` for unknown.

**Tests (fail today).** `plan-queue-spend.spec.ts`: an unpriced call stays null and its tokens are counted; a new spec for
the label.

## Step 8. L9: a queue page James can read at a glance

**What's wrong.** Seven stacked sections, with "Reconciler alerts" always shown
(`plan-queue-page.component.html:6-99`); up to 50+ full run cards (`src/renderer/app/core/state/plan-queue.store.ts:134`); raw `item.detail` up to
about 3,000 characters with `/Users/` paths (`parked-list.component.html:16-18`); internal words ("Land anyway",
"Reconciler alerts", "livetests", "Glob", "(s)" plurals); labels that point the wrong way (`PARK_REASON_LABELS`,
`plan-queue-item-list.component.ts:25-36`); a missing document parked as `worker-error` (`plan-queue-readiness.ts:118`).

**Change.**
1. Three tabs: **Now** (questions, running and paused runs, Start a run), **Set aside** (grouped by document, newest attempt
   first, older ones folded as "2 earlier tries"; Phase B's "Ready to review and merge" group stays at the top of this
   tab), **Setup** (providers and accounts). Finished runs fold into "History (N)", one line each.
2. `plan-queue-park-reason-help.ts`: `PARK_REASON_HELP: Record<PlanQueueParkReason, {label, meaning, next, actions}>`,
   replacing `PARK_REASON_LABELS`; the `Record` type keeps it exhaustive. Show meaning and next step under the label and
   only the buttons that apply ("Choose a checker" for an account conflict; "See what the checker found" before Resume on
   a round limit). Correct labels: `verifier-unreliable` → "The checker stopped without giving a verdict";
   `no-diverse-verifier` → "No second model is allowed to check this" plus the reason; `round-limit` → "Ran out of rounds
   (3 of 3)" plus the last finding.
3. New reasons from this plan (`no-progress`, `restart-loop`, `stuck-on-same-finding`, `missing-document`; plus help text
   for `stopped-by-harness`, which Phase B Step 5 creates) are added to the enum (`plan-queue.schemas.ts:33-44`) with their help entries.
   `park_reason` is plain text, so no migration.
4. Fold `detail` behind "Details" and strip absolute paths. Relabel the 355 historical triage rows "Couldn't check
   readiness (old classification step)" by matching their stored detail in the presenter, not by rewriting data.
5. Words: Parked → "Set aside"; Land anyway → "Merge without checks"; Glob → "Which files (pattern)"; real plurals.
6. Bulk actions only through a preview: "Resume all N set aside for this reason" lists will change / left alone (with
   reason) / not applicable, then one confirm. No bulk "Merge without checks" or Discard.
7. Hide the alerts section when empty; link the housekeeping "Leftover work folders" card instead of a second list.
8. Show Step 2's "Passed. Not checked: …" and receipts on the item card.

**Tests.** Page, parked-list, item-list and store specs: tabs render; empty alerts hidden; a 3,000-character detail with a
`/Users/` path is folded and stripped; every park reason has help text (a spec iterating the enum).

**Live check (deferred):** the rebuilt page on the Windows PC, with a seeded queue store shaped like James's history
(runs, set-aside jobs, long details); never by scripting against his real data.

## Step 9. L10: scheduled jobs

**What's wrong.** No run time limit anywhere in `src/main/automations`. A restart marks every running run failed and
clears a one-time job's next run (`automation-runner.ts:128-136`, `automation-store.ts:686-724`), with no retry. A run
"succeeds" at the first idle after any output (`automation-runner.ts:413-415`). `update_automation` accepts effort up to
`ultra`/`workflow` and auto-approve from any session (`orchestrator-automation-tools.ts:203-208`,
`automation-tool-impl.ts:327-346`), and its handler does not even receive the caller (`:494-502`).

**Change.** Each part is independent; build in this order.
1. **Time limit (Decision 17).** Per-job `maxRunMinutes` in `AutomationAction` (rides in `action_json`; Zod in
   `automation.schemas.ts`). New jobs default to 90 minutes; existing jobs get 1.5 times their longest successful run
   (minimum 30), set by a one-off RLM data migration. On expiry, cancel the session and its children, keep the output so
   far, and finish the run as failed with `{retryable: false}` and "Stopped after N minutes". Timer logic in
   `automation-run-limits.ts`, armed in `trackInstance` (`automation-runner.ts:326`).
2. **Token cap (Decision 17).** Stop a run past N processed tokens (30M recurring, 100M one-time by default), recorded as
   "Stopped: token cap", using the same tracker.
3. **Restart.** Replace the bare `failRunningRuns` call with `automation-restart-retry.ts`: mark the run "Interrupted by an
   app restart" (reuse `output_summary` or a new column; the status `CHECK` constraint lists only six values, so a new
   status needs a table rebuild: avoid it). For enabled, unchanged jobs whose action is an agent prompt: one fresh retry
   with "The previous run was cut off by a restart; check what it already did before continuing." Restore a one-time job's
   next run for that retry. Do not count it towards the failure streak (`automation-store-outcome-ops.ts:34-57`). Never
   replay system actions or anything that already delivered.
4. **Quiet result.** After Phase B lands A15, register an `automation_result` tool (`{outcome: no_change | done |
   needs_attention, notify}`) from the first turn of every automation session. A run ending with neither a result nor any
   text is a failure. Never decide failure from prose. The Automations page greys out quiet runs.
5. **No escalation by agents.** Thread `callerInstanceId` into `update_automation` as `create_automation` already does
   (`:367-369`). An agent caller may not raise model tier, effort or auto-approve above its own session's; return a
   teaching refusal. Clamp agent-set effort at `max`. The human form is unrestricted.
6. **Cheaper models where they fit.** New "check"-style jobs default to Sonnet at low effort; suggest it on monitors whose
   last 10 runs were quiet (a dismissible hint, not an automatic change).
7. **Slow down while nothing changes** (opt-in per job): double the interval while normalised output is unchanged (times,
   dates, durations and ids stripped), cap at 4 times nominal, snap back on change. Show "Next check in 40 min (no change
   for 3 checks)".

**Tests (fail today).** `automation-runner.spec.ts`: a run past its limit is stopped and not retried; a restart leaves an
"interrupted" run with one retry scheduled and a restored one-time next run. `automation-tool-impl.spec.ts`: an agent
raising effort above its own is refused.

**Done when:** no run can pass its limit, a restart leaves "interrupted, will run again" rows, and quiet runs are greyed.

## Step 10. T9: second opinions

**What's wrong.** Stale reviews are discarded only after both reviewers finish (`cross-model-review-service.ts:347-368`);
`cancelPendingReviews` (`:880-900`) also clears history and buffers, so it is not a drop-in. A reply that fails schema
validation twice returns null (`:628-631`) without `recordFailure`, so `reviewer-pool.ts` never retires a reviewer that
keeps failing that way.

**Change.**
1. `review-staleness-abort.ts`: when a newer user turn arrives for an instance (subscribe to the busy transition in
   `instance-event-forwarding.ts:440-479`, because `bufferMessage` ignores user messages), abort only that instance's
   pending review controllers.
2. Count schema-validation failures per reviewer per local day; after two, skip that reviewer for the rest of the day.
3. The daily count already shows in review settings ("Used today: N of 20", `review-settings-tab.component.ts:61-63`).
   Add it to the indicator tooltip as "Second opinions today: N of 20".
4. After K2's restart, measure Copilot premium requests per review (one read-only query; result into the history file).

**Tests (fail today).** Service spec: a newer user turn aborts the pending review before reviewers finish. Pool or service
spec: two validation failures retire the reviewer for the day.

## Step 11. T8: Copilot premium requests (Decision 5)

**Change.**
1. Wherever Opus can be picked for Copilot (chat model picker, account defaults), the option reads "Opus 5.5 · 15 premium
   requests each", and a Copilot chat shows "Premium requests used: N". Harness-started Copilot work keeps the 1-unit
   models it already uses; add a spec that pins that default.
2. `copilot-events-tail.ts`: a read-only tail of the session's `events.jsonl` for exactly `session.usage_record` /
   `session.usage_checkpoint`, `session.compaction_complete` and `session.shutdown`, keeping numbers only. Recycle a loop
   or queue session when a compaction leaves it above 90% of its limit.
3. CLI status page and loop preflight: "Copilot below 1.0.100 may stall for minutes on a hung tool server."

**Tests.** Picker spec for the label; tail spec on a fixture file (numbers only, no message text retained).

## Step 12. L12: the live-check backlog and its 1 MB register

**What's wrong.** `docs/plans/livetest-remediation-register.md` is 1,058,876 bytes and 13,260 lines; the index runs from
line 116 to about 323 and detail sections are not in numeric order. AGENTS.md (line 101) points at
`2026-07-19-livetest-failure-remediation-followup_plan.md`, a name that no longer exists (the file is `_completed`, closed).

**Change.**
0. The register has another session's uncommitted edits (20 Oct): wait for that owner to commit, or agree the move with
   them, before restructuring it.
1. Move closed entries' detail sections to `livetest-remediation-register-archive-2026.md`, keeping every index row. Add
   one line at the top of the archive and in AGENTS.md: agents do not read the archive unless an index row points there.
   Before moving, confirm the register is a standing register (exempt marker) rather than a lifecycle document.
2. `scripts/next-lt-id.mjs`: prints the next id from the maximum numeric id in the index (LT-707 today), never from the
   last heading. Point the runbook and the queue's livetest prompt (`plan-queue-prompts.ts:101`) at it.
3. AGENTS.md (line 101) points at a plan that no longer exists, and the plan the register header names
   (`2026-10-05-livetest-campaign-defects`) is closed too; no live remediation plan exists. Reword AGENTS.md: "The
   register's index row is the defect's status; implementation notes go in the plan or livetest document that fixes it."
   Make the same change to the register header and the runbook. Never edit the closed plans.
4. After Phase B lands the October work, queue a weekly live-check campaign on the Windows PC, starting with the October
   plans' livetests.

**Tests.** A small spec for `next-lt-id.mjs` on a fixture with out-of-order sections.

## Step 13. K3.6 (rest)

Phase A Step 6 writes a minimal usage line per ephemeral Codex thread so T2 can be measured. Here, extend it to the full
field list (thread, job, kind, trial arm, requests, tokens, helpers, compactions, duration) and read it from the Costs page.

---

## Final verification

Run, in order, and paste the summary lines into the history file (not here):

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
```

Then the fresh-eyes completion gate: a new agent that did not implement the work runs the `task-completion-gate` skill
over the diff and this plan. Fix every actionable finding and repeat with another fresh agent until `VERDICT: PASS`.

## Live checks

Anything needing the rebuilt app goes into `2026-10-20-oct2-phaseC-queue-that-finishes_livetest.md` (create it with the
standard remediation header) before this plan is renamed. Expected entries: the queue page on the Windows PC (Step 8); a
real run with a forced worktree cap (Step 3); a scheduled job stopped by its time limit, and one restart with an
interrupted run (Step 9); one week of the same-finding rule in log-only mode before it is switched on (Step 4).

## Finishing

When every step is built and verified: rewrite the Status block as an as-built summary of at most about 3 KB, move any
deferred checks to the livetest document, rename the history file `_history_completed.md`, then rename this file
`_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasec-queue-t-cf5944` — 1 commit(s), reason: worker-error.
