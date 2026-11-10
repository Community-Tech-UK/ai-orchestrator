# Human/external live-test review corrections

On main: code only (hand-merged 6 Nov 2026, commit `83465362e`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Updated 10 November 2026. Active; no completion claim, no rename.
- Done: all code is on main (`83465362e`) and present in the queue worktree base. Round-7 worker
  reran the three changed spec files (36 tests pass) and `npm run checks` (all 7 gates exit 0).
- Next: the only unticked plan item is the coordinator's independent acceptance decision.
- Remaining live work (human or external only) is in the
  [live follow-up](2026-10-27-human-external-review2_livetest.md): RES-002 persistence on a rebuilt
  coordinator, the two synthetic CAPTCHA Skips, and RES-020 Copilot timeout.
- Open: the Sentry sender role is wider than send-only (read-only finding, no change made).
  Campaign tally unchanged: 28 groups unmet, none newly closed, one retired.
- Evidence: round-7 notes in `2026-10-27-human-external-review2_plan_history_f17ccf84ae23206b890a51a25e6a7af5bf25986a7f907b839f084bcc4bd5ffd8_completed.md` (root, untracked).

Owner: [live checks](2026-09-27-livetest-human-external-residuals_livetest.md).

## Current recovery handoff — 6 November 2026

Status: **active as instructed; the timed queue gate passed; the three identified technical
reruns have current evidence; coordinator acceptance review remains pending**. No commit or completed-name rename is authorised for
this correction round. The live campaign remains separately open.

The current round-6 independent verifier ran all seven queue checks against this
checkout's current HEAD. Both typechecks, lint, the TypeScript size check, both
builds and the ordinary full test suite returned exit 0. The full test command
took 532,635 ms (8.88 minutes), below the unchanged 45-minute bound; its complete
raw report contains 38,707 passed assertions and five existing skips, with no
unfinished assertions. `round6-recovered-verdict.receipt.json` retains the exact
verdict and gate receipts; `round6-timed-gate.receipt.json` cross-checks the source
revision and raw report hashes. The independent verdict still failed on the two
acceptance/documentation findings being addressed here, not on a test timeout.

The timeout investigation below is historical. Its later-resolution statements
are superseded by the current passing receipts above; its original observations
and seals remain unchanged. No sibling queue implementation or installed
behaviour is inferred from the passing test command.

### Current as-built correction status, 6 November 2026

- [x] Finding 1: run the three identified technical branches. The native/model
  sequence passes in a real isolated app, including a native deferred request,
  durable adjudicator risk/reason audit, human-only typed categories with no
  model dispatch, interruption of an actual inference POST, recovery, three-denial
  breaker/one service notification, normal pending-decision reset, restored settings
  and normal loop completion after an independent database verifier. The driving
  native session is attached to a paused loop, a supported unattended condition;
  protected requests enter the real typed services rather than feature-specific
  credential/publish flows. Denials use a controlled HTTP response fixture and
  native notifications use a silent platform shim. Those limits are explicit,
  not unrun technical work hidden as human deferral.
- [x] Finding 1: the full two-model/eleven-role isolated enrolment/CLI/repository/UI
  matrix passes; target retirement and saved-settings restoration pass. The relay
  reaches the real Windows model, but this does not test production worker pairing
  or reroute production roles. Secondary-model inference is not claimed.
- [x] Finding 1: current authenticated Windows Sentry configuration reads and Google
  Cloud project/ancestor/role reads completed. The existing sender role has more
  than send-only permissions, so that acceptance fails; no role change is made.
- [x] Finding 2: replace the stale timed-gate handoff with the actual passing
  independent seven-command receipts, and rerun the focused regressions/UI hints.
- [ ] Coordinator's next independent acceptance decision. No completion rename or
  commit is authorised. The prior FAIL is retained; it is not rewritten as PASS.

Current technical outcomes, exact limits, command receipts and cleanup results are
in the assigned worktree's `2026-10-27-human-external-review2_proof/REPORT.md`,
`round6-native-final.receipt.json`, `round6-native-durable.receipt.json`,
`round6-enrolment-final.receipt.json`, `round6-sentry-browser.receipt.json` and
`round6-iam-current.receipt.json`. The round-6 final seal covers these files and
both canonical root documents after cleanup; historical seals are unchanged.

Current campaign tally remains **28 groups with unmet original live acceptance,
zero newly closed, one retired duplicate**. This correction runs the identified
technical branches; it does not close the wider campaign or its production,
feature-specific, physical-notification and human prerequisites. The active live
follow-up distinguishes completed technical observations from those boundaries.

### Historical timeout investigation, superseded for current gate status

At the earlier recovery point, the latest queue verdict contained one finding:
the full test command exceeded its 45-minute limit. Its other six commands passed
against the unchanged committed source. That retry also exceeded the allowance,
so the timeout finding was valid at that time. The later passing 6 November
receipts above supersede that former outstanding command requirement.

That inherited-runtime retry finished with exit 1 (Vitest duration 5,334.93 seconds). It
reported 37,931 passed assertions, nine skipped, two pending packaging cases and
an unhandled Vitest source-map error. The pending cases reproduced under the
shell's Homebrew Node 26 binary, which lacked the required packaging capability.
Both unchanged cases passed with the self-contained Node 24.22.1 pinned by `.nvmrc`.
The command was corrected locally to use that pinned runtime, and the complete
ordinary suite then passed: exit 0, 37,933 passed assertions, nine existing skips
and no unfinished assertions. Both previously pending packaging cases and the
changed CLI/browser regressions passed inside that full run. The final receipt is
`recovery-pinned-full.receipt.json` in the proof directory below.

The pinned full run took 6,325.1 seconds (105.42 minutes), so it did not meet the
queue's 45-minute allowance. Its earlier over-budget observation is retained in
`recovery-pinned-budget.receipt.json`. Correcting the runtime and passing the
ordinary full suite did not, at that time, clear the timed queue-capacity finding.
The current 6 November full-suite receipt does meet the unchanged bound.

The already approved owner of the queue-capacity correction is
[the queue-reliability plan](2026-11-05-plan-queue-reliability_plan.md), steps 1.2
and 1.3: admitted checklists take turns, use eight test workers, retain the
45-minute bound, and treat timeout as unfinished verification. At that earlier recovery reread,
the owner document marked steps 1.1 to 1.4 built and uncommitted and stated that a
rebuild and restart were required. That sibling implementation and its installed
behavior were not independently verified by this worker. This item did not
duplicate that repair or raise shared limits. Fresh passing timed receipts were
still needed at that earlier point; the 6 November seven-command receipts above
now satisfy that requirement. The coordinator's next acceptance decision remains
pending, and no sibling implementation or deployment is inferred.

The current recovery note and command receipts are in the assigned queue
checkout under `docs/plans/2026-10-27-human-external-review2_proof/`:
`recovery-investigation.md`, `recovered-failure.receipt.json`,
`recovery-time-budget.receipt.json`, `recovery-node26-full.receipt.json`,
`recovery-pinned-start.receipt.json`, `recovery-pinned-budget.receipt.json` and
`recovery-pinned-full.receipt.json`. The earlier seals remain historical and
unchanged. No product code, tests, dependencies, global runtime settings or
timeout policy were changed during recovery. The active plan stays untracked;
no completion rename or live-campaign acceptance is claimed.

## Historical worker handoff — 3 November 2026

Status: **active; source repairs and worker gates pass; campaign acceptance and the
coordinator's independent verification remain open**. This is the historical worker
record; historical campaign claims are not recertified. No completed-name change.

The supplied checkout did not contain the previously described three repairs or evidence
directory. The repairs were reproduced and implemented afresh. The current report and
receipts are in the assigned queue checkout at
`docs/plans/2026-10-27-human-external-review2_proof/REPORT.md`.
That non-ignored directory, its final seal and cleanup receipt are the current handoff;
the original live owner's missing historical evidence links are not current proof.
There is no separately linked spec; the live-check owner supplies acceptance.

| Plan item | Actual status |
| --- | --- |
| 1. Restore shared follow-up | Already restored and tracked in supplied HEAD, byte-identical to main. The different modified root version is preserved; no additional restoration was needed. |
| 2. Recheck residuals/run technical checks | All 29 group dispositions reviewed against current instructions and source; bounded current CLI/browser prerequisites, integration regressions and native WAL checks completed. Live acceptance remains open as detailed in the report. Updated 6 November: the three identified technical reruns now have current evidence and explicit limits above; they are not pending human approval. |
| 3. Repair CLI defects/investigate startup | LT-780/LT-781 reproduced failing-before and passing-after through bundled CLI/socket tests, plus real authenticated packaged-parent reads. LT-991 scan-envelope repair also implemented and tested through guard/journal/assertion integration. Existing WAL retry tested against real native lock contention and bounded persistent failure. Original LT-890 lock owner remains unknown; no speculative startup change. |
| 4. Supported cleanup route | Route found: ordinary human Skip through trusted renderer IPC. No agent skip RPC is exposed, and Harness desktop self-control is forbidden by current instructions. Both specific historic synthetic requests remain uncleared/unverified; exact steps are in the live follow-up. No production database edits or injected IPC. |
| 5. RES-020 evidence | Unsupported PASS withdrawn. Historical default-profile elapsed time cannot establish disposable authenticated profile plus outgoing cancellation-RPC acceptance. Keep open. |
| 6. Evidence/gates/review/cleanup | Worker typechecks, lint, size/hint checks, main/renderer/CLI builds, generators, IPC/exports and 13 focused files pass. Updated 6 November: all seven independent command gates passed, including the timed full suite. Focused regressions/UI hints rerun successfully. Current evidence and cleanup are in the round-6 receipts; next coordinator acceptance verdict remains pending. |

Historical acceptance tally on 3 November (unchanged on 6 November): **28 active groups retain unmet acceptance,
0 newly closed, 1 retired duplicate**. The older 20 Open / 7 Partial / 1 Failed breakdown
is a historical disposition record, not a new live verification result. No provider,
credential, release, physical interaction or production-change acceptance is inferred.

As-built: account CLI sends only the inner payload; dispatcher drains pipes by using
`process.exitCode`; the persistence scanner decodes the extension's existing serialized
object format and leaves invalid/truncated scans unknown. The sole changed existing test
expectation is corrected to the real RPC payload after runtime regressions pass. No
dependency/manifest, approval policy, route authority or test configuration was changed.

The latest real parent reads return all four account commands successfully. Settings pipe
and regular-file results are identical, valid 117,386-byte JSON with 226 settings; values
are not retained. The native WAL probe recovers a released lock in 302 ms and surfaces a
persistent `SQLITE_BUSY` in 5,017 ms, with both holders reaped and reopen succeeding.
This does not prove full application startup or ownership of the earlier lock.

Fresh independent source review returns PASS with no actionable findings. Its shell
refused test/Git execution as requiring approval, so this is explicitly a source-only
review, not an independent command replay or the coordinator's full gate. The worker's
final changed suites, spec typecheck and lint pass after the fixture refinements.

Remaining live acceptance and exact prerequisites are recorded in
[the active live follow-up](2026-10-27-human-external-review2_livetest.md), which links to the
original per-group procedures. The tracked live owner has existing root edits from another
run; those bytes were read but not overwritten or copied into this checkout. The independent
verifier must review this root plan as well as the queue source/proof files.

## Original scope and limits

1. Restore the erroneously deleted tracked shared follow-up, preserving root edits.
2. Recheck every residual against current authority and prerequisites. Run technical checks
   in an isolated runtime; retain actual human/external boundaries.
3. Reproduce and repair LT-780/LT-781; investigate LT-890 without attributing an unproven lock owner.
4. Find a supported cleanup route for only the two synthetic CAPTCHA notices.
5. Replace the provisional RES-020 pass with exact evidence or keep it open.
6. Update the dated tally and as-built notes, run applicable gates, review the diff,
   seal evidence, and remove owned runtime.

Account routing and production notices retain their supported authorization boundaries.
Fixtures must preserve tabs, accounts, worker services and live sessions. No commit,
branch/worktree operation, deployment or completed-name change. Superseded historical
campaign narratives remain in the original live owner; this plan reports current work only.

> Plan Queue parked work: `queue/2026-10-27-human-external-revi-2fd919` — 11 commit(s), reason: land-blocked.
