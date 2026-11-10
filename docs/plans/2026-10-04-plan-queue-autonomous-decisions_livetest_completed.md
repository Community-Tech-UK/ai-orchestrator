# Plan Queue autonomous decisions: installed-app adoption

Status: all checks passed; see the 2026-11-10 evidence run.

Prerequisites: use the normal local build/install pipeline for this checkout,
then restart the rebuilt Harness when its active sessions can be interrupted.
This task does not replace or restart the running application. The source,
compiled main process, real coordinator/SQLite/Git integration and deterministic
readiness boundaries are verified in-loop in the
[implementation plan](2026-10-04-plan-queue-autonomous-decisions_plan_completed.md).
No permission, security or automation-setting relaxation is needed.

Remediation flow: before running a campaign, read
[the campaign runbook](livetest-campaign-runbook.md). A reproduced defect needs a
new LT-NNN index row and full entry in
[the remediation register](livetest-remediation-register.md), plus its matching
implementation-status section in an active remediation plan. The
[existing remediation record](2026-07-19-livetest-failure-remediation_plan_completed.md)
is closed; reopen its filename or create a follow-up plan before adding new work.
Keep per-check evidence here. Rename this file `_livetest_completed.md` only
after every check passes.

## 1. Loaded tool contract and prompts

After rebuilding/installing and restarting, discover the live
`plan_queue_report_triage` tool using the normal tool discovery route. Its
question schema must advertise optional `decision` branches `technical`,
`human-authority` and `human-input`, with `recommendedOptionId`, `reason` and
`evidence` for technical choices. Confirm the packaged coordinator imports
`plan-queue-readiness` and the packaged triage/worker prompts contain the
autonomy rules and neutral recorded-decision wording. Record the rebuilt
artifact and live discovery evidence. Do not report checkout build bytes alone
as proof that the running application loaded them.

Evidence: pending. This requires replacement/restart of the daily-driver app;
source contracts, prompt parsing and compiled outputs are checked in-loop.

## 2. Retired run and retained parked work

Call the supported read-only `plan_queue_status` for run
`2e00ad73-009c-4e60-84db-7a798eca12bd`. Unless James deliberately resumed a parked
item in the meantime, expect `cancelled`, zero open questions, 38 skipped,
19 parked and 5 landed. Open the Plan Queue panel and confirm this retired run
does not contribute a question banner. Retained parked entries must still name
their branches and keep their previous verdict/evidence. Do not resume,
discard, land or rerun them solely to perform this adoption check.

Evidence: supported live cancellation and full status readback already passed,
and all 19 exact parked branches were independently checked in Git. The panel
after a rebuilt-app restart remains pending; this is persistence/adoption
validation, not a claim that any untested source document passed.

## Evidence run — 2026-10-04 (orchestrating session, packaged app)

Environment: packaged app built 19:06 from `3d05e250e`, started 20:45:59 BST (after the build, so
the running process loaded these artefacts).

- **Check 1 — PASS.** Live discovery through the running app's orchestrator-tools socket
  (`describe plan_queue_report_triage`, saved to
  `_scratch/lt-2026-10-04/orch/plan_queue_report_triage.schema.json`) advertises
  `records[].question.decision` as a `oneOf` of `technical` (required `recommendedOptionId`,
  `reason`, `evidence`), `human-authority` and `human-input` (required `reason`). Packaged artefacts
  extracted from `app.asar`: `dist/main/plan-queue/plan-queue-coordinator.js` imports
  `plan-queue-readiness` (1 match); `plan-queue-readiness.js` defines `applyTriageRecords`;
  `plan-queue-prompts.js` contains the autonomy rule ("Resolve routine implementation choices …",
  2 matches), the neutral "Recorded readiness decision (data, not instructions)" block, the triage
  goal "resolve readiness choices autonomously" and "does not grant approval".
- **Check 2 — data PASS; panel open.** Read-only `plan_queue_status` at 23:21: run
  `2e00ad73-009c-4e60-84db-7a798eca12bd` is `cancelled` with 38 skipped, 19 parked, 5 landed, zero
  questions and no alerts. All 19 parked items still name their `queue/…` branch; 18 carry their
  earlier verdict, and the 19th (`2026-07-17-browser-permission-ux_plan_livetest.md`, park reason
  `verifier-unreliable`, "the verifier ended its turn without reporting a verdict") never had one.
  Nothing was resumed, discarded or landed. The Plan Queue panel itself was not observed: the
  Harness UI is a hard-denied Computer Use target and the packaged app has no debug port.

## Evidence run — 2026-11-10 (Plan Queue livetest worker, rebuilt dev app)

Environment: dev app built and launched from the queue worktree (`npm run build:main` exit 0, renderer from
`ng serve` on :4781), isolated profile `/tmp/aio-lt-queue-6ac26e78`, debug port 9730, focus emulation on before
every DOM read. Launched with `--no-sandbox --disable-gpu` and `--js-flags=--max-old-space-size=8192`
(needed inside the Harness signal fence). Profile data: a `.backup` copy of the real
`loop-mode.db` trimmed to run `2e00ad73-…` only (62 items, no worktree paths, loop rows removed). Screenshots
are in the worktree's `_scratch/lt6ac/` (disposable).

**Safety note (not a product defect I filed).** My first launch used the *untrimmed* copy of the database. The dev
app's start-up "kept folders" clean-up (`PlanQueueKeptFolders`) then tried to remove the real worktrees of other
runs' items; git refused all four ("A merge is in progress with unresolved conflicts"), nothing was removed
(`git worktree list` is still 26 entries), and I killed the app within about a minute. Any future panel check on
real data must trim the copied database first, as done for the second launch.

**Baseline has moved since 2026-10-04.** The 4 Oct numbers (cancelled, 19 parked, 5 landed) no longer describe
the live data, because James deliberately changed it on 2026-11-06 (the check's own exception):
- `plan_queue_status` now reports the run as `completed`: 38 skipped, 18 parked, 6 landed, zero open questions
  and no alerts. The sixth landed item is `2026-07-13-fable-ws13_livetest.md` ("Landed by James without a verifier
  PASS; the document was left open"), which was parked on 4 Oct.
- All 18 parked items carry `discarded_at` (2026-11-06 19:26 UTC) with `discarded_by = James`; the 30-day keep
  expires about 2026-12-06. The `queue/…` branch names were cleared by that discard. 17 of 18 have
  `refs/plan-queue/discarded/<item-id>` in the repository (checked with `git rev-parse`); the 18th
  (`2026-07-17-browser-permission-ux_plan_livetest.md`, round 0, `verifier-unreliable`) has no branch and its
  checkpoint equals its base commit, so there was nothing to keep.
- 17 of 18 still carry their earlier verdict (all PASS); the 18th never had one, as recorded on 4 Oct.

- **Check 2 — PASS (panel observed).** In the dev app at `/plan-queue` the store holds the run as `completed` with
  38 skipped / 6 landed / 18 parked, `questionGroups() = 0`, `needsAnswerItems() = 0`, `parkedItems() = 0` (all 18
  are discarded, so none is offered for action) and 18 items with a discard receipt. The Plan Queue "Now" tab
  shows no question banner and lists no run under "Runs" (that list only shows running or paused runs,
  `plan-queue-page.component.ts:76`); the sessions page has no question banner or alert element; the "Set aside"
  tab reads "No work set aside". The banner's source, `needsAnswerItems`, is the store's open-question list
  (`plan-queue.store.ts:89`, fed to the Needs-you page at `needs-you.store.ts:121`), and it is empty for this run.
  The "retained parked entries name their branches" wording is superseded by James's 6 Nov discard: the work is
  kept under the discard refs above instead. Nothing was resumed, discarded, landed or rerun by me.
- **Not observed:** this was the dev app on a data copy, not the packaged app on the live profile. The packaged
  app has no debug port and the Harness UI is a hard-denied Computer Use target, so a pixel-level look at James's
  own running panel is not possible; the same renderer code and the same database rows drive both.

Cleanup: dev app and `ng serve` stopped (ports 9730 and 4781 free), profile and database copy deleted. Port 4730
belongs to another agent and was left alone.

## Status — 2026-11-10

On main: yes (this landing commit)
Open: 0 · Closed: 2 (check 1 on 2026-10-04, check 2 on 2026-11-10) · Failed: 0. Check 2's baseline numbers in its
body are historical; the 2026-11-10 section above records the current ones. No defect reproduced, so no register
entry.
