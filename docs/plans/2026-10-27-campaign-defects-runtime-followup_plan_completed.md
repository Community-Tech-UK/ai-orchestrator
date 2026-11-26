# Campaign defects runtime follow-up

## Status

On main: yes (this landing commit)
All six source items (LT-671, LT-672, LT-683, LT-719, LT-720, LT-721) are implemented and
ticked. The code is already on main (hand-merged 6 Nov 2026, commit `67adab3ec`), so the
queue branch now conflicts with main in three files (Codex turn adapter, rail component and
its spec); landing should keep main's versions. Re-checked 26 Nov 2026 on the branch: root
and spec typecheck and lint exit 0; five focused files / 94 tests pass. The 12 Nov live run
passed every acceptance section except one: confirm a genuine failed Claude completion
stays an error (LT-672), recorded as the only open item in the linked `_livetest.md`.
Evidence: `_evidence/2026-11-12-queue-b66c0914/report.md`; round notes in the `_history.md`.
Full suite and the independent completion gate belong to the queue verifier. No rename.

Owner: [campaign acceptance](2026-10-05-livetest-campaign-defects_livetest.md).
Evidence: `docs/plans/2026-10-05-livetest-campaign-defects_evidence/2026-10-27-bd99c0f5/`
in the assigned queue worktree. The historical completed remediation plans remain closed.

## Reproduced failures

Checkboxes now record source implementation and local regression verification on
31 October. They do not close the separately recorded live acceptance or authorize a
completed-name rename. Earlier dated observations below remain historical evidence.

- [x] LT-671: repair first-turn fresh-replay continuation. Five new root Claude
  sessions were killed during the first seconds of a busy first turn. All recovered
  without the required automatic continuation. Determine why this path differs from
  the successful replay during the established-session cap/takeover test.
- [x] LT-672: classify the installed Claude interrupted result as cancellation.
  A real Stop returned interrupted=true and idle, then posted the provider-error notice.
- [x] LT-683: repair native Codex follow ownership. Three independent unsteered
  fourteen-turn goals completed in their rollouts; only two distinct assistant turns
  per run appeared in Harness, which stayed busy. A later send in the pilot used a
  stale active-turn ID and failed. Compare pending follow ownership with terminal
  turn replay before selecting a fix.
- [x] LT-719: display a persistent initial resync failure. Loading clears and the
  error is stored, but the rail has no error rendering. Preserve successful reloads.
- [x] LT-720: diagnose default dev-server dependency prebundling. The real renderer
  starts blank with an Angular partial-compilation/JIT error under the ordinary
  dev command in the AIO checkout. Disabling prebundling restores it. Confirm the
  dependency/linker cause before changing production bootstrap or build settings.

## Verification required for repairs

- Reproduce each failure with a focused regression before changing product code.
- Run the normal project checks and repeat the owning live acceptance procedure.
- Obtain an independent completion-gate PASS before closing this follow-up.

The queue restart checks remain unexecuted here because their fixture requires
new commits, branches and worktrees, which this worker was explicitly forbidden
to create. This is an authority constraint, not evidence of a queue defect.

## Evidence handoff — 2026-10-27

All sixteen campaign checks now have dated outcomes: six pass, four fail, four partial and two blocked. The five repair items above remain open. Runtime/build/cache cleanup is verified; no product source or tests were changed. This plan remains untracked and active for the repair work, not completed by the evidence run.


## Verification-round follow-up — 2026-10-27

This plan remains active and untracked. Evidence corrections do not complete
its source-repair items. The original campaign remains open with failures.

- [x] LT-721: investigate fresh-profile duplicate migration startup failure.
  Capture competing database initializers and reproduce the ordering before
  selecting a repair. Do not weaken unique names or checksum checks. The
  earlier register citation is stale: current root/worktree registers contain no LT-721
  entry. This follow-up retains the independently reproduced error and repair evidence.

LT-674 and LT-680 were rerun with retained direct evidence to replace unsupported
historical claims. LT-671, LT-672 and LT-719 still fail in the fresh runtime.
The reviewer quality guard intentionally rejects responses without completeness
evidence; the original response is missing and its exact fields are unknown.
Current direct reviewer-path rounds are supplementary to the full loop check.
No completed document was modified or renamed; the coordinator reads the canonical
campaign document from the root checkout when preparing any eventual landing.


Signed-out title follow-up: check 14 now passes with actual automatic title application in the restarted isolated runtime. The previous dispatch block was technical helper backoff; the normal retryHelperNow control cleared it without changing fallback policy or approval. Current campaign accounting is seven pass, four fail, three partial and two blocked. This does not close any source-repair item above.


## Verification round 2 as-built notes — 2026-10-27

The four open runtime failures were reproduced again after rebuilding queue HEAD
3854eb60a1f6b8d37bf5de19d7c7d9cdbbee4e4c. Five additional first-turn crashes
retained the executing fresh-replay state update, all without continuation; three
new fourteen-turn goals each lost most captured replies; Stop still emitted a
provider-error notice; and persistent resync errors remained invisible. Current
metadata for the stopped Claude result is retained as aborted_streaming /
error_during_execution, classified unknown_error / provider_error.

The LT-721 missing receipt citation and detail anchor were corrected. No missing
file was recreated from memory. The canonical campaign header now reflects the
authorized disposable dev runtime and clearly labels historical accounting.

Evidence is in the assigned queue worktree under
`docs/plans/2026-10-05-livetest-campaign-defects_evidence/2026-10-27-bd99c0f5-r3/`.
No product source or tests changed. This plan remains active and untracked; the
source-repair items above are not completed by another evidence run. The remaining
reviewer rounds, final accounting and cleanup are recorded in the campaign's
latest evidence section when the runtime work finishes.


Final third-run accounting: eight PASS, four FAIL, two PARTIAL, two BLOCKED.
LT-702 now has ten real parent-loop reviewer rounds with retained verdict timing
and cleared in-flight state. The four source-repair failures and the browser/queue
residuals stay open. Both typechecks, required builds and focused suites passed;
no code changed. This active untracked follow-up is not completed. Final runtime
cleanup and the evidence seal are recorded in the owning campaign receipts.


Third-run cleanup confirmed: all recorded task-owned runtime paths were deleted
after report/receipts/seal creation, with normal app shutdown and verified server
stop. Pre-existing dependencies/cache and the foreign debug listener remain.
The campaign still has eight open acceptance checks; this plan remains active.

## Crash-turn queue-worker implementation status — 2026-10-27

Evidence-only rerun on queue HEAD `80412201a`; no product source or tests changed.
Owner: [crash-turn live checks](2026-09-28-crash-turn-auto-continue_livetest.md).
Retained report in that worker's checkout:
`docs/plans/2026-09-28-crash-turn-auto-continue_evidence/2026-10-27-b26e570b/report.md`.

- [x] LT-671 source repair implemented on 31 October (see notes below). In this earlier
  27 October evidence run, five new first-turn fresh replays produced no automatic
  input. The first three watches lasted 45 seconds; the final two lasted 70. Metadata observers
  show the real guard/reservation accepts the transient recovery wait, then the real dispatcher
  returns false at its 60-second settlement timeout. `waitForInstanceSettled` requires
  assistant/error output for idle sessions, while these interrupted first turns have only
  user/system output. Repair recovery readiness without weakening ownership, cancellation,
  pause or cap guards, then repeat all five live trials. Earlier admission-only fixes do not
  satisfy this acceptance condition.
- [x] LT-672 source repair implemented on 31 October (see notes below). In this earlier
  27 October evidence run, two busy-turn stops reach idle
  without continuation but still produce the provider-error notice. Normalized completion
  `finish: aborted_streaming`, `unknown_error / provider_error` is retained in
  `LT-B-stop-result.json`. The repeated IPC check returned `interrupted: true` and was
  watched for 35 seconds.
- [x] LT-C cap/takeover acceptance rerun: attempts one and two dispatched, the third crash
  stayed idle with the exhausted notice, and user takeover reset the next automatic attempt
  to one after the fourth crash's 30-second backoff. This covers LT-670's LT-C condition;
  it does not newly claim the separate four-idle-crashes procedure.

The main/preload build, fresh renderer dev compilation, both TypeScript checks and focused
continuation tests passed. This plan remains active and untracked. No completed plan was
modified, and no verifier PASS or source repair is claimed by these observations.

## Source-repair worker notes — 2026-10-31

Scope is the six open defects above. The historical evidence-only runs remain historical;
they do not describe this implementation run. This plan links no standalone specification:
the owning campaign acceptance document and the defect descriptions are the acceptance
sources. Other migration follow-up documents identify LT-708/LT-710/LT-721/LT-723 as
observations of the same race; no competing follow-up document is being closed here.

Ruling: retain the existing branch/worktree and the root-only untracked plan. Do not
commit or rename documents. Run focused tests and static/build checks; the independent
queue verifier owns the full suite and final acceptance decision.

LT-721 implementation: migration discovery, checksum validation and application now run
inside one immediate SQLite transaction. The existing driver transaction interface gains
an optional immediate mode; both native and WASM drivers implement it, and the test-only
native-module substitute exposes the native callable's immediate variant. Unique migration
names and checksum rejection remain enforced. No migration SQL or checksum was changed.

Reproduction used two real native SQLite connections against one disposable file under
Electron's Node runtime. Interleaving a completed second initializer after the first
owner's discovery reproduced the duplicate migration-001 insertion. The fixed runtime
interleaved the second initializer before transaction entry, observed a real write lock
at discovery, and finished with exactly 73 migration records. Receipts:
`_scratch/campaign-runtime-followup/migration-before.json` and `migration-after.json`
in the assigned worktree. Focused database tests cover stale discovery, partial profiles,
unchanged profiles, checksum mismatches (including a competing initializer), rollback
and retry. Initial focused checks pass; final command receipts follow below.

The actual RLMDatabase coordinator was also run in two native worker threads against
one fresh profile and then restarted against it. This exposed a separate SQLITE_BUSY
journal-mode upgrade collision before migrations. A confirmed-WAL-only check did not
solve the transition race and was replaced with a bounded retry of SQLITE_BUSY alone
(five-second deadline, 25 ms waits). Persistent contention and unrelated failures still
throw, and their failed connection is closed. Five fresh-profile/restart trials now
pass. Receipts: `migration-owners.json` and `migration-owners-trials.json` alongside
the two-connection receipts. No window, production profile or actual context-worker
IPC startup was used in these native checks.

LT-671 implementation: the completed-turn predicate remains the default and still
requires a reply for idle sessions. A separate `input-ready` wait mode requires idle
or ready state, no active native turn, no unfinished interrupt and the normal activity
debounce. The shared dispatcher selects it only for a crash ending, after the lifecycle
has announced successful recovery. It retains all dispatch ownership, cancellation,
pause, loop, inhibitor, identity and attempt-limit checks. Five fresh-replay event
trials using the actual settlement tracker failed before the change and now send
exactly one continuation each. Additional real-tracker tests cover active native turns,
interrupt lifecycle, user input, Stop, pause, loop takeover and provider replacement.
Existing cap/takeover and default-settlement tests remain unchanged and pass.

LT-672 implementation: native `aborted_streaming` and `aborted_tools` are now
cancellation terminal reasons. The regression uses the recorded normalized finish and the real Claude result
metadata builder, with no human-readable interruption message. The provider event
bridge, turn observation and continuation owner receive completed/client_cancelled
with automatic continuation suppressed, and post no provider-error notice. A result
with error_during_execution alone remains a provider error, as does source text merely
mentioning aborted_streaming. Focused before/after output: `claude-before.log`,
`claude-after.log` and `claude-ingress.log` in the worker evidence directory.

Delegation evidence: the three native Agent calls timed out without returning results
or making edits. Two replacement CLI workers use only local file/shell tools with no
MCP servers; their progress and process receipts are retained in the worker evidence
directory. No independent verifier PASS is inferred from these implementation workers.

LT-720 diagnosis (implementation still pending at this note): the installed Angular
22.2.1 builder declares Vite 8.3.0, but the repository override forces Vite ^7.3.2
(installed 7.3.7). Angular's executing browser dev-server path calls
`getDepOptimizationConfig`, whose linker is under `optimizeDeps.rolldownOptions.plugins`
and invokes `prebundleTransformer.transformFile`. The installed Vite 7 scanner reads
`optimizeDeps.esbuildOptions.plugins` instead. Instrumented normal serving records 543
unlinked Angular declaration calls in prebundled dependencies; direct evaluation fails
on PlatformLocation needing unavailable JIT. The no-prebundle comparison records zero
unlinked declarations. Application chunks themselves are linked in both modes. This
is a toolchain/linker-contract mismatch, not an application bootstrap defect.

Ruling: repair the incompatible dependency override/lock resolution while preserving
normal prebundling and the production bootstrap. A changed manifest requires its own
correct install in this worktree; do not mutate the root checkout's shared dependency
targets. Retain the before/after served-code/linker and module-evaluation receipts.


## Source-repair as-built handoff — 2026-10-31

Six source repairs were implemented, but the earlier focused checks omitted the
native provider-logging suite. Queue verification subsequently failed on its
Codex provider-exit case, so the earlier claim that all agent-runnable checks pass
was incorrect. The plan stays active and untracked under this exact name; the
coordinator alone owns independent verification and any completed-name rename.
The implementation worker made no commits, stashes, branches or extra worktrees.

- LT-683: removed the pending-follow slot after replay proved it parked the Harness
  turn's own start, then recaptured its already-finished ID. Native root starts now
  acquire capture synchronously, completed captures yield immediately, and bounded
  finished-ID memory ignores replay. Replies publish in order and idle waits for the
  last publication. A parent regression additionally reproduced replies arriving after
> Earlier journal sections moved to `2026-10-27-campaign-defects-runtime-followup_plan_history_ad188bc9751519a82e34dae015fdba941876534c56073921348d506036af6553_completed.md`.
## Merge-conflict resume handoff — 2026-10-31

The resume request was limited to resolving the coordinator's in-progress merge,
staging the resolved files, rerunning targeted checks, and stopping without a
commit or merge abort. All three index conflicts are resolved. The worktree and
branch remain the assigned AIO-owned checkout.

- Codex retains the branch's synchronous provider-turn follower. Its active-turn
  identity check already covers main's self-follow correction, while preserving
  ordered publication, replay protection and teardown ownership. Incoming
  compaction-watchdog changes remain present in the adjacent adapter files.
- Database startup uses main's shared `enableRlmWal` helper, monotonic five-second
  contention deadline and connection cleanup for every initialization failure.
  Migration discovery/checksum validation and all pending writes stay inside the
  branch's driver-owned immediate transaction, preserving both sides' writer-lock
  intent, atomic rollback and post-commit completion callback.
- Two tests needed instrumentation reconciliation after the combined runtime was
  exercised: the startup deadline now stubs `performance.now`, and the native
  two-process migration test competes before entering the immediate transaction.
  Its legacy stale-snapshot branch and every assertion remain intact.

Current resume receipts: eight focused files / 115 tests pass; the separately
executed native provider-source logging file passes all 21 tests, including the
Codex exit case. The first combined run used a nonexistent logging-test folder,
so its 115-test result does not include those 21 native checks. The separate
receipt corrects that selection error. Renderer and Electron TypeScript programs,
spec typecheck, Angular lint, fast lint, LOC and UI-hint checks, generated aliases
and IPC, IPC verification and package exports pass. Generators caused no tracked
drift. The pre-resolution run failed on conflict markers; the first resolved run
failed precisely the two instrumentation hooks described above, before their
correction.

Evidence: [resume report and command receipts](2026-10-27-campaign-defects-runtime-followup_evidence/2026-10-31-merge-resolution/report.md).
No full suite, rebuilt application, live provider campaign or browser check was
run in this resume. Existing live acceptance remains in the linked `_livetest.md`;
the coordinator owns full independent verification and the completed-name rename.
The second fresh source-readiness review returned `READINESS REVIEW: PASS`, using
parent-captured diffs and direct source reads because its shell commands were
denied. It did not independently execute checks and is not a completion-gate PASS.
Only the resolved code/test files were staged; this root plan remains untracked
and was neither copied into the worktree nor renamed. No runtime, copied source
tree, browser download, database cluster or background service was created.

> Plan Queue parked work: `queue/2026-10-27-campaign-defects-ru-928209` — 5 commit(s), reason: worker-error.


## Replacement-worker implementation notes — 2026-11-03

The assigned checkout started clean on `queue/2026-10-27-campaign-defects-ru-fb7243`.
Reading the actual sources showed that LT-671, LT-672, LT-719 and LT-720 had not
landed from the parked worker. LT-683 had newer notification buffering but still
failed replay, missing-terminal and teardown regressions. LT-721 already has the
main branch's immediate writer lock, checksum validation, atomic rollback,
bounded monotonic WAL retry and failed-connection cleanup. The old checked boxes
are therefore being revalidated against this checkout, not trusted as proof.
No standalone spec is linked; the defect descriptions and owning campaign remain
the acceptance sources.

Ruling: retain the newer Codex wire-order notification queue and repair its remaining
ownership defects rather than restore the parked branch's separate follower class.
Actual adapter regressions pass ordinary fourteen-turn bursts before modification;
seven edge-case regressions fail. Additional investigation reproduced a queued turn
with a missing terminal and stale ownership after thread replacement. Repair replay
protection, inferred completion, queue draining and lifetime checks in the current
adapter; extract unchanged turn-result conversion to respect the existing file-size
limit. Do not revert the newer goal handoff or compaction work.

Ruling: preserve the existing LT-721 repair instead of introducing a second driver
transaction API. Current native Electron/two-process migration regression and WAL
retry/cleanup tests pass. No migration SQL, checksum, uniqueness or database driver
contract was changed by this worker.

Current as-built: LT-671 uses a separate input-ready settlement mode only after
successful crash recovery, with the default completed-turn predicate unchanged.
LT-672 recognizes both native Claude Stop tokens and keeps genuine provider errors.
LT-719 keeps list failures separate from create/restart errors, exposes them in the
real rail with Details/retry, guards duplicate clicks and returns keyboard focus to
the filter after recovery without taking focus the user moved elsewhere. Successful
full snapshots clear the failure; individual live events do not. LT-720 installs the
compatible Vite 8.3 patch line privately in this worktree, preserving ordinary
prebundling and the production bootstrap.

The helper agents' shell/write tools were denied; they made no edits and executed no
checks. The parent worker applied and verified all changes directly. Their static
observations are leads, not independent command evidence.

Evidence is being retained in
`2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-03-runtime-repairs/`.
Final command receipts, source review and cleanup results will follow here. The
full suite and independent completion verdict belong to the queue verifier. The
six actual-provider/rebuilt-application acceptance sections remain open in the
existing linked `_livetest.md`; no browser, installed Harness window or real provider
campaign is claimed by local module evaluation or renderer TestBed checks.


### Replacement-worker verification and cleanup handoff — 2026-11-03

All six source items above are ready for queue verification. Five focused runs
cover 67 distinct files and 1020 distinct passing tests, including real shared
continuation initialization, structured state-resync/preload boundaries and native
provider logging. No full suite was run. Renderer/main and spec TypeScript checks,
Angular/fast lint, file-size and UI-hint gates, both required builds, architecture,
contract aliases, package exports, IPC verification and the build-audit policy pass.
Both generators pass with no tracked drift. The production renderer retains its
existing 1MB initial-bundle warning (1.65MB), with no threshold changes.

The corrected ordinary dev-server check fetches 175 modules with zero failed
fetches, bare imports or unlinked declaration calls; seven Angular entries evaluate
without the JIT compiler. The first scanner's helper-definition false positive
and log-name collision are recorded as instrumentation errors, not a product
failure or passing evidence. Its corrected run has separate logs and receipts.

The first fresh source-readiness review found an undeclared transitive dependency
in the regression guard. The guard no longer imports it, has negative cases and
continues to check the actual builder-resolved install. A new Harness-origin
missing-terminal case and robust template resource URL also pass. The second fresh
context returns READINESS REVIEW: PASS, with no blockers. It executed no commands;
this is not a full independent completion-gate PASS. Current final spec-type and
main-build receipts postdate the review-follow-up edits, and actual manager wait
forwarding is traced at instance-manager.ts:1027-1031. The queue verifier still owns
full-suite/clean-state verification and final acceptance.

Report, source fingerprints, command/test logs, both review outcomes/dispositions
and the evidence seal are retained at
[3 November implementation evidence](2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-03-runtime-repairs/report.md).
The separate cleanup.json confirms the task-owned build/cache/scratch paths were
deleted after sealing evidence, both dev-server process groups are gone and ports
closed, and private dependencies/native modules remain for the verifier. The root
shared dependency install is unchanged. No copied checkout, database cluster or
browser download was created. No commit, staging, stash, branch/worktree operation
or document rename was performed. This canonical plan and the live-test document
remain untracked in the root checkout and were never copied into this worktree.

The existing six live acceptance sections remain open. This run does not claim real
Claude/Codex campaigns, a rendered Electron window, authenticated renderer reload,
or actual context-worker/main startup. The linked active _livetest.md now separates
the parked worker's historical native-owner trials from this replacement run's
current checks. No standalone spec was found or created.

### Verification round 1 repair handoff — 2026-11-03

The independent full-suite run rejected this checkout for the pre-existing model
ID guard failure and one native Codex meaningful-stop failure. Both findings have
now been repaired in the assigned checkout; the changes remain uncommitted. This
plan remains active and untracked under its existing name. The coordinator still
owns the next full-suite verification, final acceptance and completed-name rename.

- Model guard: reproduced the two concrete Opus/Sonnet 5.5 IDs in frontier cost
  attribution failing the unchanged guard. Added shared pinned-model constants
  and used them in the attribution mapping, pricing keys and priced-only list.
  The IDs, prices, provider mapping, defaults and picker entries are unchanged.
  No guard, scan scope or allowlist was weakened.
- Native Codex Stop fixture: the retained failure is an AbortError at native
  child close. The fixture announced ACK before installing its SIGINT handler,
  allowing the test to stop a child before it could produce the required reply.
  ACK now follows handler installation. Controlled descheduling at the ACK
  boundary using the actual generated fixture reproduces SIGINT/no answer before
  repair and the expected answer/normal exit after it; both child PIDs are absent.
  Production behavior, every assertion and the existing deadlines are unchanged.

Current checks pass: 10 focused files / 130 tests, including the unchanged guard,
native outcome, provider types/pricing, HyDE and exec input/progress suites; both
TypeScript checks; Angular/fast lint; LOC/UI-hint gates; main/preload build; and
diff whitespace validation. The full suite and renderer production build were
not rerun for this targeted handoff. No renderer implementation changed, and no
browser, actual app window, authenticated reload or live provider campaign was
tested. Existing live acceptance remains open.

The first fresh source review was limited by denied Bash tools and speculated
about a Haiku literal outside the guard's main/renderer scan. A second fresh
review read the actual guard and the parent-captured raw diff, returning
READINESS REVIEW: PASS for source/test integrity. It executed no commands and is
not an independent completion-gate PASS. Its existing one-second deadline warning
is retained as a full-suite limitation, not hidden by increasing timeouts.

Report, baseline/focused logs, exact file-level command receipts, controlled
reproduction, both source reviews and the evidence seal are in the assigned
worktree at
`docs/plans/2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-03-verifier-repairs/`.
Cleanup is recorded separately after report/receipts/seal creation. Temporary
fixture/source scratch and refreshed compilation output are removed; private
dependencies and unrelated pre-existing output remain. No database cluster,
browser binary, copied checkout or persistent service was created. No commit,
staging, stash, branch/worktree operation or document rename was performed.

### Pricing merge-conflict resume handoff — 2026-11-03

This resume is limited to the coordinator's two in-progress merge conflicts.
Both are resolved and staged. The merge remains open for the coordinator; no
commit, abort, stash, branch/worktree operation or document rename was performed.
This canonical plan remains untracked in the root checkout and was never copied.

`frontier-cost-attribution.ts` now uses main's dedicated `CLAUDE_PRICING_MODELS`
for the 5.5 attribution mapping. `provider.types.ts` retains main's accounting-only
constants, priced-only membership and computed pricing keys, removing the branch's
duplicate pinned constants. Both sides' model-ID guard intent survives with the
same IDs, rates, picker/default entries and unchanged tests. Both staged and
working-tree files exactly match `MERGE_HEAD`; no index conflicts remain.

Current focused verification passes 11 files / 660 tests, including the unchanged
model guard, provider types/pricing, HyDE/title attribution and native Codex
outcome/input/progress. Renderer/Electron TypeScript programs, spec typecheck,
Angular/fast lint, LOC/UI hints, aliases/IPC generation, IPC verification, package
exports, contracts and both required builds pass. Generators/builds cause no
unstaged tracked drift. Existing unrelated lint/LOC warnings and the renderer's
1 MB initial-bundle warning (1.65 MB) remain. The two resolved files pass staged
whitespace validation. The whole staged merge retains five trailing-space lines
in an unrelated incoming browser-login review report; that evidence was preserved.

A fresh read-only source review found no source defect but could not run Git
because its shell calls were denied, returning `READINESS REVIEW: NOT CONFIRMED`.
Parent commands confirm the exact incoming versions, and direct pricing-path
inspection plus current regression tests resolve its verification questions.
No independent completion-gate PASS is inferred. The full suite was not run,
as instructed; the coordinator's independent gate and existing six live
acceptance sections remain open. No browser, real provider campaign or app window
was tested during this merge resume.

Evidence: [pricing merge report and command receipts](2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-03-pricing-merge/report.md)
in the assigned worktree. Report, receipts and seal precede the separate cleanup
receipt. Temporary build/cache output is removed while private dependencies and
older unrelated artifacts remain; no database cluster, browser download, copied
checkout or persistent service was created.

### Verification round 2 runtime and full-suite rerun — 2026-11-03

Status: current local verification passes, ready for independent queue recheck.
The assigned checkpoint started clean. No product source,
test, timeout, assertion or committed runner configuration has changed in this
resume. This canonical plan remains active and untracked under its existing name;
the coordinator owns any final independent verdict and completed-name rename.

The reported queue-readiness and index-worker failures reproduce in a two-worker
focused run on the busy shared host. The same four files pass all 85 tests with
one worker. The following unfiltered one-worker full run passes all three
verifier-named files but exits 1 on a separate runner error, so it is not a pass:
36446 assertions pass, nine are skipped and two SEA build assertions stay pending
while Vitest reports an unhandled source-map parsing error.

Direct SEA build reproduction shows the default Homebrew Node v26.12.1 lacks the
required SEA fuse. The existing self-contained Node v24.22.1 pinned by `.nvmrc`
contains it. Both SEA build cases pass under that installed runtime. No Node or
dependency installation and no global configuration change was needed. Only the
task subprocess PATH selects the existing pinned executable. The exact secondary
source-map formatting mechanism is not established and was not patched or hidden.

Current corrected verification: six focused files / 97 tests pass with the pinned
runtime and the existing two-worker override. Both TypeScript checks, Angular/fast
lint, LOC/UI-hint gates and both required builds exit 0. The corrected unfiltered,
unsharded full suite exits 0 after 2074.834 seconds: 36448 passing assertions, nine
existing skips, zero failed or unfinished pending assertions in 2865 reported
files. The 41 queue-pause, 23 usage-throttle, 13 index-worker and two SEA build
assertions all pass inside this full run. All nine current required gate commands
exit 0. Existing LOC and 1.65 MB renderer bundle warnings remain unchanged.
Tracked source and the index remain clean, HEAD is unchanged, and current source
fingerprints match the checkpoint. This worker reviewed the actual receipts and
raw assertion outcomes; it does not claim a fresh-agent completion-gate PASS.

Evidence is retained only in the assigned queue checkout at
`docs/plans/2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-03-verifier-round2-rerun/`.
It preserves the failed attempts, actual process exits, corrected-runtime command
receipts, final audit and unchanged-source fingerprints. The report and seal are
written before cleanup; the separate cleanup receipt records actual removals and
seal revalidation afterward. Private dependencies remain for the verifier, while
task-owned scratch, refreshed build output and private compile caches are removed.
No commit, staging, branch/worktree operation or document rename was performed.
The six existing real-provider/application live acceptance sections remain open;
no browser, installed application window or real provider campaign was exercised.

### Merge-conflict resume handoff — 2026-11-05

The coordinator's three in-progress conflicts are resolved and staged. The merge
remains open for the coordinator. No commit, merge abort, stash, branch/worktree
operation or document rename was performed. This canonical plan and the existing
live-test document remain untracked in the root checkout and were never copied
into the assigned queue checkout.

Codex retains the branch's synchronous capture, ordered publication, bounded
replay protection, teardown epochs and current-thread checks alongside main's
usage-accounting ownership guard. Shared turn-result conversion already contains
main's structured error formatting and command output/exit accessors, so duplicate
adapter imports are removed. The native positive fixture retains ACK-after-handler
ordering and every assertion/deadline; the resolved file matches incoming main.
The session rail imports and registers both persistent list-load failure and new
queue-stage rows, matching the real template's calls.

The initial spec typecheck additionally reproduced TS2683 in an incoming queue
test that exactly matched main. Its mock now declares `this: PlanQueueCheckGroups`.
This fourth staged worker file changes no assertion or executable behavior; direct
TypeScript transpilation proves byte-identical JavaScript. The full fixture suite
passes, and the affected callback scenario passes again after the annotation.

Current focused checks cover 18 distinct files and 389 distinct passing tests,
plus that repeated callback scenario. Renderer/Electron and spec TypeScript
programs, Angular/fast lint, LOC/UI hints, alias/IPC generators, IPC verification,
package exports, contracts and both required builds pass. Generators/builds cause
no unstaged tracked drift. Existing lint/LOC and renderer bundle warnings remain;
five unrelated incoming EOF whitespace warnings are preserved. All four worker
paths pass staged whitespace validation, and no source conflict markers remain.

Two fresh read-only source reviews, including the final four-file scope, return
READINESS REVIEW: PASS with no concrete findings. These are source reviews, not
independent completion-gate PASS. The full suite was not run, as instructed; the
coordinator's independent gate and all six existing application/provider live
acceptance sections remain open. No browser, actual app window or live provider
campaign was exercised during this merge resume.

Evidence is retained only in the assigned worktree at
`docs/plans/2026-10-27-campaign-defects-runtime-followup_evidence/2026-11-05-merge-conflicts/`.
The report, exact command receipts, raw outcomes, source reviews and seal precede
cleanup. Its separate cleanup receipt records removals and post-cleanup checks.
Private dependencies and pre-existing caches remain for the verifier; no persistent
service, browser download, database cluster or copied project checkout was created.