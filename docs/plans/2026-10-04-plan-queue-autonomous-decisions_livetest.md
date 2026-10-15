# Plan Queue autonomous decisions: installed-app adoption

Status: pending installed-app verification.

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

## Status — 2026-10-04

Open: 1 (check 2's panel observation) · Closed: 1 (check 1) · Failed: 0.
