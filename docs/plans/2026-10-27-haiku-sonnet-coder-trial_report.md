# Haiku and Sonnet coding trial: saved-results reconciliation

Status: partial experiment; verification round 3 reconciles the failed acceptance gate, 3 November 2026. Earlier local queue prerequisites are retained. The original experiment remains ACTIVE and is not ready for acceptance. No further benchmark or judge calls or live queue changes were made. Latest replay/check evidence is under `2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-3/`; earlier implementation evidence remains under `review-round-2/`.

[Source plan](2026-10-27-haiku-sonnet-coder-trial_plan.md). Machine-readable calculations and command receipts: [evidence](2026-10-27-haiku-sonnet-coder-trial_evidence/reconciled.json).

## 1. Recommendation for James

Sonnet low is the best candidate for a later Plan Queue trial, with Opus high as the stronger worker. It solved the same three tasks as Opus on every repeat, used less recorded time and had the lowest recorded coding cost per solve. Keep the current queue settings until the controlled follow-up is ready and its actual plan list is approved. This experiment does not establish that Sonnet can replace Opus on the wider backlog.

## 2. Recorded results

| Setting | Scored / planned | Solves | Task-weighted solve rate, 95% range | Gap to Opus | Average coding minutes | Coding tokens, millions | Logged coding USD | USD / solve | Rule |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|
| Opus, no plan | 30 / 30 | 9 | 30.0% (10.8–60.3%) | +0.0 points | 34.3 | 233.28 | $68.35 | $7.59 | yardstick |
| Haiku high | 29 / 30 | 9 | 30.0% (10.8–60.3%) | +0.0 points | 39.9 | 437.28 | $27.08 | $3.01 | incomplete |
| Haiku max | 30 / 30 | 8 | 26.7% (9.0–57.3%) | -3.3 points | 43.1 | 808.83 | $117.49 | $14.69 | meets numeric rule |
| Sonnet low | 30 / 30 | 9 | 30.0% (10.8–60.3%) | +0.0 points | 4.8 | 17.63 | $9.90 | $1.10 | meets numeric rule |
| Sonnet medium | 30 / 30 | 9 | 30.0% (10.8–60.3%) | +0.0 points | 17.6 | 43.96 | $15.03 | $1.67 | meets numeric rule |
| Sonnet high | 30 / 30 | 9 | 30.0% (10.8–60.3%) | +0.0 points | 20.9 | 57.08 | $19.39 | $2.15 | meets numeric rule |
| Sonnet max | 30 / 30 | 6 | 20.0% (5.7–51.0%) | -10.0 points | 40.6 | 885.49 | $151.78 | $25.30 | meets numeric rule |

A solve means hidden tests passed AND all no-damage checks passed (`benchmarks/plan-execute-ab/scorer.ts:97` in the saved trial bench). Across 209 saved records, 59 passed the hidden tests; all 59 passed the no-damage checks. The seven tasks nobody solved remain failures, including for Opus. Successful tasks: AIO-01 and AIO-02 for every setting; 12ST-02 for all except Sonnet max, and only two of three repeats for Haiku max.

Ten tasks are the independent evidence units, not 30 independent tasks. Rates average each task’s observed repeat fraction; ranges use the bench’s Wilson method with n=10 and fractional successes. This corrects the old report’s Haiku rate of 31% (9/29), which overweighted easier tasks because a failing-task repeat was missing. The observed equal-task rate is 30%; after the missing score is obtained, the final Haiku rate could be 30% to 33.3%. Its present interval is descriptive of observed data, not a completed-arm result. Broad overlapping ranges mean quality is too close to call at this size.

The agreed numeric rule means no more than 10 percentage points below A, with the lower 95% bound no more than 25 points below A’s lower bound. All five complete planned arms meet it; Sonnet max is exactly on the first threshold. The ranking then uses logged coding cost per solve, with time as the tiebreaker. Sonnet low wins. Applying the stricter alternative of comparing the arm’s lower bound with A’s point estimate would not change these numeric outcomes. Meeting this permissive rule is not statistical proof of equivalence.

Sonnet medium and high cost more without more solves than low; max costs much more and solves fewer. Haiku max costs more and solves fewer than the available Haiku high records. Higher thinking is not worth it on this task bank. The best candidate remains Sonnet low regardless of whether Haiku’s one missing repeat succeeds or fails.

## 3. Completeness and fairness

- There are 209 unique scored cells of 210 expected, with no duplicate or unexpected task/arm/repeat identities. Missing: `12ST-03|H|2`.
- Its agent log has a successful CLI result and a patch exists, but the batch stopped before hidden/no-damage scoring with `scoring dependency setup receipt missing`. Its scoring folder has only dependency setup evidence; the old workspace is absent. A successful CLI result is not a solve. The result was not inferred or inserted.
- Every retained scored cell’s log records Claude Code 2.1.311, the expected model, its expected effort flag (or no flag for A), and turn cap 75. One common saved config sets the 60-minute coding limit. Every planned arm records `planUsed: true`; A records false. Each task has a consistent dependency fingerprint and scoring-contract version across all recorded arms. AIO-01 uses the pre-existing amended contract; the other nine use historical-v1. These checks establish recorded protocol consistency, not a fresh replay of the old controls.
- Quarantined stopped logs contain both 2.1.311 and 2.1.312 and are excluded from outcomes. They remain included separately in known cost. No retained scored log mixes CLI versions.
- The launcher actually used seven simultaneous batches rather than the planned ceiling of four. Earlier notes also describe high host load and a reboot. Durations therefore describe this loaded run and are not a controlled speed benchmark. No measurements of host load per invocation exist to remove that confounding. Equal configured limits do not repair this deviation.
- The existing bench report applies C1/C2 local-model decision rules and repeats reused planner tokens per coding repeat. Neither is appropriate for this trial. The table above applies this plan’s rules, reports coder-only tokens including cache read/write, and handles historical plan cost separately.

## 4. Costs and account limits

The seven arms’ non-quarantined agent logs report **$409.02** in coding usage. This includes the unscored Haiku invocation and appended retries. Claude judge logs add **$12.77**, and quarantined stopped coder logs contain **$5.49**. The total available session-log amount is **at least $427.27**, already above the original $160–250 estimate. These are CLI-reported metered-equivalent USD, not proof of subscription cash charges or invoices. No new trial usage was incurred in this reconciliation.

Cost parsing takes the maximum cumulative `total_cost_usd` per Claude CLI invocation and adds invocations separated by the bench’s `===` banners. It never sums cumulative result snapshots. There are 34 Claude invocation segments without any final cost: 18 in coder logs, 8 in judge logs, and 8 in quarantine. Their cost is unknown, not zero. The separate Codex judge logs have no dollar-cost basis and are additional unknown usage; they are outside those 34 Claude segments. Logs outside this session, including effort probes, are outside that total. The old report’s claim to include quarantined spend was not supported by its cost reader, which scans only the session’s top-level coder logs, plans and judge folder.

The missing coder costs belong to Opus (4 invocation segments), Haiku high (3), Haiku max (5) and Sonnet max (6). Sonnet low, medium and high have none. Consequently the dollar ranking above is a ranking of available log totals; absent charges could increase the other arms' totals. Codex logs provide no metered dollar basis here. The $427.27 is an available-cost lower bound, including interrupted work, rather than a complete trial bill.

The frozen Opus plans were reused: no new planning charge is due for this trial. Their saved usage files retain **$12.41** of historical planning cost. For a standalone workflow that had to buy those plans once, add $12.41 to each planned arm’s total, never once per repeat. Sonnet low would be about **$2.48 per solve**, compared with Opus’s logged $7.59. Neither figure includes a real-plan queue checker or handover campaign. Shared judging is listed separately, and the historical planner amount must not be counted six times in total trial spend.

| Setting | Top-level coder logs with approaching-limit warning | Top-level coder logs with rejected limit event | Saved run errors |
|---|---:|---:|---:|
| Opus, no plan | 1 | 0 | 10 |
| Haiku high | 2 | 0 | 12 |
| Haiku max | 4 | 0 | 20 |
| Sonnet low | 0 | 0 | 0 |
| Sonnet medium | 0 | 0 | 2 |
| Sonnet high | 1 | 0 | 2 |
| Sonnet max | 3 | 0 | 24 |

These are log-file counts, including appended invocations; they are not counts of distinct account exhaustion incidents. The saved progress notes attribute one account-limit rotation to ComTech. No top-level retained coder log has a rejected `rate_limit_event`; that does not prove no runs ever stopped for limits. Account rotation state and batch history are separate evidence.

Saved run accounts: ComTech 149, Adapt 45, Adapt-IT 15. ClaudeSUAS appears in none of the saved records and is excluded from the saved launcher. Account labels are retained; login folders and credentials are not copied into this report.

| Opus account | Runs | Solves | Solve rate | Task mix |
|---|---:|---:|---:|---|
| ClaudeComTech | 19 | 6 | 31.6% | AIO-01, AIO-02, AIO-03, AIO-04, AIO-05, AIO-06, 12ST-01 |
| ClaudeAdapt | 11 | 3 | 27.3% | AIO-06, 12ST-01, 12ST-02, 12ST-03, 12ST-04 |

The accounts ran different task mixes, so these figures do not establish that account choice has no effect. No Opus record used Adapt-IT. Do not invent an account-normalized quality comparison.

## 5. Judging

The runner compares the first saved repeat once per task/arm, only when both patches pass. Sixteen task/arm pairs are eligible and all sixteen have saved JSON. Opus supplied two orderings for all sixteen, but every Codex result is `judge-unavailable` with zero parsed orders. Thus **0 of 16 pairs have both judges and both orders**. The saved errors report exit 1 with no parseable verdict; that does not establish an authentication or service cause. No login investigation or new judge call was started. Hidden-test scores stand independently; no majority or missing verdict was invented.

## 6. Proposed real-plan batch and exclusions

Proposed setting: Sonnet low workers, Opus high step-up, automatic checkers and three rounds, with the currently allowed Claude accounts only. **Do not start a campaign yet.** A fresh read-only queue inventory and full reads of the ten shortlisted documents on 3 November found no eight-to-ten-plan batch that satisfies the plan’s restrictions. Queued means already reserved by another campaign, not available for a second campaign. The following is a concrete review shortlist, not an approved executable list. Sizes are rough remaining-change estimates, not measurements.

| Document (all under root docs/plans/) | Approximate size | Queue snapshot | Eligibility decision |
|---|---|---|---|
| 2026-10-27-mimo-campaign-settings-navigation_plan.md | small | queued | Exclude: same route-snapshot defect as the shared implementation, whose source report is already implemented and awaiting verification. |
| 2026-10-27-control-surface-route-snapshot_plan_completed.md | small | landed | Exclude: implementation already shared and queue item landed; its document still records verifier/live acceptance. Not new coding work. |
| 2026-10-27-plan-queue-startup-remediation_plan.md | medium | queued | Hold: WAL-lock investigation overlaps the currently verifying fresh-profile migration repair; remaining acceptance includes compiled startup. |
| 2026-10-27-residuals-startup-remediation_plan.md | medium | queued | Hold: another startup-lock report with unconfirmed owner; do not treat it as an independent task. |
| 2026-10-27-rlm-first-start-migration_plan.md | medium | queued | Exclude pending consolidation: same migration uniqueness defect as other campaign reports. |
| 2026-10-27-mimo-campaign-startup-migration-race_plan.md | medium | queued | Hold: controlled migration reproduction exists, but the fresh-profile repair is already verifying; a second implementation would overlap. |
| 2026-10-27-mimo-check-migration-race_plan.md | medium | parked; earlier item queued | Hold: explicitly identifies duplicate migration reports and includes a separate renderer bootstrap defect. Consolidate before sampling. |
| 2026-10-27-worker-offline-findings_plan.md | medium | queued | Exclude: combines duplicate migration work, remote-worker transport and live outage acceptance. |
| 2026-10-27-mimo-hook-correction_plan.md | small remaining | queued | Exclude: source change already implemented; remaining work is full-suite and independent verification. |
| 2026-10-27-session-sidechat-remediation_plan.md | medium/large | queued | Exclude: three defects, permission-sensitive adapter changes, real-provider and Windows acceptance; unsuitable for the small/medium offline batch. |

Ownership evidence is a timestamped read-only `plan_queue_items` snapshot in [queue-inventory.json](2026-10-27-haiku-sonnet-coder-trial_evidence/queue-inventory.json); compare all items for a document, since a newer parked item does not release another queued item's reservation. Document identities are hashed in `source-manifest.json`; active source plans were read in place and not copied. No queue reservations or ownership were changed. The roster is time-sensitive and must be checked again immediately before an approved trial. Do not split duplicate reports into independent plans just to reach eight. This is an audit of the recorded shortlist, not a claim to have exhausted every plan in the repository.

For a later approved campaign, first consolidate duplicates and recheck ownership, then propose eight to ten genuinely unowned small/medium code plans for Sonnet low. Use one setting initially: this avoids splitting a small sample between two cheap models that the benchmark cannot distinguish reliably. Freeze that list and a comparable historical Opus cohort before starting, balancing remaining source-file count and subsystem. Keep all outcomes, including parked documents, in the denominator. Record first-check passes, rounds, Opus handovers, landed/parked reason, checker severity, elapsed time and known/unknown spend separately; compare cost per landed document only after including failed rounds, checking and handovers. Round 2 now provides `audit:queue-coder-outcomes` and its fixture tests. The report can read accepted checker calls from archived conversation history with `--history-dir`; those calls are distinguished from applied verdicts. Validated full-history coverage and a matched historical cohort remain open, so step 10 is not represented as complete.

Round 2 implements both local queue prerequisites: `PlanQueueRouteChoiceSchema` now carries optional effort through MCP, worker/checker/triage routing and the three editors, and `buildTriagePrompt` shares the verifier's Harness reporting-tool discovery route. Focused runtime/DOM tests cover the new behavior. LT-722 remains OPEN pending its three authorized real-provider triage trials. The missing scored benchmark cell, second-judge coverage, fairness acceptance and campaign likewise remain open. The whole original plan is not complete.

## 7. Verification, remaining work and reproduction

The offline script is `scripts/coder-trial-reconcile.mjs` in the assigned worktree; tests are `scripts/coder-trial-reconcile.test.mjs`. These were recovered from the previous parked attempt by reading its Git blobs, without changing branches or committing. The script reads evidence only and emits selected metadata, excluding prompts and credential file contents. It hashes consumed JSON and log inputs, reports cost gaps by category and arm, and checks recorded plan use, scoring contracts, model/effort/version/turn caps and opposite judge orderings against the actual judged run identities. Run from the assigned worktree:

```sh
rtk proxy node --test scripts/coder-trial-reconcile.test.mjs
rtk proxy node scripts/coder-trial-reconcile.mjs --session /Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/coder-trial/results/coder-trial-2026-10-27 --bank /Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/coder-trial/benchmarks/plan-execute-ab/tasks/task-bank.json
```

Focused tests, type checks, lint and source/UI static checks are recorded individually with exit codes in [initial command receipts](2026-10-27-haiku-sonnet-coder-trial_evidence/command-receipts.json) and [final static receipts](2026-10-27-haiku-sonnet-coder-trial_evidence/final-command-receipts.json). The initial scoped pass's final focused run is separately recorded in [handoff-focused.receipt.json](2026-10-27-haiku-sonnet-coder-trial_evidence/handoff-focused.receipt.json), including the delivered script/test hashes. The earlier pass reserved the full suite for the queue verifier and required an explicit Node command for `.test.mjs`. Round 2 fixes this gap with `scripts/__tests__/coder-trial-reconcile.spec.ts`, which executes all eleven unchanged Node cases under the normal full suite. It also runs the full suite and production builds for the new production changes; final results and limitations are recorded in the round-2 evidence. A lockfile-exact dependency install was created inside this worktree to repair the reproduced shared-install failures and is retained for the verifier. No browser, database cluster or copied checkout was created. Disposable SQLite fixtures are removed by teardown. Existing historical trial runtime remains untouched. No IPC channels or module alias subpaths were added; the shared effort constant is exported from the existing contract module. IPC and export verification commands pass. The size check retains existing allowlist advisories; no limit or warning was suppressed.

Further model-based completion and the real-plan campaign are recorded in the [companion live checklist](2026-10-27-haiku-sonnet-coder-trial_livetest.md). Agent-runnable production prerequisites remain in the active plan; they have not been disguised as human-only blockers. No restart request from the historical progress log is current: the 29 October restart already happened.

Round 3 corrects that checklist's classification: only actual external runtime checks remain there. Offline
score recovery, judge-retry implementation, plan selection, applied-history validation, approval boundaries,
environment constraints and the failed full-suite gate are explicitly open in the source plan. They do not
qualify for a completion deferral. Conditional external check instructions grant no new authority.

Evidence from the earlier attempt was missing despite the report's old links. This pass rebuilt the evidence directory from the original session rather than treating the old report as proof. Baseline and strengthened-script results agree on all previously reported outcome/cost fields. Fresh tests first exposed unsupported recommendations under inconsistent plan/scoring conditions and false judge completeness for duplicate orderings; the implementation now rejects those conditions. Exact failing and passing outputs are retained. The plan has no separate linked spec.

Fresh-review follow-up: the first two reviews requested independent fixtures for each scoring-contract condition, strict rejection of missing judge identities, coverage for arm/verdict/rubric checks, and a final reconciliation receipt tied to the delivered script. Those changes are implemented. A regression also exposed omitted costs for Claude judge logs nested inside quarantine; those logs are now included. None exists in this saved session, so totals are unchanged. Direct source readback corrected the first review's claim that saved judge IDs were absent: all sixteen pairs have explicit repeat identities. The final reconciliation was rerun and its output atomically retained with script/test hashes in [reconcile.receipt.json](2026-10-27-haiku-sonnet-coder-trial_evidence/reconcile.receipt.json). These reviews could read source but their shell execution was blocked; worker execution receipts are distinct from independent execution evidence.

A third genuinely fresh reviewer returned [Scoped reconciliation review: PASS, no actionable findings](2026-10-27-haiku-sonnet-coder-trial_evidence/fresh-review-3.md). It inspected source and receipts but could not execute shell checks. Its optional observations do not change the delivered behavior: the stricter no-damage filter matches this trial's decision rule and affects no saved pair; the combined CLI-fairness fixture asserts every distinct diagnostic, while contract mutations use separate fixtures; the final 11-test handoff receipt supersedes earlier 10-test focused receipts. No additional behavior change is warranted by those observations.

Independent execution and the full repository suite remain the queue verifier's acceptance gate. This scoped source review cannot close the incomplete experiment or substitute for that gate. The source plan remains at its original root path and filename. Source/evidence fingerprints and cleanup disposition are retained in [seal.json](2026-10-27-haiku-sonnet-coder-trial_evidence/seal.json).


## 8. Verification round 2: what changed and what remains open

The saved readiness decision was reread directly from the owning queue item, not inferred from this report.
It explicitly permits reconciliation and preserves the boundary against new benchmark/judge calls, live queue
routing and the second campaign. No response to the new approval question has been assumed.

- Queue thinking controls, triage discovery, an npm audit entry and the reconciliation test wrapper are now source
  changes in the assigned worktree. The three route editors and same-model/higher-effort handover are covered by
  Angular DOM/save tests; route schemas, selected effort and checker selection are covered by focused tests.
- The read-only outcome report reads all requested queue items in one database snapshot and optionally inspects
  bounded archived conversations. It matches structured reporting-tool calls to accepted receipts, deduplicates
  repeated tool outcomes and excludes failed calls and ordinary assistant text. It emits severity counts and
  timestamps only, never transcript contents. Accepted reports can be discarded by the coordinator at turn end;
  neither those calls nor the latest stored round counter are presented as complete applied history. Actual owning
  run smoke: 42 documents, 44 relevant archives read, one accepted checker report, zero proven first-check outcomes.
- Shared-install failures were reproduced before the local install; the actual locked dependency checks now pass.
  The worktree owns its installed dependencies. No package version, lockfile, test expectation or assertion was
  weakened to achieve that result.
- Missing-cell recovery has a tested isolation blocker: the scorer rejects this worktree's installed ancestor
  dependencies, source copies outside this worktree are expressly forbidden, and neither Docker nor Podman is
  installed. The retained patch and original successful setup receipt were located, but no score was fabricated.
  A protocol-equivalent isolated scoring location or an authorized rerun remains necessary.
- The historical seven-batch deviation is **not accepted as fair** by this repair. The results remain provisional
  and durations remain unsuitable for a controlled speed comparison. No statistical tie was converted to a
  definitive quality recommendation. Sonnet low remains only the proposed candidate for an approved follow-up.

The final round-2 report, command receipts, source/evidence hashes and cleanup disposition are retained in
`2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-2/`. Whole-experiment acceptance remains failed while
these requirements are open, even if the local source checks pass. No commit, branch change or completion rename
is authorized or claimed by this repair.


Round-2 ownership census: all 42 active, non-archived plan filenames under `docs/` are in `docs/plans/`.
Forty have existing nonterminal queue items; only two have none, before size/readiness checks. Thus the current
unreserved pool cannot supply the required eight-to-ten-document batch without changing existing ownership.
This is a filename/queue-ownership census, not a claim that the two unreserved plans are otherwise eligible.
No existing work was adopted, cancelled or released. The census is retained with round-2 evidence.


Compatibility decision: existing routes with no thinking field retain the Harness app default. An explicit
null selects the provider default, matching ordinary session creation. The editor labels both defaults and the
MCP argument accepts null; choosing a concrete thinking level remains unchanged. A regression first reproduced
an unintended change to legacy routes, and the final source preserves their behavior without rewriting live
settings or queue rows. This refines the original draft's shorthand for an absent field.


Round-2 verification currently passes focused queue/report/dependency tests, both typechecks, lint, static
checks, production builds and IPC/export checks. The final full run completed with exit 1: two failures among
36,399 reported tests, in unchanged worker output-capture and Codex partial-timeout fixtures. Both files then
passed together in isolation (exit 0). Timing-sensitive behavior is implicated, but the failed full gate remains
unresolved and is not waived by the isolated success. Independent source review passed within its stated read-only coverage, but
no independent execution or whole-experiment acceptance is claimed. Final command output, timing probes and
review limitations are retained in the round-2 report. No worker test timeout or assertion was weakened.


Round-2 runtime cleanup is complete: generated build output/caches, temporary probes and identified test
fixtures were removed. Worktree dependencies remain for the verifier. Final [repair report](2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-2/report.md),
[cleanup receipt](2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-2/cleanup.receipt.json) and
[integrity seal](2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-2/seal.json) preserve the partial
status and exact verification evidence. No completion or recommendation approval is inferred from cleanup.

## 9. Verification round 3: current evidence and unresolved acceptance

The latest read-only replay is byte-identical to the round-2 JSON. All consumed input/log hashes match. It still
contains 209/210 cells, the same missing Haiku score, zero complete two-judge pairs and at least $427.27 of logged
Claude usage. No evidence was changed to close a requirement. A separate metadata-only inspection of all sixteen
saved Codex judge logs found 105 JSON events and no top-level `total_cost_usd` or `usage` fields. It confirms no
saved metered dollar basis, not zero Codex usage or a complete cost total.

Current focused queue/report/dependency tests and both previously failing test files pass in isolation. Both
typechecks, lint, size/UI checks, IPC verification, export verification and diff whitespace checks exit 0.
Full suite and production builds were not rerun: this pass changes only root documentation/evidence, and the
worker is expressly prohibited from running the full suite. The earlier full-gate failure remains open for the
independent verifier. Isolated success does not establish a cause for the earlier failures or waive that gate.

A fresh independent source reviewer returned FAIL for the unfinished experiment and raised possible script
issues. Its shell commands were refused, and its source coverage was partial. Source readback distinguishes the
outcome report's always-unknown `firstCheckPass` and `costPerLandedUsd` from its separate first-recorded-report and
recorded-lower-bound fields. The Markdown uses the genuinely unknown first-check field intentionally. The
historical runner really selects the first saved repeat (`runner.ts:302,310`) and skips existing judge-pair files
(`runner.ts:307-308`). The Codex log inspection above also corrects an unverified assumption that those logs
provide a dollar cost. No speculative source change was made. This review is not a passing independent gate.

Only the deferral-documentation finding is repaired by this pass. Missing score/judging/fairness, Test 2,
complete history/cohort evidence, final recommendation and the full independent gate remain open. Sonnet low
with Opus high is still a proposal. Further model usage and the exact real-plan batch need the separate authority
already required by the plan. No new source, generator input, dependency version, test expectation or live setting
changed. The plan/report/live checklist remain untracked at their original root paths. Reproduction receipts,
review assessment, integrity seal and cleanup disposition are in
`2026-10-27-haiku-sonnet-coder-trial_evidence/review-round-3/`.
