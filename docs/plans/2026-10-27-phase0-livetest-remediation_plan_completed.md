# Phase 0 live-test findings, 27 October 2026

On main: code only (hand-merged 6 Nov 2026, commit `817a30b80`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Done: the six fixes (LT-820, 821, 822, 823, 824, 826) are on main (commit `817a30b80`), re-verified 10 Nov 2026. The two blocked-event fixes from the 12 Nov live run are now on this branch too: LT-1018 (`origin` on the cost event) and LT-1019 (`waitingSessionCount` on the update-pill event), each with a regression spec, and their register rows and sections. 13 Nov re-check: those two spec files (59 tests), `typecheck`, `typecheck:spec` and `lint` all pass.
Next: independent Queue verification and the full suite (the verifier's job), then the full-app checks in the [live-check document](2026-10-27-phase0-livetest-remediation_livetest.md). The 12 Nov desktop checks already passed there.
Decisions: LT-825 stays withdrawn. Retained-day audits still fail for corpus reasons and are not repaired. LT-1020 (a surviving loop-iteration child after Close all) lives on another branch and is not folded in.
Open: none in code. Round evidence: `2026-10-27-phase0-livetest-remediation_plan_history_06c6e37d505afada85112764a5890825a0d489a37e4461a8a900d4957df2ca6b_completed.md` (not needed to continue).
Do not rename or commit this active document; the verifier owns acceptance.

Source/acceptance: [Phase 0 live checks](2026-10-10-oct-phase0-confirmed-fixes_livetest.md#evidence-run--2026-10-27-plan-queue-current-worktree).
Defect index and detailed required behavior: [standing remediation register](livetest-remediation-register.md).
This follow-up is new because the historical July remediation plan is already `_completed`
and must not acquire new requirements. The existing tracked July follow-up belongs to another
queue item; this worker does not modify or copy it.

## LT-820: transcript comparison uses different prices from the app

- Reproduced with the current comparator and current application pricing, using a disposable
  one-million-cache-read-token Opus 5.5 diagnostic: app $0.20, comparator $0.50, comparator
  with its supported base-price override $0.40. The diagnostic is not a live-provider pass.
- Implementation: **implemented and worker-verified**. Versioned input/output/cache rates and explicit
  cache overrides now match committed application pricing. Historical model rates, missing/unpriced
  caveats and the five-percent threshold remain. Both retained-day audits were rerun and still fail;
  their remaining corpus/history differences are recorded below, not hidden or repaired.
- Acceptance: [LT-820](livetest-remediation-register.md#lt-820). Rerun both retained real-day
  comparisons after fixing the comparator; their current failure is not an established
  overbilling percentage.

## LT-821: retained accounting contains an apparent cumulative duplicate

- Read-only production evidence: instance `cp6lr11gj` records $306.04632500000037 at
  2026-10-26 22:39:43 UTC under a new native session ID, with zero input/output/cache tokens.
  That equals the sum of its preceding five entries under native session
  `c6ea2c69-e20e-45e2-b065-b92b80852588`. The attribution log independently carries the amount.
- Implementation: **implemented and worker-verified**. A real native fork inherits its source
  cumulative dollars and model counters. The old ledger reset a fork to zero and rebooked that
  history. Forks now read the source cost-state and subtract inherited dollars/model usage, with
  unknown-seed and real counter-reset behavior preserved. Native and focused writer regressions pass.
  The exact callback/argv sequence of the retained October row is not available and is not asserted.
- No historical row, backup or marker was changed. This record does not authorize a repair
  against retained history. Acceptance: [LT-821](livetest-remediation-register.md#lt-821).

## LT-822: model-breakdown cost events fail renderer validation

- Reproduced in the rebuilt dev app. The main logger reports `cost:usage-recorded` rejected
  with `Unrecognized key: "byModel"` on actual priced Claude completions.
- Executing source before remediation: CostTracker attaches `byModel` and emits the entry; cost IPC forwards it
  unchanged; the main event bus validates against strict `CostEntryEventSchema`, which has
  no `byModel` field. The event is suppressed before renderer delivery.
- Implementation: **implemented and worker-verified**. The cost event now explicitly accepts a
  bounded, strict per-model delta array. Real producer/handler/validator regressions and priced
  native completions pass without loosening unrelated event fields.
- Acceptance: [LT-822](livetest-remediation-register.md#lt-822).

## LT-823: a deferred tool permission ends a loop before the operator decides

- Reproduced on a real `/goal` reading a disposable fixture. Deferred Bash permission events
  reached the main manager at 09:21:46 and 09:21:48 UTC; the invocation was retried and the
  loop ended `error: Claude CLI cancelled`, zero completed rounds, while the parent session
  remained `waiting_for_permission`. No operator refusal caused that loop outcome.
- Implementation: **implemented and worker-verified**. Borrowed resident requests survive the
  native defer/exit and resume on the same adapter after an explicit decision. The hidden-input
  handler leaves these requests to the operator, and loop timeouts exclude the wait. Real native
  approval executes once; refusal leaves no marker and returns a visible refusal. Full goal/card
  desktop composition is recorded in the linked live checks.
- Acceptance: [LT-823](livetest-remediation-register.md#lt-823).

## LT-824: Costs page renders a literal backslash before dollar amounts

- Reproduced from real isolated provider data in the built Angular renderer. Per-model,
  per-session and recent-entry cells contain a literal `\$`, not just a dollar sign.
- The external HTML template includes backslashes before dollar text. They are literal HTML
  characters, not TypeScript template-literal escapes. The new purpose table does not use
  that spelling.
- Implementation: **implemented and worker-verified**. Literal HTML currency backslashes are
  removed; narrow metric/chart/budget grids no longer clip their cards. The production Angular
  template, Sass and global CSS passed automated 1400px/420px rendering, estimated/unknown-cost
  assertions and screenshot review. Acceptance:
  [LT-824](livetest-remediation-register.md#lt-824).

## LT-1018: priced cost events still blocked by the renderer (new key `origin`)

Found by the 12 November live run: every priced completion's `cost:usage-recorded` event carried `origin` and was rejected by the
strict schema, so the renderer never heard it. **Fixed and verified live** (schema field, regression test, rebuilt-app events at
1.8 s with the Costs page updating 0.17 s later). Detail: [LT-1018](livetest-remediation-register.md#lt-1018).

## LT-1019: CLI update pill event blocked at start-up (`waitingSessionCount`)

Found in the same run; same defect class, different channel. **Fixed and verified live.** Detail:
[LT-1019](livetest-remediation-register.md#lt-1019).

## Withdrawn provisional observation: delayed initial goal

The immediate blank-session goal completed its first round at 10:14:03 UTC and paused
for operator sign-off. The earlier repeated round-zero readings showed a long-running
invocation, not a demonstrated deadlock. The provisional LT-825 index entry was removed
before registering a defect; no fix is required from that inference. Retained timeline
records the delay and completion without asserting a cause.

## LT-826: Close all leaves the original resident provider alive

- Reproduced at 10:18 UTC: Close all confirms and cancels the borrowed loop, then removes
  session `clnvef0s0`, but its original Claude PID 94693 remains alive. Native macOS process
  inspection at 10:19:11 confirms the Claude executable, original start time and parent
  app PID 14279. This is not a new provider spawn or a reused PID.
- Implementation: **implemented and worker-verified**. Borrowing no longer starts a one-shot
  child over the resident process reference. One-shot/streaming overwrites and overlapping sends
  are refused; controlled restarts reap the old process first. A real native run through the actual
  loan registry and instance termination coordinator leaves no instance/adapter or surviving PID
  after a five-second observation. Full Close all confirmation is an explicit remaining live check.
- Acceptance: [LT-826](livetest-remediation-register.md#lt-826). Require original and invocation
  process exit plus no delayed respawn. Explicit worker cleanup is not a product fix.

## Verification and authorization boundaries

- The originating worker builds and exercises the current app, retains dated per-check
  evidence, registers these findings and cleans up its own runtime. It does not implement
  remediation, change tests, weaken thresholds, commit, stage or close active documents.
- Fixes require focused regressions, normal project gates, the linked real runtime checks and
  a fresh independent completion gate. Worker verification is recorded below; the queue verifier
  still owns the independent gate and full suite.
- Production history repair, cancelling selected historical runs, shared-service outages and
  releases have not been performed. Existing scoped readiness is not new authority for them.

The originating register entries survive on parked branch
`queue/2026-10-10-oct-phase0-confirme-304ca3`; its old worktree is absent. Retrieve them with
`git show queue/2026-10-10-oct-phase0-confirme-304ca3:docs/plans/livetest-remediation-register.md`.
No unrelated July plan or shared register was overwritten by this worker.

Worker report, source seal and receipts from the 3 November round were kept on the parked branch,
which no longer exists; they are not in this worktree. The 10 November re-run is in the history file.
Full-app confirmations: [remaining live checks](2026-10-27-phase0-livetest-remediation_livetest.md).

## Remediation worker ledger

Acceptance was recovered read-only from the originating parked queue branch
`queue/2026-10-10-oct-phase0-confirme-304ca3`, because its old worktree link is absent.
There is no separate linked spec; the recovered LT sections and owning campaign are the acceptance source.
No historical database mutation is authorized. No branch, commit, stash or worktree will be created.
The coordinator performs the full suite and independent gate; this worker performs targeted tests,
static checks and review, and leaves this filename unchanged.

- [x] LT-820: versioned transcript pricing, override semantics, two retained-day audits.
- [x] LT-821: native evidence, cumulative settlement across identity changes, writer regression.
- [x] LT-822: strict cost event contract and producer-to-validator regression.
- [x] LT-823: held permission waits for a real decision and resumes without replay.
- [x] LT-824: Costs currency text and rendered formatting.
- [x] LT-826: borrowed provider lifecycle preserves process ownership and closes cleanly.
- [x] Targeted tests, static gates, generated-output checks and self-review (independent gate remains the coordinator's).
- [x] Report, source seal, receipts, runtime cleanup and live-check handover.

Ruling: LT-823 and LT-826 share the borrowed Claude adapter request path; investigate and
verify them together so permission recovery does not lose process ownership.

### Current evidence and implementation decisions

- Comparator: a dated offline table now uses explicit model versions, current app input/output/read
  rates, native 5-minute/1-hour write rates and optional explicit cache overrides. Unknown future
  versions remain unpriced. Focused parity tests pass. Both retained days were rerun read-only:
  26 October still exits 1 (stored $7970.542361265011, transcript $2505.3496208049996,
  218.14092113435163% gap; 31 stored-only, 32 transcript-only); 19 October still exits 1
  ($1068.2542721649997 vs $1213.2567703800003, 11.951509503597062%; 7/24 one-sided).
  Neither gap is an established overbilling percentage or a reconciliation pass.
- Native retained evidence: the original transcript's cost-state is exactly $306.04632500000037,
  matching the preceding five entries and the zero-token row. A real native fork reproduced
  inherited totals: before the fix, source $0.0026191300000000003, fork total/charge
  $0.0034881500000000006 (new spend was only $0.0008690200000000003). The fix seeds both dollars
  and per-model counters for `fork` as well as `resume`. After the fix, source
  $0.011408940000000003, fork total $0.012238130000000003, booked new spend
  $0.0008291900000000005; exact model deltas also pass. Unknown inherited history stays unknown,
  fresh conversations still start at zero and actual counter resets are supported. The earlier
  duplicate-receipt heuristic was removed in favor of this observed native contract. The precise
  old-row interleaving remains unproven; no history, backup or migration marker was changed.
- Borrowing: inherited `requestResponse` used one-shot `sendMessage`, which replaced `this.process`
  while the original resident remained alive. Borrowed requests now send on the resident pipe.
  The permission handler resumes the SAME adapter while its request is pending, without replaying
  the original input. Loop deadlines exclude the explicit deferred wait. Owned hidden children keep
  their prior refusal behavior. Paid segments before a defer and after recovery are counted once;
  cancellation retains known partial usage. Spawn-time wrap-up restrictions require an owned restart
  and are removed again before returning the session to normal chat.
- Native smoke (invisible automated Electron runtime, no desktop/browser window): two real priced
  resident turns keep the original PID, update the real tracker, and pass the real strict event
  validator with model breakdown. Real native defer waits; approval executes one marker command once;
  refusal produces a visible refusal and no marker. The final native run also covers a real native
  fork and actual loan/instance termination, with empty maps, released loan and no delayed provider
  respawn. Every recorded native PID exits. This is not a click-through of the full desktop window.
- Costs: the real Angular template renders dollar amounts without backslashes. The first narrow
  headless automated render exposed pre-existing clipped metric cards; a small page-local grid
  breakpoint addresses this as part of the required narrow-layout acceptance. Normal/estimated
  labels and unknown-cost exclusions remain exercised. No ordinary Mac browser session is used.
- Contract: `byModel` is explicitly bounded and strictly typed in the cost event. A real tracker →
  cost handler → renderer validator regression accepts measured/estimated breakdowns while rejecting
  unrelated fields and invalid model dollars. The shared test ledger is cleared between cases to
  prevent budget assertions consuming an earlier case's spend.

Final worker gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run lint:fast`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, both builds,
41 affected test files / 608 tests, native smoke, 1400px/420px renderer smoke and `git diff --check`.
All exit 0. Alias and IPC generators also ran; their tracked output is unchanged. The renderer
retains its existing bundle-budget warning. No full suite was run, as explicitly required by
the worker brief; the coordinator performs that suite and independent gate.

Read-only coverage diagnostics: 26 October has $3482.7511456100037 stored-only and
$44.109590400000016 transcript-only; even the shared-session portion remains
$4487.791215655007 stored vs $2461.2400304049997 transcript-priced. On 19 October those amounts
are $33.71875958999999 / $42.71389837999999, with $1034.5355125749998 vs $1170.5428720000002
in shared sessions. Cross-midnight work, cumulative inherited history and missing transcripts
remain real caveats; no historical amount is certified by these comparisons.

Test-integrity notes: an existing continuation spec deliberately asserted the old process leak;
it now asserts retained ownership through `requestResponse`. An existing fork expectation assumed
a zero baseline; it was updated only after live native proof and the corrected native run. Other
expected accounting totals were not weakened. The old cache-duration fixture now names its
historical Haiku version explicitly, because the moving `haiku` alias has a different current rate.

Current instructions override stale campaign-runbook advice about Mac fallback, appending to a
completed July plan, bare spec typecheck, and avoiding a dated evidence report. This queue task
explicitly requires receipts/report/seal and reserves the full suite and acceptance for its verifier.


### Worker handover and cleanup

Implementation and worker checks are ready for the independent Queue verifier. The report is
`docs/verification/2026-11-03-phase0-remediation/README.md` (parked branch, no longer available), with
`source-check-seal.json`, `verification-summary.json`, command receipts and retained logs.
The seal covers every changed source and the relevant unchanged execution dependencies; it is
not an independent PASS. Initial failed/superseded checks remain in the receipt history. Seven
early overwritten logs are marked unavailable; all final checks have retained matching hashes.

After writing report/seal/receipts, the worker removed its compiled `dist`, isolated native
profile/workspace/temp files, headless renderer bundle/profile and exact owned native transcript
project directory. `cleanup-receipt.json` records all four paths absent and ten recorded native/
browser PIDs gone. Shared dependencies, shared dependency caches, installed browsers and original
production evidence remain. No database cluster or checkout copy was created. Broader process
enumeration with `ps` returned EPERM; recorded PID checks succeeded, and no wider process-state
claim is made. The implementation source hashes still match after cleanup.

The active plan and adjacent live-check document remain untracked in the root checkout. No
completion rename, stage, commit, branch switch or full suite was performed. Full desktop
confirmations are explicitly pending in the linked live-check document; independent acceptance
and the full suite belong to the Queue verifier.

> Plan Queue parked work: `queue/2026-10-27-phase0-livetest-rem-d0d92e` — 12 commit(s), reason: land-blocked.
