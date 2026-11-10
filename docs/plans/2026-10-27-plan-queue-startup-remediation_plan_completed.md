# Plan Queue startup: bounded RLM startup-lock recovery

On main: code only (hand-merged 6 Nov 2026, commit `60a6da38d`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Done: the code is already in this branch's base (hand-merged to main as `60a6da38d`). Resume round on 10 Nov 2026 re-ran the WAL tests (10 passed), the type check and lint, all clean; no source changes were needed. Next: the queue verifier runs the full suite and gives the final gate verdict (workers must not run it). The two desktop startup checks are deferred to the livetest doc. Open issues: none new; LT-708 register reconciliation stays with the coordinator (see "Register reconciliation ruling"). Round evidence: `2026-10-27-plan-queue-startup-remediation_plan_history_46a2c30446646883996161592920adc6e0436c00f50079605f1722407fd96f8a_completed.md`. Keep this active filename; the coordinator owns closure.

Original campaign identifier: LT-708. Original source link: [register](livetest-remediation-register.md#lt-708).
Live observation: [Plan Queue retry](2026-09-18-plan-queue_livetest.md#evidence-run--2026-10-27-verification-round-retry).
No separate linked spec exists.

The first isolated app launch on 2026-10-27 failed at the critical Work controls step with an
RLM `journal_mode = WAL` lock error. The same profile started on retry. The original lock owner
is unknown; this work proves the SQLite contention behavior rather than attributing that owner.

- [x] Trace main/context-worker database opening, driver timeout defaults and error propagation.
- [x] Reproduce with a bounded real native SQLite lock holder, distinguishing immediate writer contention from reader busy-handler waiting. No load generator or installed-app change.
- [x] Reuse the inherited WAL/migration serialization repair and correct its independently reproduced timeout overrun. Preserve existing databases/settings and persistent/non-busy errors.
- [x] Run focused regressions, worker-owned canonical static/build checks, generators and native compiled fresh/reused startup.
- [x] Repair verifier round 1 dependency failures in a worktree-local install and rerun dependency/startup checks; record the failed full-suite attempt and current evidence below.
- [ ] Queue verifier: rerun the full suite against the repaired local install and obtain final independent completion-gate PASS. The previous full suite failed; no full-suite pass is claimed. The worker is expressly forbidden to run the full suite or close/rename this plan.
- [ ] Full-desktop fresh/reused isolated startup: [exact deferred live checks](2026-10-27-plan-queue-startup-remediation_livetest.md).

## As-built — 3 November 2026

**Scope and existing implementation.** Work uses only the assigned AIO checkout/branch. The base
already contains `enableRlmWal`, `busy_timeout = 5000` before WAL, failed-open connection cleanup
and `BEGIN IMMEDIATE` migration serialization. No duplicate repair, schema change, destructive
recovery, dependency change or new setting was added. The original plan remains untracked at
this absolute root-checkout path and was never copied into the worker checkout. No spec was
found or invented. No commit, stash, staging, branch/worktree change or completed-name rename.

**Executing path.** `src/main/app/initialization-steps.ts:208` marks Work controls critical and
calls `initializeGlobalPauseRuntime`; `src/main/global-pause/global-pause-bootstrap.ts:22`
obtains the RLM facade. `src/main/persistence/rlm-database.ts:141-150` configures the busy timeout,
calls the WAL helper, then creates/migrates the schema. A failure closes the connection and
rethrows (`:155-157`); `src/main/index.ts:190-196` logs and rethrows critical startup failure.
`src/main/instance/context-worker-client.ts:107-114` supplies the profile to the isolated worker;
`context-worker-main.ts:157-160` initializes the same profile-local database before readiness.
The native factory forwards options unchanged; the installed driver's default is 5,000 ms
(`node_modules/better-sqlite3/lib/database.js:34`).

**Reproduction and correction.** Eight baseline schema/WAL tests passed before edits. With a
real writer holding `BEGIN IMMEDIATE`, raw WAL enablement returned `SQLITE_BUSY` immediately
instead of invoking the native busy handler; the inherited retry recovered on release. A real
reader instead invoked that handler. When one bounded holder switched from writer to reader at
4.5 seconds, the inherited helper exceeded its claimed budget: the new native regression
observed 9,747.8 ms and failed against a generous 7,500 ms scheduling allowance. The helper now
temporarily disables native busy waiting only around its own five-second WAL retry, checks the
deadline after sleep, and restores the prior timeout in `finally`. Only `SQLITE_BUSY` is retried.
Other SQLite errors and errors without a code propagate immediately; persistent contention
still throws the original error. No error fallback, data reset or migration alteration.

**Regression integrity.** The native tests use one real lock-holder thread and bounded waits,
check transient recovery/persistent failure, restored native timeout, unchanged rows and
same-connection recovery. The readiness handshake prevents the transient holder releasing
before the initial raw attempt. Existing tests retain initialization, migrations and failed-open
cleanup checks; their pragma doubles now correctly forward the existing `simple` option.
Deterministic tests cover expiry during scheduling and immediate SQLITE_LOCKED/IOERR/READONLY
or uncoded failure, including custom timeout restoration. No test/config suppression or weaker
assertion was added.

> Earlier journal sections moved to `2026-10-27-plan-queue-startup-remediation_plan_history_46a2c30446646883996161592920adc6e0436c00f50079605f1722407fd96f8a_completed.md`.
## Verifier round 1 remediation — 3 November 2026

**Finding 1: dependency install repaired, targeted verification passed.** Reproduced both
reported failures before changing the environment: installed `glob` was 13.0.6 rather than the
lockfile's 14.0.3, and the lockfile's nested minimatch copy was missing. The queue verifier's
retained full-suite result (`_scratch/test-results.pid-82492.json` in the assigned worktree)
records two failures among 36,404 tests; both are dependency-compatibility checks. That run
failed and is not a passing gate.

Replaced only the assigned worktree's per-entry dependency links using
`npm ci --ignore-scripts --no-audit --no-fund --cache _scratch/npm-cache-review-round-1`, then
ran the normal `npm run rebuild:native` separately. The disabled install hooks avoid changing
Git hooks/global ignore settings. The local Electron/SQLite preparation passed and verified
native ABI 146. Installed `glob` is now 14.0.3, nested minimatch exists, and the install marker
and checked package directories resolve inside this worktree. Both manifests are unchanged;
the main checkout still has its original 13.0.6 install. No test or application source changed.

The uncached seven-file targeted run passed all 37 tests, including all six dependency checks
and the prior 31 startup/schema/worker tests. Both TypeScript checks, normal lint, TypeScript
size/UI-hint guards, normal main build and production renderer build passed with the new local
install. The renderer's existing 1.65 MB bundle warning remains. Compiled native fresh/reused
facade and context-worker startup also passed: actual ready/stats/shutdown responses, intact
75-row migration history/checksums/timestamps, integrity `ok`, and no remaining child processes
or temporary runtime profile.

**Finding 2: verification status reconciled.** The checklist now distinguishes the completed
environment repair and targeted checks from the full-suite gate still owned by the queue
verifier. Its previous failed run is recorded explicitly above, rather than leaving the reason
for the unchecked gate unstated. The worker's full-suite restriction remains in force. No
full-suite pass or overall queue acceptance is inferred from targeted checks. The two desktop
checks remain deferred in the existing live-test document; no desktop check ran this round.

**Evidence and handover.** Worktree-local
`docs/plans/evidence/2026-11-03-plan-queue-startup/review-round-1/` retains baseline failure
output, install/native preparation logs, dependency state/fingerprints, targeted raw Vitest
output, command receipts, compiled startup results, report and seal. The original plan and
live-test document remain untracked at their existing root-checkout paths; neither is copied,
staged, committed or renamed. The next queue verifier must run the full suite using the local
install retained inside this assigned worktree. No branch/worktree lifecycle operation occurred.

**Scoped independent repair review.** A fresh read-only agent passed the environment/status
repair with no actionable findings. It independently reran the six dependency and two native
WAL tests uncached, confirmed the native ABI, local ownership and unchanged manifests, and
checked the plan status. The existing real-PTY integration check also passed without skips
with the repaired install. An install-link audit found no external symlink targets. This
scoped pass does not close the full-suite or overall completion gate.

**Round 1 cleanup.** After the repair report, receipts and initial seal were written, removed
this task's worktree build output and worktree-local npm download cache. The disposable native
startup profile is absent and every captured facade/worker PID is gone. No owned Angular,
Vite or tsx compile cache remains. The local dependency install (including Electron/native
SQLite needed by the verifier), small helper scripts, logs and evidence remain in the worktree.
Final results are recorded in the round-1 `cleanup.json` and `seal.json`. No copied checkout,
database cluster or standalone browser installation was created. Stop here for the queue
verifier; the active filenames and open full-suite/desktop checks remain unchanged.

> Plan Queue parked work: `queue/2026-10-27-plan-queue-startup-82bdf3` — 4 commit(s), reason: land-blocked.
