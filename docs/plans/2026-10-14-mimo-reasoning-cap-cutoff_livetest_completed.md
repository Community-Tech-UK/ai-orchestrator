# MiMo reasoning-cap cut-off: installed-app live checks

Status: fourth evidence round recorded 2026-11-11; **2 of 2 real-provider checks PASSED** (see "Evidence run — 2026-11-11" at the end). The ComTechSpare MiMo account had quota again and served real completions; the main account is still quota-exhausted (Harness failed over automatically). No defect reproduced; no James-only step. The 2026-10-27 sections below are history: their "OPEN / quota-blocked" results are superseded.
Plan: [2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md](2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md). Register item: [LT-706](livetest-remediation-register.md#lt-706).

> If a check reproduces a defect, record a new LT-NNN in
> [the remediation register](livetest-remediation-register.md), with observed behavior,
> root cause, required behavior and acceptance. Create an active follow-up implementation
> plan linked from the register. Keep per-check evidence here.
> Read [the campaign runbook](livetest-campaign-runbook.md) before running these checks.

## Prerequisites

An app built from this checkout and restarted at a safe time by James (never restart a Harness
with live sessions). A disposable root OpenCode session on a MiMo v2.6 Pro token-plan account,
outside a managed loop, orchestration unpaused. Record instance ID, OpenCode version and log
window. Never capture thinking, task source or credentials as evidence.

Why deferred: needs the rebuilt installed app plus a real MiMo step that exhausts its budget;
neither can be produced deterministically in the agent loop.

## 1. Cap reaches the session

Start the session and send one bounded ordinary task.

Expected: `app.log` `ACP turn completed` shows `generationBudget.combinedOutputTokens: 32000`;
the ordinary turn is `classifierReason: "completed"` and no continuation is sent.

## 2. Reasoning-saturated step is a visible cut-off

Give a task that makes MiMo reason past the cap in one step (for example a large multi-plan
analysis that asks for a full plan before any tool use).

Expected: when OpenCode's message record shows `finish: "length"` with reasoning near 32000 and
near-zero output, the `AcpCliAdapter` `ACP turn completed` line shows `classifierReason: "max_output"`
and `evidence: "budget_saturated"`, the `ProviderTurnEnding` line (which logs no `evidence` field)
shows `classifierReason: "max_output"`, the transcript shows the output-limit
notice, and Harness sends at most two automatic continuations across the user turn. Cross-check
with `sqlite3 -readonly ~/.local/share/opencode/opencode.db` on the session's latest assistant
message (`finish`, `tokens.output`, `tokens.reasoning`).

## Evidence run — 2026-10-27

**Result: 0 of 2 full real-provider checks passed; both have current evidence and explicit
remaining actions.** Safe installed-runtime inspection and simulated current-path checks
passed. The real ordinary turn failed on the account's token-plan quota. Simulated
completions are supporting evidence, not claimed as actual MiMo generation.

Worker: `queue/2026-10-14-mimo-reasoning-cap-c3e31b`; the live-test document was edited
only at its original absolute root-checkout path. No commit, branch switch, worktree creation
or completed-document rename was performed. The coordinator owns independent verification.

### Evidence and receipts

[Report](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/report.json),
[command receipts](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/command-receipts.json),
[SHA-256 seal](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/seal.json).
These contain metadata only: no thinking, task text, customer source, credentials or native
secret values. Raw app stdout/profile contents are not retained.

### Environment

- Built main and production renderer from the assigned worktree; both exited 0. Renderer
  build reported the existing 1.63 MB initial-bundle warning (1 MB warning threshold), with
  no build error. Four focused regression files passed: 96 tests, exit 0.
- OpenCode 1.19.4 on PATH and in the new native session records. The installed archive has
  the 32,000 MiMo cap, budget-saturation classifier and completion metadata; the
  [installed-runtime receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/installed-runtime.json)
  records file hashes. Archive presence alone is not claimed as live behavior.
- Automated hidden Electron test app: `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-72c3e31b`,
  debug port 9793; renderer served from this worktree on 4793. The test-only entry suppressed
  window showing/focus and set appPath to the worktree; no everyday Mac browser or desktop
  interaction was used. Browser Gateway preflight/health found `windows-pc` running with
  a fresh, deliverable extension channel; no shared browser tab was driven.
- Every renderer assertion enabled focus emulation first. The additional visibility-override
  CDP method is unavailable in this Chromium; measured `document.hidden=false` and
  `visibilityState=visible` confirm the focus emulation worked. No forced Angular rendering
  was used. Final renderer bootstrapped with `ng-version=22.2.1`.
- Setup failures were kept separate from product results. Chromium's nested sandbox failed
  with EPERM/SIGTRAP; the disposable automated runtime used `--no-sandbox --disable-gpu`.
  The first test-wrapper export override failed and was corrected before any asserted result.
  Default dev-server prebundling initially left the renderer blank with a partially compiled
  Angular dependency/JIT-compiler error. Restarting the owned server with `--prebundle=false`
  bootstrapped it. Early preload IPC observations prove main behavior, not a rendered UI;
  the final DOM assertion below was made only after bootstrap. Process-wide `ps` was denied
  with EPERM; scoped `lsof`, owned PID records and `kill(pid,0)` were used for cleanup proof.

### 1. Cap reaches the session — PARTIAL; real ordinary completion quota-blocked

Real disposable root instance `icw4wtqjb`, native session
`ses_e8289ca35ffeALW3BUJc5ZKSDC`, OpenCode 1.19.4,
`xiaomi-token-plan-ams/mimo-v2.6-pro`. A bounded no-tool ordinary reply was sent through
real preload `sendInput`. At 13:05:41.203 UTC, the instance entered error with the
MiMo token-plan quota failure (67-character ACP error; diagnostic hash `ad9e41a309882a50`).
No real `ACP turn completed` or successful reply was produced. A successful IPC return
only means delivery was handled; it does not establish model completion. No credential
lookup/login retry was needed: the failure was usage quota, not missing authentication.

Supporting current-path probe in separate root instance `i2j4jplmz`: actual OpenCode 1
startup/model/config selection, orchestration unpaused, `parentId=null`,
`launchMode=orchestrated`; adapter generation budget was exactly 32000. The test replaced
only `sendRequest('session/prompt')` results, leaving the adapter's completion builder,
normalized event path, continuation owner and renderer active. Synthetic ordinary usage
was input 100, output 17, reasoning 12; a finished fixture reply was supplied. At
13:08:22.908 UTC, the real adapter logged `completed / provider_completed` with
`generationBudget.combinedOutputTokens=32000`; ProviderTurnEnding agreed at 13:08:22.934.
One fixture prompt call, one request, zero cut-off notices or continuations.
[Numeric diagnostics](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/fixture-ordinary-diagnostics.json).

Remaining: after quota reset/availability, rerun a real ordinary no-tool turn and require
its own 32000-cap completion, `completed` classification and zero continuation. Agent work;
no unresolved human authority, identity or product choice.

### 2. Reasoning-saturated step — PARTIAL; current-path probe passes

Read-only native projections confirm actual prior MiMo reasoning-saturation endings:

| Native message | Session | Native finish | Output | Reasoning | OpenCode |
| --- | --- | --- | ---: | ---: | --- |
| `msg_17a08e78c001XAvUGfGuOWJg6i` | `ses_e86192410ffeAP7OL383vbXf3O` | length | 0 | 32000 | 1.19.4 |
| `msg_1768158bb0011mSNYqq6HfGqX4` | `ses_e8996dd3affeHPt09tfkxmDtEq` | length | 0 | 32002 | 1.19.4 |

[Read-only numeric projection receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/native-saturation-projections.json).
The retained app-log rotations contain no matching near-zero-output saturation completion.
A bounded, indexed conversation-ledger projection returned no matching capture/thread for
the first session. An initial broader scan was stopped rather than kept running. These
absences do not prove a product failure, and no historical transcript/continuation count is
claimed from them. No thinking or task body was exported.

In the isolated running app, the same test transport then supplied three consecutive ACP
`end_turn` results with output 0, reasoning 32000, input 100. No native `finish` was supplied,
as in the target ACP path that hides OpenCode's length ending. No MiMo reasoning was
created or read for this fixture. The adapter itself ran `buildAcpTurnCompletion` and logged:

- 13:08:38.515, .713 and .909 UTC: `classifierReason=max_output`,
  `evidence=budget_saturated`, cap 32000.
- ProviderTurnEnding agreed at .516, .714 and .911 UTC, correctly with no `evidence` field.
- The user turn produced exactly three fixture calls: initial plus automatic attempts 1
  and 2. No third automatic continuation was sent; the exhausted notice was recorded.
- After the real Angular renderer bootstrapped and the fixture session was selected, the
  DOM assertion passed: three exact output-limit notices, both attempt notices, and
  `The turn was cut off again after 2 automatic continuations.` visible. Focus/visibility
  were verified first. [DOM receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/dom-pass.json),
  [numeric adapter/provider diagnostics](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/fixture-all-diagnostics.json),
  [final state](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/fixture-final-state.json).

Remaining: after quota availability, correlate one genuinely reasoning-saturated native
MiMo step with that same live instance's adapter/provider diagnostics, transcript notice
and bounded continuations. The historical records plus synthetic current-path probe do
not replace this acceptance. No expensive saturation task was launched after the real
ordinary request failed quota. Agent/external prerequisite; no James-only action identified.

### Separate reproduced defect

Fresh-profile startup failed at Work controls at 13:01:02.870 UTC on duplicate migration
001, while the context worker completed persistence initialization. Restarting that same
disposable profile allowed startup. A controlled two-real-connection run of the compiled
migration runner reproduced the exact error after the second connection committed all 72
migrations. Both connections and the test database were cleaned up.
[Reproduction receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/migration-reproduction.json),
[startup diagnostic](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27/startup-failure.json).

Filed as [LT-720](livetest-remediation-register.md#lt-720), with matching implementation
status in the active untracked [follow-up plan](2026-10-27-mimo-check-migration-race_plan.md).
No fix is claimed. A concurrent root plan independently recorded the same startup failure
under provisional LT-708, already reserved elsewhere; the register records this collision
for coordinator reconciliation. That other worker's document was preserved. The completed
July remediation plan was left unchanged: new work belongs in an active follow-up.

### Verification and cleanup

No application source or committed test was changed. Main build, renderer build, focused
regressions and diff whitespace checks passed. Full suite, lint and separate typecheck
commands were not run for this documentation/evidence-only change; the builds did compile
the main process and Angular renderer. The existing focused tests were not modified.

The synthetic transport patch was restored. The isolated worker-role setting was restored.
All disposable instances were terminated via the real API; remaining instances 0 and
scheduled automations 0. The three native OpenCode sessions created in this worker's exact
scratch workspace were deleted through supported `opencode session delete`, each exit 0,
then confirmed absent with a read-only query. No other session was deleted.
The dev app and owned renderer server were stopped; all recorded owned PIDs were confirmed
gone. Final runtime-removal and checksum verification are recorded in the cleanup receipt.
No dependency installation was made; coordinator-provided dependencies are preserved.
No plan/live-test document was renamed completed, and nothing was staged or committed.

Rollup routing: the runbook asks for a backlog update, but `livetest-backlog.md` now
explicitly forbids current status additions and directs them to the owning live-test file.
This evidence section is the current status record; the historical backlog was preserved.


## Review follow-up — 2026-10-27

**Result: 0 of 2 real-provider acceptance checks passed. This document must remain open.**
Review findings 2–4 are addressed in the records; finding 1 remains an external quota
blocker, confirmed with a new real request. No fixture result is promoted to real-provider
acceptance, and no saturation success is inferred from historical records.

### 1. Real ordinary request retried; saturation still unavailable

Built and launched from the assigned queue worktree with the required isolated profile
`/tmp/aio-lt-queue-72c3e31b` and debug port 9793. The automated test wrapper kept all
Electron windows hidden and unfocusable; no everyday browser or desktop was driven.
Renderer server: 4793 with the known `--prebundle=false` workaround. Before any DOM
assertion, the CDP connection enabled focus emulation. The visibility-override method
was unavailable, but the assertion measured `document.hidden=false`, visibility
`visible`, Angular 22.2.1 and a live preload bridge.
[Renderer receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/renderer-readiness.json).

A genuine root OpenCode instance `i4wpqz172` was created for
`xiaomi-token-plan-ams/mimo-v2.6-pro`, orchestration enabled, browser tools off, no parent,
with no managed loop. At 13:34:04.782 UTC it received one short no-tool ordinary request
through the real preload API. No transport result or provider event was replaced.
At **13:35:15.732 UTC**, the app recorded its error: 67 characters, diagnostic hash
`ad9e41a309882a50`, matching the first run's quota failure. The native assistant message
`msg_17d916c66001sGm7xLdvTLL1GY` in OpenCode session
`ses_e826e970effe6UYK1BbsDK06Q7` (OpenCode 1.19.4) independently records an API error
matching quota, no native finish and zero input/output/reasoning usage. Only a numeric
and error-kind projection was read or retained; no thinking, task body or secret values
were exported.

- **Check 1: OPEN, quota-blocked.** The app emitted no `ACP turn completed` or
  `ProviderTurnEnding` completion for this turn. Successful IPC delivery does not
  establish the cap/classification acceptance. No successful real completion is claimed.
- **Check 2: OPEN, not run against a new real saturated step.** After the fresh ordinary
  quota failure, no expensive saturation request was sent. The earlier fixture evidence
  still supports the current code path but cannot close this check.
- **Next agent action:** once the same token-plan account has quota, run a real ordinary
  turn requiring its own 32000-cap `completed` completion without continuation, then
  correlate a real native length/reasoning-saturated step with that instance's adapter,
  provider ending, visible notice and no more than two automatic continuations. Quota
  availability is an external prerequisite; no missing human authority, identity step,
  credential action or product choice was found. No purchase/account switch was made.

[Live result](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/live-result.json),
[app diagnostic](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/real-provider-diagnostic.json),
[native numeric/error projection](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/native-ordinary-projection.json).

### 2. Renderer failure is linked as a reproduced product defect

The first run's default-prebundling blank renderer is the same defect already recorded
as **[LT-720](livetest-remediation-register.md#lt-720)** on
`queue/2026-10-05-livetest-campaign-d-99c0f5`. Calling it only a setup failure was
incomplete. Its register detail now includes the MiMo reproduction and the successful
no-prebundle comparison; the active follow-up includes matching implementation status.
No application fix or precise dependency/cache cause is claimed. This retry used the
known workaround; it does not prove the normal dev command is repaired.

### 3. Migration number collision withdrawn; all known duplicates listed

The previous evidence section and sealed report used LT-720 for the migration race.
**That assignment was incorrect and is withdrawn.** LT-720 retains its existing renderer
meaning. This worker's migration detail now supplements existing
**[LT-710](livetest-remediation-register.md#lt-710)**, the controlled MiMo saved-session
migration-race report. The false follow-up claim that LT-720 avoided reuse was removed.

The register and active follow-up explicitly identify the other migration reports:

- **LT-708**, OpenCode launch-environment branch and root plan
  `2026-10-27-fresh-profile-migration-race_plan.md`; the number also has an older unrelated
  reservation, so the source branch is recorded to disambiguate it.
- **LT-710**, MiMo saved-session branch and root plan
  `2026-10-27-mimo-campaign-startup-migration-race_plan.md`.
- **LT-721**, campaign-defects branch and root plan
  `2026-10-27-campaign-defects-runtime-followup_plan.md`.
- Former **LT-720 migration** entry from this worker, withdrawn in this follow-up.

These are repeated observations of one migration defect, not four different defects.
The coordinator has explicit consolidation instructions under LT-710. Other workers'
plans and branches were left untouched. The exact source sections and branch heads
were saved in the
[cross-branch receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/cross-branch-defect-references.json).
The earlier sealed evidence remains unchanged as historical evidence of the old label.

This retry also reproduced the startup failure at **13:31:28.312 UTC**: duplicate migration
001 before any renderer page target existed. The owned app/server were stopped, then
restarted using the same already-migrated disposable profile. That restart reached the
renderer and the real MiMo request above. No migration repair is claimed.
[Fresh startup receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/first-startup-projection.json).

### Verification, as-built status and cleanup

Only the tracked remediation register and the root-checkout live-test/follow-up working
documents changed. No application source, committed test, migration, provider credential
or installed app was edited. No production Harness database or existing user session was
changed; the one owned scratch OpenCode session was created and removed in OpenCode's
shared native database. The existing follow-up remains an active,
untracked file at
`/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-mimo-check-migration-race_plan.md`.
No document was renamed completed, and nothing was staged or committed.

Current verification: main build, production renderer build, the four focused turn-ending
regression files, application typecheck and spec typecheck all passed. The production
renderer retains its 1.63 MB initial-bundle warning. Full-suite and lint reruns were not
performed because this follow-up changes documentation/evidence only; no broader code
verification claim is made. Independent coordinator review is still required, and the
real-provider acceptance remains blocked regardless of the passing regression checks.

The real instance was terminated, its one native session was deleted only after verifying
its exact owned scratch workspace, and a read-only query confirmed no session remained
for that workspace. Remaining isolated instances and automations were both zero; changed
isolated settings were restored. Both app/server attempts stopped with recorded PID
checks. The disposable profile, worktree build output, test logs and owned scratch runtime
were removed after the report and receipts were written. Existing shared dependency/cache
links were preserved; this worker installed no dependencies or browser binaries.

[Report](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/report.json),
[command receipts](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/command-receipts.json),
[cleanup receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/cleanup-receipt.json),
[SHA-256 seal](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r2/seal.json).

## Evidence run — 2026-10-27, review round 3

**Result: 0 of 2 real-provider checks passed. Both checks remain OPEN.** The second
configured account was available for authorized testing, but it also failed quota. No
successful ordinary or reasoning-saturated MiMo completion is claimed.

### Account availability and authority

Read-only inspection of the production settings found exactly two configured MiMo
profiles: `legacy` (SuasMimo) and `comtechspare-f7a6` (ComTechSpare), both region `ams`,
enabled and `automationPolicy=allow-routed`. The existing pool has automatic failover
and a non-null ownership acknowledgement. `opencode auth list` reported exactly the
matching two credential names, `xiaomi-token-plan-ams` and
`aio-mimo-comtechspare-f7a6`; no credential value was read or exported. These existing
authorized accounts required no new identity assertion, login or account-policy change.
Only their secret-free profile/pool settings were copied into the disposable profile.

The verifier's `xiaomi-token-plan-ams-extra` and `xiaomi-token-plan-eu` references are
rejected-name test cases in `opencode-account-provider-config.spec.ts:82`; `sgp` and `cn`
are supported regional providers, but neither has a configured profile or saved credential
here. Region names are not additional accounts. No purchase, production account switch,
new credential or production settings change was made.
[Account inventory](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/account-inventory.json).

### Check 1 — OPEN: genuine requests on both accounts failed quota

Built and launched the assigned worktree in a hidden, unfocusable automated Electron
runtime, isolated with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-72c3e31b`, debug port
9793 and owned renderer server 4793 with `--prebundle=false`. No ordinary Mac browser
or desktop was driven. Focus emulation preceded every renderer assertion; the receipt
measured `document.hidden=false`, visible state, Angular 22.2.1 and a live preload bridge.
Both orchestration pause surfaces were unpaused. No provider transport or completion
was replaced. OpenCode session records show version 1.19.4.

Root instance `iwfrxr3b3` began the short no-tool ordinary task on **ComTechSpare**,
using real provider `aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`. At **13:50:35.176 UTC**
it produced the quota error (67 characters, diagnostic hash `ad9e41a309882a50`). Harness's
existing automatic failover then switched the same live native session to **SuasMimo**
at **13:50:41.570 UTC**. That genuine request on
`xiaomi-token-plan-ams/mimo-v2.6-pro` failed quota at **13:51:51.055 UTC**.

The read-only projection of native session `ses_e826091b4ffeDR1fyjA2dUdHdk` independently
correlates one assistant record per provider, each `APIError`, quota-message match,
no finish and zero input/output/reasoning tokens. The owned app log emitted **zero**
`ACP turn completed` and **zero** `ProviderTurnEnding` completions. There is consequently
no real ordinary completion from which to assert the 32000 cap, `completed`
classification or absence of output-limit continuation.

### Check 2 — OPEN: no real saturated step reached a provider

A later root instance `inez2tkjx` was created after both quota failures. Its ordinary
submission returned successful IPC delivery and idle state, but at **13:52:03.042 UTC**
the executing path explicitly logged `Skipped adapter dispatch because the provider
has an active known limit`. The harness incorrectly treated that idle state as a
candidate for saturation and submitted its extended reasoning task. At
**13:52:11.097 UTC** the same guard skipped adapter dispatch again. Neither submission
is a model completion or an attempted provider generation. This harness mistake is
recorded, not used as acceptance evidence. The second native session has no assistant
message. The raw harness observation's `ordinaryCandidate` and `sendSuccess` fields
mean only local state/delivery; the independently checked interpretation is authoritative.

The output-limit classification, visible transcript notice and at-most-two output-limit
automatic continuations still require a real saturated native step. The one automatic
account failover observed above is not an output-limit continuation. Historical native
length records and the first round's synthetic checks remain supporting evidence only.
No thinking, task body or secret value was retained in these evidence artifacts.

[Raw harness observations](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/live-result.json),
[redacted executing-path diagnostics](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/real-provider-diagnostic.json),
[native numeric/error projections](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/native-projections.json),
[renderer readiness](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/renderer-readiness.json).

Remaining agent action for both checks: when either of these already authorized accounts
has quota, run the real ordinary acceptance first; only after independently confirming
that completion, run and correlate a genuine saturated native step, adapter/provider
ending, rendered notice and bounded output-limit continuations. No James-only action
has been identified. Quota availability is an external prerequisite; do not close this
live-test document or its provider acceptance on the strength of local test passes.

### Register collision correction and as-built scope

Removed this branch's LT-710/LT-720 index rows, explicit `lt-710`/`lt-720` anchors,
numbered definition headings and copied campaign-renderer definition. This branch now
adds only its own evidence under unique
[migration](livetest-remediation-register.md#mimo-cutoff-migration-supplement) and
[renderer](livetest-remediation-register.md#mimo-cutoff-renderer-supplement) supplement
anchors. The original definitions remain owned by their existing source branches.
A cross-branch check confirmed each original branch has one definition/index row and
this branch has none for either number. The source-qualified migration observations
and prior sealed receipts remain available; no other branch or worker's document changed.
[Collision check](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/register-collision-check.json).

> Earlier journal sections moved to `2026-10-14-mimo-reasoning-cap-cutoff_livetest_history_170d535f524ac445ac968315a7905178607ea6e98c2fdad40b804fb4243dc4a3_completed.md`.
### Verification and cleanup — round 3

Fresh command receipts confirm exit 0 for main build, production renderer build,
application typecheck, spec typecheck, lint, TypeScript size ratchet, UI wording checks
and the four focused cut-off/classifier/runtime regression files. The renderer's existing
1.63 MB initial-bundle warning remains. No source or committed tests were changed.

**Full-suite rerun: BLOCKED by shared host overload, not passed.** Repeated `uptime`
observations before starting the suite rose from about 61 to 89, 173, 227 and 283.
The campaign runbook requires waiting above roughly 30 and forbids adding the suite
under that load. The app/server were already stopped before these later observations.
Lint is now freshly verified; review finding 4 remains partial until
`npm run test:quiet` can run on a settled host. No old suite result is substituted.
[Load preflight](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/full-suite-load-preflight.json).

Both disposable instances were terminated through real preload IPC; remaining instances
were zero. Read-only isolated-database counts found zero automations and zero automation
runs. The app, renderer server and both recorded provider PIDs were confirmed gone.
The two native OpenCode sessions were deleted only after verifying their exact owned
scratch directory; both supported delete commands exited 0 and a read-only query found
zero remaining sessions for that directory.

After the report, initial seal and command receipts were written, the disposable profile,
worktree build output, owned scratch scripts/workspace and this round's test output files
were removed. No dependency install or browser binary was created. Coordinator-provided
dependencies, pre-existing shared cache links and the pre-existing scratch result file
were preserved. Nothing was staged or committed, no branch/worktree was created or
switched, and no document was renamed completed. The active follow-up remains untracked
at `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-mimo-check-migration-race_plan.md`.

Review findings: **1 remains quota-blocked; 2 fixed; 3 addressed with both account calls;
4 partial (lint verified, full suite host-blocked).** Independent coordinator verification
is still required. The two real-provider checks remain open regardless of passing local
gates. Current status stays here because the historical backlog forbids new campaign
status additions.

[Report](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/report.json),
[command receipts](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/command-receipts.json),
[cleanup receipt](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/cleanup-receipt.json),
[SHA-256 seal](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-10-27-r3/seal.json).

> Plan Queue parked work: `queue/2026-10-14-mimo-reasoning-cap-c3e31b` — 3 commit(s), reason: round-limit.

## Evidence run — 2026-11-11

**Result: 2 of 2 real-provider checks PASSED.** Both ran against genuine MiMo v2.6 Pro generation on one live root instance. Nothing was simulated, no transport or completion was replaced. Worker branch `queue/2026-10-14-mimo-reasoning-cap-b4e6ef` (HEAD `e42966506`, worktree clean: no source, test or register change).

### Environment and accounts

- Built main from the worktree (exit 0). Launched a hidden, unfocusable Electron dev app (window show/focus suppressed, no Mac window or focus taken) with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-28b4e6ef`, debug port 9694, renderer served on 4694 with the known `--prebundle=false` workaround. Fresh profile: setup flag and role-choice cleared first. Only the two secret-free OpenCode account profiles and the pool setting were copied into the profile.
- Focus emulation was enabled before every DOM read; measured `document.hidden=false`, `visibilityState=visible`, Angular 22.2.1.
- Before building, a direct `opencode run` on `xiaomi-token-plan-ams` still returned "quota exhausted". The ComTechSpare provider cannot be probed outside Harness (it is injected by Harness config), so it was tested through Harness.
- OpenCode in the native session records: 1.19.5.
- Accounts: `legacy` (SuasMimo, `xiaomi-token-plan-ams`) quota-exhausted again; Harness recorded `resumeAt` 2026-11-22T23:59:59Z. `comtechspare-f7a6` had quota and served everything below. No credential was read, no purchase or account-policy change was made. A third OpenCode credential named `xiaomi` exists but is not a configured Harness profile and was not used.

### Check 1 — Cap reaches the session: PASS

Root instance `i4cpfuezn`, native session `ses_e368a6e36ffeAN0Wq8vwfJWFC7`, orchestrated, browser tools off, no parent, no loop. A short no-tool ordinary task was sent at 07:15:04 UTC. The first attempt on `legacy` hit the quota error at 07:16:16 (67 chars, hash `ad9e41a309882a50`, same as earlier rounds); automatic failover switched the same session to ComTechSpare at 07:16:19 and replayed the prompt (`autoContinuation:false`).

At 07:16:30 UTC the `AcpCliAdapter` line `ACP turn completed` showed `classifierReason:"completed"`, `evidence:"provider_completed"`, `generationBudget.combinedOutputTokens:32000`, output 14, reasoning 15. `ProviderTurnEnding` agreed (`completed`). Native record: `finish:stop`, input 31682, output 14, reasoning 15. No output-limit notice and no continuation; both `sendInput` log lines carry `autoContinuation:false`.

### Check 2 — Reasoning-saturated step is a visible cut-off: PASS

Same live instance, 07:20:46 UTC: one no-tool Sudoku task that demands exhaustive reasoning before any answer text. Three consecutive real saturated steps followed:

| Native message | Finish | Output | Reasoning | Adapter completion (UTC) | Continuation sent |
| --- | --- | ---: | ---: | --- | --- |
| `msg_1c97b0b12001E5oeZVP8lJ7Wag` | length | 0 | 32006 | 07:24:52, `max_output` / `budget_saturated`, cap 32000 | automatic 1 (07:24:52) |
| `msg_1c97eca82001y9VYnPr3Y52oCn` | length | 0 | 32006 | 07:28:42, same | automatic 2 (07:28:42) |
| `msg_1c9824f69001PY2JuBSa080dP5` | length | 0 | 32000 | 07:32:51, same | none |

- `ProviderTurnEnding` logged `max_output` within 5-6 ms of each adapter line and, as documented, has no `evidence` field.
- Exactly two `sendInput` calls had `autoContinuation:true`; the native record has exactly three assistant steps, no fourth. The third saturated step produced the exhausted notice and no further dispatch.
- Rendered transcript (real Angular renderer, after focus emulation): three `This turn reached the provider output limit. Your message and the work above are kept.`, `Continuing the cut-off turn automatically (attempt 1 of 2).`, `(attempt 2 of 2).`, and `The turn was cut off again after 2 automatic continuations. Work is preserved. Send "continue" to try again.`
- Cross-check query on `~/.local/share/opencode/opencode.db` (read-only, numeric fields only) matches the table above.

### Evidence files (metadata only: no thinking, no credentials)

[Report](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/report.json),
[command receipts](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/command-receipts.json),
[SHA-256 seal](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/seal.json),
[check 1 app-log slice](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/check1-app-log-slice.ndjson),
[check 2 app-log slice](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/check2-app-log-slice.ndjson),
[completion lines](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/completion-lines.ndjson),
[native numeric projection](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/native-projection-numeric.txt),
[DOM notices](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/check2-dom-notices.json),
[DOM attempt notices](2026-10-14-mimo-reasoning-cap-cutoff_evidence/2026-11-11/check2-dom-attempt-notices.json).

Setup note: my hidden launcher changed Electron's app name, so main-process logs went to `~/Library/Application Support/Electron/logs/app.log` instead of the Harness folder. That is a launcher artefact, not a product result; the slices above were cut from that file by timestamp and instance id.

### Defects

None reproduced. The fresh profile started on the first try (the earlier duplicate-migration startup race did not recur this run, which proves nothing about its fix) and the renderer was served with the known `--prebundle=false` workaround from the start, so the earlier renderer-prebundle defect was neither exercised nor repaired. No register change.

### Verification and cleanup

No source, test or register change, so the gates verify the unchanged tree: `npm run checks` (typecheck, spec typecheck, lint, LOC ratchet, UI hints, build:main, build:renderer) exit 0; full `npm run test:quiet` exit 0 (3718 files, 47787 tests); six focused turn-ending/continuation/OpenCode-config spec files exit 0 (156 tests). Both `checks` and the full suite ran on the Windows PC test machine. Host load stayed at 13-17 throughout.

The instance was terminated through the real API (remaining instances 0); the isolated database held 0 automations and 0 runs; no setting was changed in the real profile. The owned native session and three direct-probe sessions were deleted with `opencode session delete` after verifying their exact scratch folders (each exit 0; read-only query then found 0 sessions for those folders). The dev app and renderer server were stopped (ports 9694 and 4694 confirmed closed). The disposable profile, scratch folder, probe folder, temp logs and worktree build output were removed after the report, receipts and seal were written. Nothing was staged or committed, and no document was renamed.

### Verifier round 1 follow-up — 2026-11-11

Finding: the remediation register still described LT-706 as "live re-check pending". Fixed in the worktree: the LT-706 index row, the detail Status line and the Acceptance bullet in `docs/plans/livetest-remediation-register.md` now record the live verification of 2026-11-11 (both real-provider checks passed, per the evidence run above). A search of the register finds no remaining "pending" wording for LT-706. Documentation-only change; `git diff --check` clean. No code changed, so the gate results above still describe the tree.
