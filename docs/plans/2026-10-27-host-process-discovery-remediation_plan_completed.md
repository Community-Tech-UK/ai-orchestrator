# Host process discovery follow-up

On main: code only (hand-merged 5 Nov 2026, commit `4e0bd43c8`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Work complete and ready for independent verification (resume of 2026-11-26). The two description
edits and both catalog regressions are in this branch and on main (`4e0bd43c8`). Live checks are
closed in [the follow-up live check](2026-10-27-host-process-discovery-remediation_livetest_completed.md):
LT-A1 installed Claude discovery passed 2026-11-07, LT-A3 two-session repetition passed 2026-11-11.
Resume checks: four targeted specs 25 tests passed, `tsc --noEmit`, `typecheck:spec` and `lint:fast`
exit 0. Open for the coordinator only: a fresh full-suite pass (earlier exit 1 was a pause-control
timeout that did not reproduce alone) and the independent review. History: [round evidence](2026-10-27-host-process-discovery-remediation_plan_history_4ddfc8f0df6b395c7d803cae56c373798b1cbcc2bb14c07b60d92c362885b7f6_completed.md).

Owner evidence: [host-process/fence live test](2026-10-16-host-process-tools-and-fence-switch_livetest.md).

## Required result

Searching orchestrator tools for `process` must discover both host-process tools. Keep process
ownership/refusal rules and all signal-fence protections unchanged.

## Implementation and verification

- [x] Reproduce through the real rebuilt stdio forwarder: `process` returned only settings and
  git tools, not the host-process listing or cleanup tool. Preserve failure receipts.
- [x] Include the singular word `process` naturally in both tool descriptions; the existing
  whole-word ranker remains unchanged.
- [x] Verify the corrected live stdio discovery, then add regression coverage for actual tool
  catalogs on both deferred and stable tool surfaces. No existing test expectations are weakened.
- [x] Repeat LT-A1 from a fresh fenced Claude session and LT-A3 from two real live sessions.
  LT-A1 installed discovery passed 2026-11-07; LT-A3 installed two-session repetition passed
  2026-11-11. Evidence is in
  [the follow-up live check](2026-10-27-host-process-discovery-remediation_livetest_completed.md).
- [x] Run worker targeted tests, type checks, lint, size/UI-hint checks, generators and builds;
  preserve command receipts. See the dated worker notes below.
- [ ] Coordinator: run the full suite and fresh independent review. The queue worker must not
  run the full suite or rename this plan. Remaining live authority limits are recorded in the
  owning live-test document and follow-up live check.

The normal focused suites are run before edits. The main risk is tool-search ranking; exercise
the real complete catalog and default search limit, rather than only testing a description string.

## As-built notes — 2026-10-27

- Two shared description strings changed; no ranker, schema, caller, ownership or fence logic changed.
- Added two full-catalog/default-limit regression cases, one for each tool surface. Existing tests
  are unchanged. Actual rebuilt stdio search and fresh Claude CPU listing assertions passed.
- LT-791 is filed with an index row and full defect section in the worktree register. The older
  Settings route exception (LT-723, identifier reconciliation still required) is separate and open.
- All canonical fast gates passed in the worker and again independently. The first full suite
  failed in the unchanged SEA repeatability suite under the default runtime. That suite also
  failed alone, then passed with explicit Node 24.22.1 and pinned child PATH. Binary inspection
  confirmed Homebrew Node 26 lacks the required SEA fuse. Retain the first failed receipts;
  do not call that full run green. Independent full rerun with the pinned runtime is in progress.
- Evidence: root-checkout `docs/plans/evidence/2026-10-27-host-process-tools-retry/`.
- Plan remains untracked and active under the task's no-rename rule. No completed plan was expanded.

## As-built notes — 2026-10-31 queue worker

- Ruling: the October 27 notes describe the previous live-test branch, not the current queue
  checkout. Its two description edits and regression cases were absent here. Reapplied the
  same minimal remedy in this checkout rather than treating the checked boxes as source evidence.
  There is no linked specification; the required result above and owning live-test document
  supply acceptance criteria. No additional branch, worktree, commit or dependency install.
- Baseline focused tests passed. Added full-catalog/default-limit cases to the deferred and
  stable suites, then observed both fail with only `set_setting` and `git_batch_pull` returned.
  Rebuilt the real executable before editing descriptions and reproduced that same omission
  on both stdio surfaces. Failure reports and before/after receipts are retained.
- The shared listing description now says "CPU and memory use for each process"; the cleanup
  description says "re-checks every process at call time". Schemas, handlers, ranking and signal
  protections have no diff. Both catalog regressions pass, including deferred reveal and stable
  invocation instructions. Expanded focused tests cover tool forwarding and inspector refusal
  rules. The rebuilt executable discovers both tools and successfully lists real host processes
  through this worker's authenticated parent connection on both surfaces.
- The installed executable still returns only settings/Git matches for singular `process`.
  This is a fresh installed-binary probe, not a fresh fenced Claude-session pass. No installation,
  Harness restart or fence change occurred; this is not a successful installed integration.
- Re-read the prior Claude/sibling receipts, including the exact refusal, presence afterwards,
> Earlier journal sections moved to `2026-10-27-host-process-discovery-remediation_plan_history_4ddfc8f0df6b395c7d803cae56c373798b1cbcc2bb14c07b60d92c362885b7f6_completed.md`.
## As-built notes — 2026-11-03 queue worker

> Earlier journal sections moved to `2026-10-27-host-process-discovery-remediation_plan_history_4ddfc8f0df6b395c7d803cae56c373798b1cbcc2bb14c07b60d92c362885b7f6_completed.md`.
## As-built notes — 2026-11-03 queue worker, verifier round 2 remediation
> Earlier journal sections moved to `2026-10-27-host-process-discovery-remediation_plan_history_4ddfc8f0df6b395c7d803cae56c373798b1cbcc2bb14c07b60d92c362885b7f6_completed.md`.
## As-built notes — 2026-11-07 resume
> Earlier journal sections moved to `2026-10-27-host-process-discovery-remediation_plan_history_4ddfc8f0df6b395c7d803cae56c373798b1cbcc2bb14c07b60d92c362885b7f6_completed.md`.
