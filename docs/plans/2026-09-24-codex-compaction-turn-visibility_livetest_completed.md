# Codex Compaction Turn Visibility — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-24-codex-compaction-turn-visibility_plan_completed.md](2026-09-24-codex-compaction-turn-visibility_plan_completed.md)

> **Register renumbering, 2026-11-08 merge of main:** main already uses LT-710, LT-711 and
> LT-712 for other defects. This document's LT-710 (stale replay) is now **LT-1013**, its LT-711
> (inferred completion) is **LT-1014**, and its LT-712 (startup migration race) is **LT-1015**,
> which duplicates main's **LT-710**. Historical sections below keep their original numbers.

## Current status — 2026-10-27, verified; coordinator closure pending

**Live checks: 7 passed · Open live checks: 0 · Canonical verification: PASS · Independent gate: VERDICT: PASS.**
Check 1 has current frozen-build native-compaction, exactly-once delivery and
renderer-reload evidence, plus genuine unsent recovery and local-reply coverage.
Checks 2, 3, 5, 6 and 7 retain their scoped round2 evidence; check 4 retains the
resumed full 35-minute controlled watch. They are not presented as all-new runs.

All original verifier findings and the two subsequent ownership findings are
repaired. The third fresh reviewer has independently passed every canonical gate,
including the actual unfiltered full suite, and has no actionable code finding.
Its final written verdict is **VERDICT: PASS**, with no unresolved actionable
finding within these repairs. The full rerun uses
the already installed project-pinned Node after diagnosing the first full run's
SEA capability failure. No source/test/config/dependency change hid that failure.

Separate display follow-ups LT-716/717 and external test-formatting follow-up
LT-718 remain recorded and are not claimed fixed. The dev app and all owned
processes are stopped. Owned runtime/build/scratch outputs were removed after
report/receipts and the pre-cleanup seal; pre-existing dependencies/caches remain.
There is no James-only step. The coordinator owns any completed-name rename.

## Prior status — 2026-10-27, resumed queue item

**Open: 1 (check 1) · Passed: 6 (checks 2–7) · Failed: 1 (check 1).**
Both remaining checks have new dated evidence in the resumed-run section below.
Check 4 passed a full 35-minute controlled native-compaction watch with the normal
30-minute idle control and post-completion sweep evidence. Check 1's single-idle
clause passed, but a renderer reload caused a second delivery, filed as **LT-715**.
The five earlier passes retain their scoped round2 evidence; they were not all rerun.

The full suite still fails: two failures reproduced in focused rerun, involving
unlocked installed packages and the worker import-count limit. Other canonical gates,
both builds, native archive smoke and focused tests pass. No product source, tests,
manifests or verification settings were changed by the resumed worker. Independent
acceptance remains with the coordinator. This document stays open under its original
filename; there is no James-only step.

## Prior status — 2026-10-27, verifier correction round 2

**Open: 2 (checks 1 and 4) · Passed: 5 (checks 2, 3, 5, 6 and 7) · Failed: 2
(the same two open checks).** All seven checks have current dated evidence below. This
document is not complete and has not been renamed. Canonical verification also remains
blocked by the dependency-install check; the independent completion gate is **FAIL**, with
a scoped code-review PASS and no actionable findings in the two-adapter patch.

The missing `_scratch/lt-2026-10-04/b/` folder cannot support current pass claims. Those
historical claims, including “judged acceptable” for two idle edges and the 2026-10-06
six-of-seven count, are superseded by this accounting. Historical sections are retained.
Checks 2 and 7 now have actual configured-action live evidence, rather than closure as
superseded. Check 3 now includes DOM and the next native usage, and LT-681's register
status has been reconciled. No prior scratch-only result is needed for these five passes.

New defects are filed as LT-710 (stale replay; patched and live rechecked), LT-711
(inferred completion during inline compaction; patched, with the separate long-duration
limit in LT-714), LT-712 (startup migration failure; open), LT-713 (double idle around
queued delivery; open), and LT-714 (15-minute capture timeout vs 35-minute criterion;
open). Implementation status is in the untracked root-checkout
[follow-up plan](2026-10-27-codex-compaction-lifecycle-followup_plan.md). The historical
completed remediation plan was not extended. No James-only step has been identified.

**Prerequisites:**

- Install or restart Harness from the DMG built from this checkout. The implementing session runs
  inside the app being changed, so it cannot replace James's active Harness process in-loop.
- Use a real Codex app-server session with context policy enabled. Record the instance ID and the
  time window for every check.
- Evidence sources: `~/Library/Application Support/Harness/logs/app.log`,
  `~/Library/Application Support/Harness/logs/lifecycle.ndjson`, and the conversation ledger.
- Keep the app open for the full 35-minute hibernation check; do not count a provider turn that
  finishes before the observation window as a valid long-compaction case.

## Status — 2026-09-24

Open: 7 · Closed: 0 · Failed: 0

All code, focused tests, canonical gates, production builds, and the independent completion gate
passed. These checks remain open only because they require the rebuilt application, real provider
behaviour, or elapsed wall-clock time.

## Check 1 — LT-654: user send during provider auto-compaction

1. Start a Codex session and push it past 75% context (a long file-read loop is suitable).
2. Wait until `app.log` records `item/started` for a `contextCompaction` item.
3. Send one message while that Compact turn is still running.
4. Follow the instance transcript, status transitions, and app log until the Compact turn and the
   queued message finish.

**Expected:** the composer says Codex is compacting and that the message will send afterwards;
exactly one queued message is visible; no error card or `Failed to send message after N retries`
notice appears; the message is delivered once after the Compact turn closes; status remains busy
throughout compaction and transitions to idle exactly once after the delivered turn completes.

## Check 2 — LT-654: controlled recovery continues on the same thread

1. Trigger the configured controlled recovery while a Codex turn is above the 80% boundary.
2. Record the original thread ID, the interrupt, compaction lifecycle, continuation, and terminal
   status from `app.log` and `lifecycle.ndjson`.

**Expected:** the transcript says Harness interrupted the turn, observed compaction, and is
continuing; a new assistant continuation turn actually runs on the same thread; no `Codex error:`
bubble appears; lifecycle status never enters `error`; busy is retained through the continuation
and ends at idle once.

## Check 3 — LT-655: truthful context meter and compaction presentation

1. Observe the header meter immediately before, during, and after the compaction from check 1 or 2.
2. Continue until the first post-compaction `thread/tokenUsage/updated` event arrives.

**Expected:** while compacting, the header and composer show the compaction state. After the
boundary, the meter shows the last non-zero occupancy as estimated (or an explicit “awaiting
updated usage” state when no prior reading exists), never a fabricated 0%. The next real usage
event replaces the estimate. The boundary copy says Codex compacted its own context and the
`Recover context` action remains available because it restores the bounded wake/verbatim context.

## Check 4 — LT-654: compaction excludes idle hibernation

1. With idle hibernation enabled, obtain a provider compaction that remains active long enough to
   observe the sweep.
2. Leave the session untouched for 35 minutes while the Compact turn is still running.
3. Inspect the instance state and hibernation logs throughout the window.

**Expected:** the instance remains busy and is never hibernated, superseded, restarted, or killed
while provider compaction is active. Normal idle eligibility resumes only after compaction closes.

## Check 5 — LT-656: policy/action/compaction diagnostics

1. For the sessions above, extract the matching `ContextSafetyPolicy`, `ProviderContextAction`,
   `Codex compaction started`, and `Codex compaction completed` lines from `app.log`.
2. Extract the matching `provider-compaction` records from `lifecycle.ndjson`.

**Expected:** policy records identify instance, trigger, action, reason and occupancy; action
records include requested/acknowledged/observed/none/skipped proof; compaction records identify
instance, thread, Compact turn, trigger, terminal outcome and duration. Start and completion are
first-class records without joining the provider capture database.

## Check 6 — LT-652 regression: renderer backoff remains intact

Repeat the LT-652 live scenario from the remediation register: send during Codex auto-compaction.

**Expected:** the message queues and delivers after compaction, with no rapid retry storm and no
`Failed to send message after N retries` notice. If a pre-notification Compact rejection reaches
the renderer, its retries respect the configured 15-second backoff and expanded bounded budget.

## Check 7 — LT-653 regression: policy steer is not attributed to James

Trigger or observe a context-policy `steer-turn`, then let the agent continue and inspect its next
response plus any plan/handoff text it writes.

**Expected:** the agent treats the steer as an automated system context-policy action, continues
James's original task, and never claims that James asked it to stop or change scope.

## Status — 2026-10-06

Open: 1 (check 4, the 35-minute hibernation watch, not run) · Closed: 5 · Failed: 0 on the meter.
Check 3's fabricated 0% did not reproduce on a manual compact. This file stays open.

## Evidence run — 2026-10-06

Dev app `/tmp/aio-lt-1006`, Codex instance `xq4912snd`, idle. `compactInstance` returned
`method: "native"`. Before: 60,908 tokens, 23.6%. The result's `newUsage` and the live
instance afterwards both kept 60,908 / 23.6%, with `source: "awaiting-post-compaction-usage"`
and `isEstimated: true`. The meter was not 0%. Transcript rows included "Codex is compacting
the conversation before continuing.", "Codex compacted the conversation to free context space.",
and "Codex finished its provider compaction turn." This was a manual compact, not the
self-managed path from check 2.

## Status — 2026-10-04

Open: 1 · Closed: 5 · Failed: 1. Check 3 failed (LT-681); check 4 not run. This file stays open.
Closed means checks 1, 2, 5, 6, 7. Checks 2 and 7 are closed as superseded (see their entries), not
passed as written.

## Evidence run — 2026-10-04 (batch B, dev app, current working tree)

Environment: dev app on isolated profile `/tmp/aio-lt-1004-b` (CDP port 9471), codex-cli 0.160.0,
model `gpt-5.6-sol`, window 258,400. Times are UTC (machine is on BST, +1 h). Launch deviation: the dev
app was started with `--no-sandbox` and the heap flag directly, because Chromium's own sandbox could
not initialise inside the agent shell's Seatbelt fence ("sandbox initialization failed: Operation not
permitted", GPU/network processes aborted, exit 0 within 2 s). That is a launch detail of the test app,
not a product result. Evidence: `_scratch/lt-2026-10-04/b/` (copies of the app.log slices and the dev
profile's `lifecycle.ndjson` extracts, which die with the `/tmp` profile otherwise).

Important change since this doc was written: since 2026-09-27 Codex app-server declares
`providerAutoCompaction: 'inline'`. Codex's own compaction is an item inside the running turn; only a
Harness `compactInstance` (Compact now) creates a separate Compact turn. So "provider auto-compaction"
here was exercised through both: Compact now for the Compact-turn path (checks 1, 3 manual, 5, 6) and a
real inline self-compaction (instances `x13dt4qqx`, `xyynqndg6`).

### Check 1 — PASS (Compact-turn path)

Instance `x1zvkexgy`, thread `01a10907-cf24-7d91-9452-30f64214298a`. Two runs; `compactInstance`
called, 2.5 s later a message typed into the real composer (textarea plus Enter).

- Run 1: compaction 22:30:20.503 to 22:30:32.444 (11,941 ms, `provider-compaction` started/completed in
  `lifecycle.ndjson`). Run 2: 22:31:19.339 to 22:31:33.691 (14,352 ms).
- During compaction: banner "Codex is compacting context / Messages will remain queued and send when
  compaction finishes."; composer hint "Codex is compacting… your message will send afterwards"; queue
  badge `1` (exactly one queued message); status `busy`.
- Delivery: exactly one `INSTANCE_SEND_INPUT` after the close (22:30:32.597 and 22:31:33.799); reply
  "ACK" / "ACK2" once; no error output (`errs: 0`), no "Failed to send message after N retries" text in
  the DOM at any sample (200 ms sampling, `c1b-timeline.txt`).
- Status: busy for the whole compaction; at the close the main process goes `busy -> idle` for 125-170 ms
  (22:31:33.691 to 22:31:33.816) and the renderer drains the queue on that edge, then `busy -> idle`
  after the delivered turn (22:31:37.194). So idle appears twice, not once; the first is the drain edge,
  which is the existing design. Judged acceptable; noted because the check says "exactly once".
- Real provider self-compaction is inline, so a send during it is an ordinary send to a running turn;
  not separately driven.

### Check 2 — CLOSED AS SUPERSEDED (confirmed unreachable for Codex)

Per the 2026-09-27 doc's related note. Instance `x13dt4qqx` ran through 80.77% mid-turn (22:36:35),
86% and 95% with `contextEvidenceModeByProvider.codex = enforce`. No interrupt, no compaction request, no
continuation: the rollout has no `turn_aborted` at all, there is no `ProviderContextAction` log line,
there is no `Codex error:` bubble, status never `error`. Reason in source: `context-safety-policy.ts:127-134`
skips known-occupancy actions when `providerAutoCompaction === 'inline'`. Detail:
`_scratch/lt-2026-10-04/b/AR-001-evidence.md`.

### Check 3 — FAILED on the Compact now path (LT-681); the self-managed path passes

- Self-managed (inline) compaction, `x13dt4qqx` 22:37:46 to 22:37:51: header 95% (`245,038/258,400`)
  to `~68,690/258,400 (~27%)` with the estimated flag at 22:37:51.55, then the real `73,586 (28%)` at
  22:37:57.95. Never 0%. Transcript row: "Codex compacted its own context (95% → 27%)". "Recover context"
  button present ("Queue preserved context for the next turn"). During the compaction the banner was up.
- Compact now path, `x1zvkexgy` and `xyynqndg6` (`compactInstance`): the header reads
  `~0/258,400 (~0%)` from the boundary (22:31:33.947) until the next real usage (22:31:37.147), and with
  no message queued (`xyynqndg6`, 23:06:12) it stayed `~0/258,400 (~0%)` for the 40 s observed. The
  boundary row reads "Context compacted [native] (33% → 0%)". Real occupancy after the same compaction
  was 13% (34,028 tokens). Root cause `compaction-runtime.ts:96-125,512-514`. Filed as LT-681.

### Check 4 — NOT RUN

Needs a provider compaction that stays active for 35 minutes. Every compaction this run took 5 to 14
seconds (a 245k-token thread compacted in 5.2 s), so the idle-hibernation sweep window cannot be spanned
and no way to lengthen it was found. Left open for a run that can hold a compaction open.

### Check 5 — PASS (action-record clause not exercisable for Codex)

- `ContextSafetyPolicy` "Context policy decision" lines carry instance, trigger, action, reasonCode and
  occupancyPercentage (e.g. `x13dt4qqx`, `trigger: cumulative-2x`, `action: convergence-review`,
  `reasonCode: CUMULATIVE_CHECKPOINT_REQUIRED`, `54.145%`). Full list: `ar001-ladder-from-applog.txt`.
- "Codex compaction started" / "Codex compaction completed" lines carry instance, thread, turn,
  `trigger` (`self-managed` inline, `policy` for Compact now) and, on completion, `durationMs`
  (`x13dt4qqx`: 5,222 ms).
- `lifecycle.ndjson` has matching `provider-compaction` records with `phase`, `threadId`, `trigger`,
  `outcome: settled` (Compact now) and `durationMs`, no join to the capture database needed
  (`lifecycle-x13dt4qqx.ndjson`, `lifecycle-x1zvkexgy-slice.txt`).
- `ProviderContextAction` requested/acknowledged/observed/none/skipped records: none were produced
  because Codex no longer receives an executable policy action, so that clause could not be exercised.

### Check 6 — PASS (primary scenario)

Same runs as check 1: one send during Compact now compaction, no retry storm (a single
`INSTANCE_SEND_INPUT` per run, delivered right after the close), no failure notice. The
pre-notification Compact rejection (`ActiveTurnNotSteerable`) never reached the renderer, so the 15 s
backoff clause was not exercised.

### Check 7 — CLOSED AS SUPERSEDED (confirmed unreachable for Codex)

No context-policy `steer-turn` was ever issued to a Codex instance: 0 steer decisions across 70%, 75%
and 80% on `x13dt4qqx`, the only non-`none` decision being the non-executable `convergence-review`.
There is therefore no steer to attribute. (The attribution fix itself, developer-role injection
instead of `turn/steer`, is not exercised by this run.)

### Other observations

- Instance header interrupt button tooltip reads "Interrupt Claude (Esc)" on Codex sessions: LT-682
  (cosmetic).
- The Codex goal and join behaviour found while running this doc's neighbour is in
  `2026-09-27-codex-compaction-reliability_livetest.md` (LT-680).


## Evidence run — 2026-10-27 (queue worker; check 4 remains open)

**Outcome:** the only open check, check 4, was exercised partially. No check was closed in this
run. A real native Codex compaction remained busy through an actual idle-hibernation sweep;
an idle control hibernated during that compaction; normal hibernation resumed after completion.
The compaction lasted **154.021 seconds, not 35 minutes**. This is useful guard evidence, not a
pass for the required 35-minute observation. No human authority or fact is missing.

### Environment and evidence

- Source: queue worktree `queue/2026-09-24-codex-compaction-tu-23ae4a`, HEAD
  `80412201a07ec93cefb9a4b6ddb06579ad314d75`. No product source or test was changed.
- Isolated profile: `/tmp/aio-lt-queue-5223ae4a`; renderer CDP `9672`, main inspector `9673`.
  The surviving Electron process was independently identified through its inspector as PID
  `31471`, with this worktree as its cwd and exactly the required isolated user-data path.
- `npm run build:main` and `npm run build:renderer` both exited 0. The renderer used for later
  observations was this worktree's newly built production bundle, served only on loopback `4668`.
  Angular dev serving on `4667` produced a `_PlatformLocation` / missing JIT compiler error with
  the queue's pre-existing dependency symlinks into the root checkout. That setup failure is not
  evidence about compaction. No product defect or root cause is inferred from it.
- Launch used `--no-sandbox`. The initial launcher emitted a macOS sandbox-extension warning and
  exited 0; a retry with `--no-sandbox` also exited 0 because Electron's heap bootstrap relaunched
  it. The debug endpoint subsequently answered and identified the live process above. The
  launcher's exit and warning were **not** treated as proof that the app was unavailable.
- Every renderer evaluation first enabled `Emulation.setFocusEmulationEnabled`. This Chromium
  build rejected `Emulation.setPageVisibilityOverride` as unsupported; direct reads confirmed
  `document.hidden === false`, `visibilityState === "visible"`, and a requestAnimationFrame callback
  ran. Full header/composer acceptance checks were not repeated in this run.
- Context policy was changed from `off` to `enforce` for Codex in this disposable profile. Idle
  hibernation remained enabled; its visible idle-minutes setting was temporarily lowered from
  30 to 1 to make the sweep observable. Production clocks, compaction wait budgets, hibernation
  filters, and provider event contents were not modified.
- Durable evidence: [2026-10-27 receipts and log slices](2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-queue-5223ae4a/).
  `command-sources.txt` records the generated probes. `runtime-snapshot.json` records the
  observer, actual sweep ticks, provider notifications, settings, and instance identities.
  `app-log-slice.log` and `lifecycle-slice.ndjson` preserve only this run's three disposable
  instances; these copies survive profile deletion and production log rotation.

### Check 4 — PARTIAL; 35-minute requirement still NOT VERIFIED

1. **Rejected first attempt:** instance `xg86n896d`, thread
   `01a17b33-4eb9-7e20-a285-f1ec551901bc`, Compact turn
   `01a17b35-23d4-7802-b6b2-94259bbf8756`, 02:34:02.705–02:34:08.159 UTC. A direct
   app-server `thread/compact/start` and a stop signal to its launcher did not hold the real
   provider work open. Lifecycle evidence shows completion after 5.454 seconds. The watch was
   explicitly invalidated, the launcher resumed, and none of its later busy samples counts as
   long-compaction evidence. This direct request also bypassed Harness's normal compaction
   ownership path, so its residual busy state is not filed as a product defect.
2. **Valid shorter native-path probe:** instance `xvs93klhs`, thread
   `01a17b33-600b-7293-8fbf-3e954f62bdd6`, Compact turn
   `01a17b37-e33e-7a22-8b05-8923aac07402`. The real preload
   `electronAPI.compactInstance({instanceId})` started compaction. On the genuine
   `item/started(contextCompaction)` notification, the probe suspended this disposable direct
   app-server's isolated process group, then resumed it after **130.916 seconds**. A separate
   150-second failsafe was armed and cleared after successful resume. No fake lifecycle event,
   estimated elapsed time, or forced Angular refresh was used.
3. Lifecycle records delimit actual provider compaction at **02:37:02.678–02:39:36.699 UTC**,
   duration **154,021 ms**, completion `outcome: settled`, trigger `policy`. Samples every
   20 seconds showed status `busy`, the same thread/Compact turn, a live client, and
   `isCompactionRunning() === true` throughout the held interval. The target's `lastActivity`
   remained `1793068622678` until completion. There was no intervening error, hibernation,
   supersession, restart, or terminal status transition in the captured lifecycle records.
4. **Positive sweep control:** instance `xsreg45kb` became idle at 02:37:39.350 UTC. At
   **02:39:17.160 UTC**, while the target's Compact turn was still open, the real scheduled
   `check-idle` callback ran the wired root sweep and logged `Auto-hibernating idle root session`
   for this control, `idleMs: 97809`, `idleMinutes: 1`. It reached `hibernated` at
   02:39:17.189. The same callback's observer snapshot shows the compacting target busy.
5. The target's provider completion arrived at 02:39:36.699 UTC and it became idle at
   02:39:36.700. The subsequent sweep hibernated it normally at **02:41:24.198 UTC**, about
   107.5 seconds after completion. This proves that eligibility resumed on the real runtime path.
6. **Residual:** obtain a qualifying provider compaction and retain genuine activity for the full
   35 minutes, then repeat the untouched-session watch at the normal setting. This campaign did
   not obtain that case. Current Harness-requested compactions use a 900,000 ms running wait
   (`src/shared/constants/limits.ts:168`, wired by
   `src/main/cli/adapters/codex-app-server-adapter.ts:127`; failure handling in
   `src/main/cli/adapters/codex/context-cost-controller.ts:379`). The runtime snapshot confirms
   the 900,000 ms value. Extending that wait or pretending a completed provider was still
   compacting would change the premise, so neither was used to manufacture a pass. This is a
   technical/provider-duration prerequisite, **not a request for James to approve or do work**.

### Other checks and verification limits

| Check | Current disposition |
| --- | --- |
| 1 | Prior 2026-10-04 Compact-turn send evidence retained; not rerun. |
| 2 | Prior closure as superseded retained; not passed as originally written. |
| 3 | Prior 2026-10-06 meter evidence retained. Supplemental IPC read after this native compaction kept 33,833 / 475,000 (7.12%), `source: awaiting-post-compaction-usage`, `isEstimated: true`; no fabricated zero. Header/composer and replacement by the next real usage event were not rerun. |
| 4 | Partial guard/control evidence above; **35-minute requirement open**. |
| 5 | Prior diagnostics evidence retained. This run independently captured start/completion records with thread, turn, trigger, duration and settled outcome in both app/lifecycle logs. Policy action-proof clauses were not exercised. |
| 6 | Prior primary-scenario evidence retained; no send/retry/backoff scenario rerun. |
| 7 | Prior closure as superseded retained; no steer attribution claim added. |

Focused verification passed: `idle-hibernation-sweep.spec.ts`,
`late-runtime-hibernation-step.spec.ts`, `provider-compaction-lifecycle.spec.ts`,
`instance-state-self-managed-compaction.spec.ts`, and `compaction-signals.spec.ts`
(5 files, 44 tests; runner exited 0). Both production builds exited 0. No product code or tests
changed, so the full suite, lint, and separate typecheck programs were not run; these results do not
replace the missing live duration. Independent verification belongs to the queue coordinator.

No compaction product defect was reproduced, so no new remediation item was created. The historical
backlog was not edited: its current header explicitly says not to add current status there
(`docs/plans/livetest-backlog.md:24`); this owning document carries the current result.

### Cleanup

Cleanup verified: all three disposable instances were terminated; idle-minutes, policy mode, and
default directory were restored and read back; the observer and temporary static server were
removed. Electron PID 31471, renderer PID 27731, and the two recorded provider launcher PIDs no
longer exist; all four owned listening ports reject connections. The isolated profile, newly
created `dist/` and `.angular/` trees, and runnable scratch fixtures were deleted. Pre-existing
dependency symlinks were preserved; no dependencies, browser binaries, or checkout copies were
installed. See `cleanup-beforequit.json`, `shutdown-check.json`, and `cleanup-receipt.json` in the
evidence directory. The queue worktree has no tracked changes or staged files. No commit, branch,
worktree, or completed-name rename was made. The root document and evidence remain for the
coordinator; the 35-minute check is still open.


## Evidence run — 2026-10-27 (verifier correction round 2)

**Outcome: five checks pass with new durable evidence; checks 1 and 4 fail and remain open.**
No commit, branch/worktree change, or completed-name rename was made. All edits to this
document are in the root checkout. Product code and the shared register were edited only
in the supplied queue worktree. The source patch is two adapters plus additive regressions.

### Environment, sources and as-built correction

- Queue HEAD remained `80412201a07ec93cefb9a4b6ddb06579ad314d75`; its merge base with
  `main` is the same commit, so the review includes the uncommitted working diff.
- Built the main process and production renderer from this worktree. The isolated app used
  `/tmp/aio-lt-queue-5223ae4a`, renderer CDP `9672`, main inspector `9673`, and an owned
  loopback server (`4668`, with the production bundle actually loaded from `4669`). Main
  PID 5791 was identified through its inspector with the exact worktree/profile.
- Every renderer probe first enabled focus emulation. Visibility override is unsupported
  in this Chromium, but the recorded DOM reads consistently report `hidden:false` and
  `visibilityState:visible`; no forced Angular change detection was used.
- Idle hibernation remained enabled at its normal **30 minutes**. No production clock,
  timeout, retry limit, provider event or compaction duration was changed. Policy was
  enforced for Codex in this disposable profile. Auxiliary LLM use was switched off in
  this profile for later fixtures; original values are retained for cleanup.
- A fresh-profile launch failed critical startup on duplicate migration insertion. Its
  console error is preserved in `startup-migration-failure.log` and filed LT-712. One
  restart of the same profile succeeded, without a database edit. An early Python static
  server dropped preload connections; the owned Node static server loaded the built UI
  successfully. These setup failures are not compaction passes.
- Durable evidence directory:
  [round2 receipts and reports](2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-round2/).
  `command-receipts.ndjson` contains probe source, timestamp, actual exit code, stdout and
  stderr. Each named `*-result.json` is a readback; repeated probes' earlier results also
  survive in the append-only receipts. `final-app.log.jsonl`, `final-lifecycle.ndjson`,
  `audit-proofs-result.json`, DOM timelines and test/gate receipts survive runtime deletion.
  File logger JSONL and human console formatting were distinguished when extracting
  scoped instance records; unrelated production-log records are excluded.
- `evidence-integrity-preflight.json` confirms the old scratch folder is absent. The prior
  worker's named app-log slice does exist; the current report does not infer its absence.

### Check 1 — FAIL: queued send succeeds, exact idle requirement does not

Instance `xs4v6yves`, thread `01a17b53-0cc8-7393-a368-68550ec92205`, native inline turn
`01a17b56-7007-7e70-a757-c0fe41edeb77`. Real provider usage was **371,551 / 475,000
(78.22%)** before the contextCompaction item started at `1793070630194`. The owned provider
process group was briefly suspended on that genuine start event and resumed after 34,151ms.

At `1793070663280`, text was entered in the real composer and sent using actual CDP Enter
key events. DOM evidence at `1793070663832` shows the compaction banner, the exact hint
“Codex is compacting… your message will send afterwards”, and **one message queued**.
The queued message was delivered once after compaction and replied `QUEUE_ACK_R2` once in
this run's window. No retry-failure notice was observed. An earlier idle preflight using
the same text was rejected as compaction evidence; count only this item's start-to-delivery
window, not all occurrences of the text in the campaign.

The real item and owning turn completed at `1793070689669`. The adapter emitted idle at
`1793070689674`, busy for queued delivery at `1793070690225`, then idle after its completion
(about `1793070695904`). This is **two idle transitions**, not the required one. The
intermediate idle edge currently triggers renderer queue drainage. Filed **LT-713**; no
acceptance was relaxed. Sources: `inline-dom-watch.json`, `ui-main-state.js` receipts and
`final-lifecycle.ndjson`.

### Check 2 — PASS: actual controlled recovery above 80%, same thread

Used the actual configured `ProviderContextActionExecutor` from the runtime coordinator,
not a replacement controller or fabricated provider notification. Current automatic Codex
occupancy interventions are disabled for inline compaction, so the configured recovery
was deliberately triggered by a real native usage notification above 80%. The earlier
22% action-path probe was supplementary and is not the threshold evidence.

- Same instance/thread as check 1; final preparation turn
  `01a17b69-c2e0-74e0-9be7-b4add160c56d`. At `1793071896037` the native usage notification
  reported **386,038 / 475,000 (81.271%)**, and the configured controlled-recovery executor
  returned `executed / acknowledged`.
- Interrupt completion arrived at `1793071896141`. Native Compact turn
  `01a17b69-d650-7a32-b232-44644d2751f3` started at `1793071896176` and genuinely completed
  at `1793071916847` / turn completion `1793071916849`.
- Transcript says Harness interrupted, observed compaction and is continuing on the same
  thread. The continuation is a real new assistant turn
  `01a17b6a-2738-7882-a0a3-61fd03835b4e`, started `1793071916866`, completed
  `1793071924933`, and answered the original inert-volume task with `VOLUME_READY`.
- In the actual recovery window (from final preparation dispatch `1793071891164`, excluding
  earlier preparation sends), status stayed busy through interrupt, compaction and
  continuation and ended idle once at `1793071924943`. No error status or `Codex error:`
  output appears in this window.

Sources: `arm-recovery-above80.js`, `wait-recovery.js`, `recovery-results.js` receipts,
`final-runtime-result.json`, ledger proof rows and matching app/lifecycle records. This
proves the configured action path, not that current policy automatically selects it at 80%.

### Check 3 — PASS: DOM, estimate and next real usage

- During the genuine inline compaction in check 1, header read 371,551/475,000 (78%) and
  the banner/composer explicitly showed compaction. `inline-dom-watch.json` captures the
  boundary “Codex compacted its own context (78% → 22%)”, an enabled **Recover context**,
  and the next queued turn's native usage replacing occupancy with 97,574/475,000 (21%).
  The provider had already reported 102,480 at the inline boundary; that measured reading
  is not described as an unmeasured estimate.
- The first manual `compactInstance` at `1793070762213` reused an already observed native
  compaction (the controller logged that reuse), and preserved **97,574 / 475,000 (20.54%)**, with
  `source: awaiting-post-compaction-usage`, `isEstimated:true`; direct header DOM became
  **~97,574/475,000 (~21%)**. `manual-dom-watch.json` records the measured-to-estimated
  transition; no fabricated zero occurred.
- The first subsequent native usage arrived on the `METER_USAGE_READY` turn after
  `1793070822998`; direct DOM at `1793070839907` showed **97,659/475,000 (21%)**, without
  the estimate markers. Recover context remained enabled on both boundaries.

Sources: DOM timelines, `manual-result.js`, `ui-state.js`, `usage-next.js` receipts and
provider usage notifications in `final-runtime-result.json`. LT-681's current correction,
index row and detail status now agree that this meter behaviour was live rechecked.

#### Fresh manual native request confirmation (same build, supplementary isolated restart)

To remove any reliance on the already-observed reuse, the same built app was restarted
with the same isolated profile (PID 61411), and a fresh Codex session `x2yg13iv7`, thread
`01a17b73-27a7-7eb0-9667-bc18af2f343c`, was created. `fresh-prepare.js` records measured
29,942/258,400 and `compactionObservedSinceCheck:false` before the manual call.
`compactInstance` at `1793072517971` produced an actual new Compact turn
`01a17b73-5ca7-7190-a51f-cc49fb42a5b9`: item started `1793072520483`, item completed
`1793072522733`, turn completed `1793072522741`. The DOM timer recorded its compaction
banner/composer and then **~29,942/258,400 (~12%)** with estimate metadata and enabled
Recover context. The next real usage event at `1793072543782` reported **31,284/258,400**;
the header at `1793072572467` showed **31,284/258,400 (12%)** without approximation.
This is a fresh native request, not an acknowledgement inferred from the wrapper result.
Sources: `fresh-manual-dom-watch.json`, `fresh-snapshot.js`, `fresh-result.js` receipts.
The representative manual occupancies were 20.54% and 11.59%, not the older 30% trigger.

### Check 4 — FAIL / OPEN: long hold stopped at the separate 15-minute watchdog

Instance `xjd5modv5`, thread `01a17b52-bb67-7f10-9d9b-f2744f78b28e`, native inline turn
`01a17b53-4808-7a21-94a3-5271bb937f28`, item `01a17b53-561e-7a82-a8d7-14ee7a530ea4`.
The owned direct provider process group was suspended on its genuine contextCompaction start
at **03:07:01.536 UTC (`1793070421536`)**, with a 36-minute resume failsafe. This was
controlled silence, not a claim that the provider naturally takes this long.

The patched app retained the same busy capture for samples through **872,513 ms**. At
`1793071321545`, the normal notification watchdog produced `Codex error: Codex turn stalled:
no notifications received for 900000ms`. Status became idle at `1793071321550`; the sample
at elapsed **902,684 ms** shows the provider still alive and compaction ID still active but
runtime capture cleared. The watcher failed its busy assertion, resumed the group at
`1793071324379`, and real provider item/turn completion followed at `1793071329074` /
`1793071329078` (actual lifecycle duration **907,539 ms**, not 2,100,000ms).

Filed **LT-714**. Source wiring: `CODEX_TIMEOUTS.NOTIFICATION_IDLE_ACTIVE_MS = 900000`,
`app-server-thread-runtime.ts`'s idle watchdog and capture-finally release. The existing
15-minute `COMPACTION_RUNNING_MS` was already known for manual compactions; the separate
notification watchdog also bounds this inline attempt. No timeout was extended, activity
fabricated, or early-completed provider counted as a 35-minute pass.

No hibernation, restart or kill occurred during the shorter busy interval. The control
`xlrclfbwd` was idle under the unchanged 30-minute setting but did not reach a scheduled
30-minute sweep before this hold failed. Its separate raw-compaction test passed below;
it is **not** evidence of a normal-threshold hibernation control. The full 35-minute watch
and post-completion normal-threshold eligibility/control remain unverified. No James-only
action is needed; this is a product/acceptance mismatch and provider-duration prerequisite.

Sources: `watch-long.ndjson`, `watch-failure-resume.json`, `failed-watch-state.js` receipt,
`final-runtime-result.json` and app/lifecycle slices.

### Check 5 — PASS: policy, action proof and compaction diagnostics exercised

The scoped app-log JSONL contains ContextSafetyPolicy decisions with instance, trigger,
action, reasonCode and occupancy; ProviderContextAction completion rows contain real
`steer-turn / executed / acknowledged`, `steer-turn / skipped / none / TURN_NOT_ACTIVE`,
`controlled-recovery / executed / acknowledged`, and `native-compaction / executed /
observed` outcomes. These are actual configured executor calls, not invented policy triggers.

Native action proof at `1793071459202`, `1793071459208`, `1793071475140` records requested,
acknowledged and observed stages. `audit-proofs-result.json` reads the actual durable
conversation-ledger context-policy rows, including those stages, controlled interrupt/
recovery proof and same-thread continuation. App logging summarizes action completion;
finer proof stages are retained as direct ledger events. No provider-capture-database join
is needed for start/completion or for these direct proof rows.

Compaction app/lifecycle rows independently identify instance, thread, turn, trigger,
duration and terminal outcome (including settled policy compactions). The controlled
recovery above has a matched started/completed pair. Sources: `final-app.log.jsonl`,
`final-lifecycle.ndjson`, `action-proof.js` and `audit-proofs.js` receipts.

### Check 6 — PASS: real queue scenario plus live controlled backoff

The real native-compaction queue scenario is check 1, with one later provider delivery
and no retry failure. To exercise the previously untested conditional renderer path, an
instance-scoped temporary IPC wrapper returned the exact Compact rejection for six sends
of one nonce. It did not alter provider events or production source; it forwarded every
other call unchanged and restored itself before the seventh, real provider dispatch.

`watch-backoff.ndjson` records seven attempt times:
`1793071023339`, `1793071038445`, `1793071053549`, `1793071068654`, `1793071083765`,
`1793071098871`, `1793071113975`. Gaps were **15,106 / 15,104 / 15,105 / 15,111 / 15,106 /
15,104 ms**. Thus there was no rapid retry drain and delivery succeeded beyond the former
five-attempt budget. The final provider replied `BACKOFF_ACK_R2` once; the wrapper's
restore readback is true. No failure notice was observed.

The configured bound remains 12 (`messaging-retry-disposition.ts`); this live test exercised
six controlled rejections and success, not exhaustion of all twelve retries. The full
suite's retry-disposition/queue tests passed; only the unrelated failures listed below
failed. This is explicitly fault-injected renderer evidence, separate from real provider
compaction. Sources: `arm-backoff.js`, `backoff-message.js`, `backoff-state.js` receipts and
`watch-backoff.ndjson`.

### Check 7 — PASS: actual policy steer, developer provenance and handoff

The actual configured executor invoked steer on a live tree-list task at `1793070974313`.
Its real request was `thread/inject_items`, containing a **developer-role** message that
labels itself “Harness context policy (automated; this is not a message from the user)”
and says the user has not requested a stop or scope change. The executor returned
acknowledged and added the Harness-authored system notice with `internalInput.actor:harness`,
`source:context-policy`; it created no policy text as a user transcript message.

The original 80-name tree list completed with `TREE_TASK_FINISHED`. The next handoff
response said the tree-list task was complete and that the context-policy instruction
did not change the original request; it described it as internal context handling. It
did not attribute a stop, pause or scope change to James. No file writes were requested
or made by these text-only tasks. The action arrived after that list had already been
delivered; the subsequent real model response/handoff is the attribution observation.

This deliberately triggers the configured policy action rather than waiting for the
automatic occupancy path (currently bypassed for inline Codex). Unlike the previous
“superseded” closure, the actual role, executor result, transcript notice and subsequent
response are all recorded in `policy-results.js` receipts.

### Verifier finding 2 — investigated, reproduced, patched and rechecked

The old rejected raw request's prolonged busy state is filed as **LT-710**, rather than
dismissed. A new pre-patch reproduction on `xc2pqc2jt` confirmed the exact cause:
`pendingProviderFollow` retained old Harness turn `01a17b4a-4782-7e51-87cd-dd9a1c542a20`,
which completed at `1793069873524`. Raw Compact turn
`01a17b4c-1969-7113-b2b7-9bd1dc6e2b94` completed at `1793069951588`; afterwards runtime
was busy capturing the already completed old turn, with origin `provider`. The earlier
worker's snapshots did not preserve that internal pointer, so this new reproduction
proves the mechanism without inventing its exact old replay ID.

Patch: ignore the current capture's own turn/started (including before turn/start's
reply supplies an ID), but retain a genuinely different subsequent provider turn.
Rebuilt raw-request control `xlrclfbwd`, Compact turn
`01a17b56-ef88-7480-925b-ba73a0c97a0a`, completed at `1793070683095`; it returned idle
at `1793070683100`, runtime activeTurnId null, pending followup null. This is the genuine
raw-request rerun, not an explanation based only on the normal compactInstance path.

The additional LT-711 fix prevents the armed 250ms inferred-completion timer from ending
a capture during inline compaction and reschedules inference when that item completes.
It does not change the distinct 15-minute watchdog. Sources include prepatch raw/state
receipts, `raw-fixed-control.js`, `control-state.js`, and the new regressions.

### Verification and limitations

- Both production builds, `tsc --noEmit`, spec typecheck, lint, TS size and UI
  hint checks exited 0. `gate-receipts.ndjson` and `build-main-postpatch.log` record them.
- Before patching, new regression cases failed (own-start ordering and inferred inline
  completion). Implementer focused verification passed 211 tests. Independent fresh
  verification passed the provider-turn suite (45) and adjacent runtime/controller/signal
  suites (66); no actionable code findings. Tests were added without skips, weakened
  expectations or configuration/dependency changes.
- Full suite exited **1**: four failures of 35,384 tests. Three Claude native-finality
  timing assertions passed in the isolated rerun. The remaining dependency-compatibility
  check fails because this queue's pre-existing dependency symlinks point at the root
  install, whose package.json/lockfile differ. Neither manifest nor those links changed.
  The gate remains failed; no clean dependency install or extra checkout was created.
- Independent `task-completion-gate` verdict is **FAIL for full completion**, scoped code
  review PASS. Its fresh output and exact independent run receipts are preserved in
  `independent-review.txt` and `test-result-receipts.json`. No complete claim follows
  from focused green tests, source existence, or the five live passes.
- No old scratch-only evidence is needed for current passes. The backlog's explicit
  historical-only rule was followed; current status stays in this owning document.

### Cleanup and seal

The report, command receipts and a pre-cleanup hash seal are written before deletion of
the owned runtime. `cleanup-receipt.json` and the final seal record the actual stop/removal
result. Pre-existing dependency symlinks and shared dependency caches are preserved; no
dependency install, browser binary or source-tree copy was created. The document remains
open under its original filename for the coordinator's verification.

Cleanup result (2026-10-27): all four disposable sessions across the final two launches
were terminated. Main inspector verified the owned provider groups gone, request wrapper
and observers removed, settings restored and zero instances. Both runtime supervisors
then exited 0; all owned ports 4668/4669/9672/9673 refused connections, and recorded app/
provider PIDs were absent. The assigned profile, owned dist/.angular outputs, round2
scratch fixtures and this run's test-cache/log originals were removed. Pre-existing
dependency links, shared dependency caches and the earlier worker's scratch result were
preserved. Full test logs survive as canonical-redacted `full-*.redacted.log` command
receipts with source hashes. No install, browser binary, checkout copy or automation was
created. See `cleanup-receipt.json`, `shutdown-readback.json`, and the final `seal.json`.


## Evidence run — 2026-10-27 (resumed parked queue item)

**Outcome:** both remaining checks have new evidence. Check 1's single-idle clause
passes, but a real renderer reload reproduced duplicate delivery (LT-715), so check 1
fails and remains open. Check 4 passes the full wall-clock watch and actual sweep
checks below. Prior checks
2, 3, 5, 6 and 7 retain their explicitly scoped round2 evidence; they are not relabelled
as new runs. No human-only prerequisite has been found.

### Source and environment

- Resumed the supplied queue checkout at `1c186487c96befe1412744948d838f85acca6c1e`.
  Its base is `80412201a07ec93cefb9a4b6ddb06579ad314d75`. Read both checkpoint diffs
  and the prior as-built/evidence sections. The later checkpoint already adds busy
  handoff, a finite 2,400,000ms observed-compaction budget, and startup migration/WAL
  coordination. These were not new edits by this worker.
- Rebuilt main and production renderer from this worktree, both exit 0. Owned static
  renderer server is loopback port 4668; Electron renderer CDP is 9672, main inspector
  9673. Main identity readback confirms PID 48384, the exact worktree cwd and assigned
  `/tmp/aio-lt-queue-5223ae4a` profile. The pre-existing profile and this worktree's
  pre-existing real dependency install were reused. No checkout copy was created.
- Launch used `--no-sandbox`. The initial no-CDP-page probe occurred before startup
  completed; the subsequent real page loaded normally. `ps` was explicitly denied by
  the OS (`Operation not permitted`), recorded in `baseline.json`. No SIGKILL is used.
  Provider ownership is identified through each app-server client's own child-process
  object, direct transport and app-server spawn arguments.
- Renderer probes first enable focus emulation. This Chromium rejects the visibility
  override as unsupported; recorded direct DOM reads are `hidden:false` and
  `visibilityState:visible`. No forced Angular refresh was used. Policy is enforced
  for Codex in this isolated profile; idle hibernation stays enabled at its normal
  30-minute setting. No Harness clocks, thresholds, provider notifications or timeout
  source values were modified by the probes.
- Durable evidence: [resume receipts](2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-resume/).
  `command-receipts.ndjson` preserves probe source, timestamps, actual exit codes and
  complete readbacks, including repeated readbacks before/after reload. Named result
  files are convenience views and can be overwritten by subsequent calls. Scoped
  app/lifecycle slices are copied before rotation/profile deletion.

### Check 1 — single-idle clause PASS; exactly-once recovery FAIL (LT-715)

The qualifying run is instance `xo10trvoy`, thread
`01a17b92-7f73-71c0-b4b7-e19b737e999a`, native inline turn
`01a17b96-6fdf-7403-830f-c8b44567dbf4`. Real native usage at `1793074824684`
was **374,195 / 475,000 (78.78%)**. Its genuine contextCompaction item started
at `1793074824863`. The owned direct provider group was suspended on that event
and resumed at `1793074849219`, a 24,355ms controlled hold.

- At `1793074830310`–`1793074830341`, actual CDP text/Enter input sent
  `Reply QUEUE_ACK_QUALIFIED only. Do not call tools or edit files.` through the real
  composer. DOM at `1793074838292` shows the compaction banner, the exact compacting
  hint, and exactly one queued message. The UI also displayed a “not saved” warning;
  the contemporaneous main readback did contain its durable queued admission.
- Native item/turn closed at `1793074858773`/`1793074858775`. Main published the busy
  queued-admission handoff at `1793074858782`. The actual next native turn
  `01a17b97-0c45-7f02-a0b7-923e52781c83` started at `1793074859094`, replied
  `QUEUE_ACK_QUALIFIED` once, and completed at `1793074865596`. Main reached idle at
  `1793074865601`, **the only idle edge from the owning preparation turn through
  queued delivery**. No retry error/card or failure notice occurred in that window.
  `ui-proof-result.json`, `ui-main.ndjson` and lifecycle evidence preserve these facts.
- `export-dom-result.json` contains 579 samples from the genuine start onward,
  maximum queue badge 1, 286 queued-message samples, 285 compacting-hint samples,
  and zero failure-notice samples. It also captures the truthful 79% → 21% boundary,
  enabled Recover context and the next measured 97,129/475,000 reading.
- **Additional actual recovery failure:** before renderer reload (`1793074970484`),
  the exact original admission was still `promoting` (64-character message), while
  the dispatch receipt had created another, delivered admission for its enriched
  263-character input. After own-dev-renderer reload at `1793074970851`, with no
  new user send, the same input was dispatched again. At `1793074986526`, the
  transcript had **two** real assistant replies and two delivered receipts; the
  original row was still promoting. Append-only `queue-receipt-proof.js` readbacks,
  reload receipt and native notifications establish the second delivery. Filed
  **LT-715** in the worktree register and active root follow-up plan. Check 1 remains
  open; the successful first delivery does not establish crash/reload exactly-once.

Preparation is explicitly excluded from that accounting: an earlier native inline
compaction began at 73.64%, and a provisional nonce sent while idle was not a queued
compaction send. An attempted 671,039-character volume input was rejected by the
existing 500,000-character IPC limit before provider dispatch. The corrected
251,039- and 427,439-character inputs produced the qualifying 78.78% run. No acceptance
was relaxed, no rejected payload counts as provider evidence, and the qualification
nonce differs from the provisional idle-send nonce.

### Check 4 — PASS: full 35-minute hold, normal sweep control and post-completion consideration

Target `x9f8vy36o`, thread `01a17b92-673c-7333-87e8-2fd399db5979`, genuine native
inline turn `01a17b93-f9dc-7090-9882-d9894869dc6f`, item
`01a17b94-076a-77b1-aab3-99097c75dc05`. Genuine item start at
`1793074661228` (04:17:41.228 UTC) follows real native 241,539/258,400 usage.
The owned direct provider process group was suspended on that real event, with an
automatic resume after 35 minutes plus one second and a separate 36-minute failsafe.
This is controlled provider silence, not a claim about natural service duration.
`long-inline-watch.ndjson` records state every 20 seconds and actual sweep ticks.
The idle control is `x87zwtbab`, idle since `1793074560049`; normal 30-minute
hibernation remained unchanged throughout.

1. **Full duration:** the group resumed automatically at `1793076762244`, after
   **2,101,016ms (35 minutes, 1.016 seconds)**. Its reason is
   `35-minute-observation-finished`; the failure flag is absent and the 36-minute
   failsafe was cleared. All 115 pre-completion samples show busy, an active capture,
   the same thread/turn/compaction ID and a live provider. Main state and lifecycle
   records contain no intervening idle/error, hibernation, supersession, restart or
   kill. The previous 900-second failure did not recur on this committed build.
2. **Positive normal-threshold control:** the actual scheduled root sweep logged
   `Auto-hibernating idle root session` for `x87zwtbab` at `1793076396680`,
   `idleMs:1836629`, **idleMinutes:30**. It reached hibernated at `1793076396761`,
   while the target's same native compaction remained busy and active. This is an
   actual sweep, with no aged timestamps, reduced idle setting or forced callback.
3. **Genuine close:** lifecycle completion at `1793076766969` reports duration
   **2,105,742ms (35 minutes, 5.742 seconds)**, trigger self-managed. Native item and
   turn completion arrived at `1793076766973`/`1793076766974`. Main became idle at
   `1793076766982`, with lastActivity reset to `1793076766983`; capture and compaction
   IDs cleared, provider stayed alive, and no error transcript row appeared.
4. **Normal idle consideration resumed:** the unchanged next scheduled sweep at
   `1793076774577` passed the actual target into `getHibernationCandidates` as idle,
   age **7,594ms**, threshold **1,800,000ms**, no async-work inhibitor and no
   turn-ending marker. Every earlier observed sweep omitted the busy target. The
   return correctly did not select such a recent idle session. The observer called
   the original method with its original inputs and returned its original result;
   it did not force a sweep or change eligibility. A further 30-minute hibernation of
   this particular target was not run; post-completion evidence is the real normal
   sweep and reset idle clock. The control independently verifies that threshold.

Sources: `long-inline-watch.ndjson`, `candidate-proofs.ndjson`,
`final-runtime-result.json`, append-only receipts, app/lifecycle slices and
`live-summary.json`. This validates the committed 40-minute bounded-compaction
behavior under controlled provider silence. It does not claim that backend
compaction computation naturally lasted 35 minutes. The ordinary 15-minute budget,
finite 40-minute compaction expiry and shorter explicit deadline remain covered by
the unchanged focused watchdog regressions.

The earlier manual-compaction watch attempt is invalidated: its probe required an
active ordinary-turn capture synchronously, while native manual compaction was
already owned by the separate compaction controller. It resumed immediately at
elapsed zero. The resulting 5.8-second lifecycle is a fixture preflight, not a long
watch or a product defect. Its original records remain in `long-watch.ndjson`.

### Verification, review and cleanup

Focused seven-file verification passes (105 tests), both builds, application/spec
typechecks, lint, size check, UI hints and native archive smoke all exit 0.
The full suite ran unfiltered with two workers and exited **1**: **2 failures of
35,408 tests**. Both reproduce in the isolated focused rerun, which also exits 1:

- The dependency-compatibility test reports extraneous MCP SDK and related packages
  absent from this branch's lockfile. `dependency-proof.json` confirms real local
  files and a real local install marker, with those package creation times before
  this worker began. This is a different failure from round2's linked-root-manifest
  mismatch. No install/prune or manifest edit was used to change the result here.
- The worker import guard measures 156 modules against strict `<156`. A read-only
  base-to-HEAD walk with the actual test parser measures **155 → 156**, only
  `src/main/persistence/rlm/rlm-wal.ts` added, no removals, zero Electron value-importers.
  `worker-closure-proof.json` preserves both full module sets and the parser hash.
  The test remains failed; its bound and assertions were not weakened or skipped.

All command exit codes are in `gate-receipts.ndjson`. Full runner output survives as
canonical-redacted `*-runner.redacted.log` files, with original/redacted hashes in
`log-retention-receipts.json`; JSON failure messages and counts are retained in
`*-test-summary.json`. The normal native archive smoke also passes. Automation IPC
readback is an empty list; no quota-reset automation was created.

Fresh review of this worker's evidence and document diff checked timestamps, the
first-delivery versus reload windows, saved-admission readbacks and the real sweep
inputs. It is an implementer/evidence review, not an independent PASS. No overall
coding completion is claimed. The coordinator owns independent acceptance and any
completed-name rename. The active root follow-up plan records LT-715 and both gate
failures; the historical completed remediation plan and retired backlog stay unchanged.

Cleanup follows the report, command receipts and pre-cleanup hash seal. Actual stop,
restoration and filesystem outcomes are recorded below and in the final seal.

Cleanup result (2026-10-27 resumed run): all three disposable sessions were terminated, settings restored and observers removed. Main/provider PIDs and the owned static-server supervisor are gone; ports 4668/9672/9673 refuse connections. The assigned profile, owned dist/.angular outputs and all this run’s scratch fixtures/log originals were removed after the report, receipts and pre-cleanup seal. Pre-existing dependency installs/caches and prior evidence remain. No new dependency install, browser binary, checkout copy, branch, worktree, commit or completed-name rename was created. See `cleanup-receipt.json`, `final-git-receipts.json` and `seal.json`.

The first filesystem cleanup attempt returned ENOTEMPTY for dist; readback found only a newly written .DS_Store file and no open handle in the lsof check. A bounded retry removed the remaining tree. The first failed receipt and both cleanup-source versions are retained; the final receipt records actual successful removal. No cause beyond that observed metadata write is claimed.

## Evidence run — 2026-10-27 (verifier finding repairs)

**Live result:** check 1 passes the normal observed-compaction send, exact delivery,
single-idle and subsequent renderer-reload checks. Checks 2, 3, 5, 6 and 7 retain
their scoped round2 evidence; check 4 retains the resumed full 35-minute controlled
watch. They were not all repeated in this repair. Full verification and independent
review are in progress. No overall completion is claimed yet. No check needs a
human fact, device or new authority.

### As-built repair of the three verifier findings

1. **LT-715:** explicit queuedAdmissionId passes from renderer drains and steer
   through IPC, preload, manager and communication into the provider-dispatch
   receipt. A parameterized SQL compare-and-swap claims only that instance's
   user-origin promoting row. Enriched text and elapsed preparation time do not
   affect ownership. A null promotion cannot send. An unsent local promotion
   retains ownership when Pause wins; restored rows do not gain ownership from
   null CAS. Rejected claims cannot become fresh-message retries. Ordinary
> Earlier journal sections moved to `2026-09-24-codex-compaction-turn-visibility_livetest_history_f362e2dc734131b17d49bc3ff246b1aac97a40fb36ed05eb16861fd6c9523497_completed.md`.
### Environment and durable evidence

Resumed source HEAD ec3a440a2749128671ea337a5e2be513c0bbf160, merge base with main
7e5222cfe773e2fc3edff0c2eade2e77fe7131cc. Product edits are only in the supplied
queue worktree. This document and the active follow-up plan remain in the root
checkout; no document copy or completed-name rename was made.

Rebuilt isolated app: main PID 87777, direct provider child 93289, profile
/tmp/aio-lt-queue-5223ae4a, static renderer port 4668, CDP 9672, inspector 9673.
The main inspector confirmed cwd/profile and its own provider child object.
Fresh-profile startup succeeded. Role/readiness choices affected that profile only.
The OS rejected ps with EPERM; no process-list evidence or SIGKILL is claimed.
Local Electron/CDP use is the explicitly requested dev-app test, not access to
James's everyday browser.

Each renderer probe enabled focus emulation first. The unsupported visibility
override was recorded; DOM reads show hidden=false and visible. No forced Angular
refresh, fabricated event, changed usage, product clock or timeout threshold was
used. Codex policy was enforce; normal idle hibernation stayed at 30 minutes.
Provider groups were briefly suspended on genuine compaction starts, with a
90-second resume failsafe, then explicitly resumed. This is controlled provider
silence, not a natural-duration claim.

Durable evidence: [verifier repair receipts](2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-verifier-fix/).
command-receipts.ndjson records exact probe source, timestamps and real exits,
including failed setup probes and corrected calls. gate-receipts.ndjson records
command exits. Repeated named result files are convenience views; earlier values
remain in append-only receipts. Scoped app/lifecycle copies survive rotation and
profile deletion.

### Check 1 — PASS: qualified queue delivery, reload and subsequent handoff

Instance xgm58olra, thread 01a17bc4-b8f6-7ca0-b779-d20907ff774d, actual model
GPT-5.6 Sol, native window 258,400. Inert numbered rows created real occupancy;
the provider was told not to call tools or edit files.

**First delivery/reload:** usage 205,147/258,400 (79.39%) preceded genuine
contextCompaction start at 1793077916814, turn
01a17bc5-aa44-7120-a75f-3a8efbab0f04. Composer Enter queued a 58-character request
at 1793077972706, admission 4d776890-3e56-4465-8430-76381eacff02. Its SQLite row
was queued before release. A real continuity preamble was queued through Harness's
existing runtime method to guarantee actual enrichment. Item completion at
1793077994082 led to busy handoff at 1793077994087 and one real dispatch at
1793077994412: 368 characters containing the original request. Codex replied
QUEUE_ACK_FIX once. The only idle edge from real compaction start through delivery
was 1793077997801. The original row became delivered at 1793077997802; there was
no separate enriched audit row or queued/promoting residual.

Renderer reload at 1793078035117, without a new send, did not dispatch again.
The corrected post-reload API probe waited 12 seconds, then read queues={} and
idle at 1793078076813. Original reply count stayed one. The first probe used the
nonexistent queueList preload method and failed; that call is not evidence.
The corrected sessionQueueList and main SQLite/provider reads establish the result.

**Second independent queued send and normal presentation:** another native
compaction began at 1793078085109 after measured 200,653/258,400 (77.65%), turn
01a17bc8-3915-7e23-8f49-79073bcee576, item
01a17bc8-45f3-7b40-9f75-bef809d934d7. No renderer reload intervened between its
start and composer send. At 1793078110049 the sole queued request had admission
13285228-3e1d-4515-b14e-fc8aaefb8e52, original text 65 characters. DOM at
1793078110668 showed the 78% meter, compaction banner, the hint that the message
would send afterwards, and exactly one queued message. No retry-failure notice
appeared.

Real completion at 1793078121797 led to retained-busy handoff at 1793078121803.
One enriched 375-character dispatch produced one QUEUE_ACK_FIX_SECOND reply.
Main reached idle once at 1793078125239 and the original admission became
delivered. Reload at 1793078189760 again read queues={} and idle after 12 seconds
at 1793078202190, without another dispatch. A later independent queue therefore
still drains; the first delivered row no longer blocks its head.

Sources: final-proof-result.json, ui-main.ndjson, ui-main-second.ndjson,
post-reload-wait.js receipts, both receipt readbacks, DOM timelines and scoped
logs. Preparation before each genuine item start is excluded from single-idle
accounting.

The first setup reload occurred during compaction to load the final renderer
bundle. It lost the compaction presentation (LT-717), so that first case is not
used as a presentation pass. Both cases also showed a stale not-saved queue
warning despite saved rows (LT-716). Those display defects are separately filed,
with their uncertainty, and are not described as fixed. The second case's normal
presentation and both actual delivery/reload receipts pass.

### Verification, independent review and cleanup

The first renderer build caught an optional-tuple type error, fixed before live
testing. The final renderer build passed. Main source did not change after its
successful build; final renderer source was rebuilt before both queued sends.
Focused queue, import/WAL/schema and dependency checks, both typechecks and normal
project lint pass. Full-suite result, remaining canonical checks and independent
verdict will be appended before stopping.

No source tree, dependencies or binary was copied into the evidence directory.
No install, browser binary, new branch/worktree, commit, stash or completed rename
was created. Cleanup follows report, command receipts and a pre-cleanup hash seal.

#### Independent correction before acceptance

The first fresh review returned **VERDICT: FAIL** for genuine unsent recovery.
A renderer crash after promotion but before send leaves a promoting row without
the new renderer's local ownership. Null CAS correctly refuses delivery, but the
only production stale-promotion sweep runs at main startup, so a still-running
main never reclaims that row. The new regression had manually invoked the sweep;
that was insufficient evidence of wiring. The delivery/reload passes above remain
valid; this separate required recovery case is still in progress.

The superseded full run was stopped with SIGTERM before source repair. All six
owned descendants were confirmed absent; actual signal/exit receipts are retained.
It is not a passing full-suite run. Repair and another genuinely fresh review are
required. The next live proof will wait the real existing five-minute reservation
window and exercise renderer restoration and its normal drain without invoking a
manual cleanup or changing timestamps.

#### Genuine unsent recovery — PASS after the real five-minute window

The correction renews a stale, still-unclaimed user promotion in the actual
promoteQueued SQL compare-and-swap, using the existing 300,000ms window. The
atomic timestamp refresh gives one recovery winner. Recent duplicate, recorded,
delivered, cancelled and non-user rows remain ineligible. The service-path
regression failed before this correction and passed afterwards; it exercises
listQueue/promoteQueuedMessage without manually invoking a sweep.

Rebuilt main and relaunched the same isolated profile, main PID 75382, direct
provider PID 85245, new instance xorsta8pu, thread
01a17bd9-ccb6-70f0-85b9-ad52c84cbee3. At 1793079263291 the real queue IPC
enqueued and promoted admission bd0343b9-db82-43c4-97de-129a46ba0bb7, without
calling sendInput. Only the renderer was reloaded at 1793079264034, representing
the crash window after promotion and before send. The real UI restored one queued
message. Main and provider were not restarted during the observation, no timestamps
were aged, and no promotion or sweep was manually called after staging.

Ten-second main snapshots retained the original promoting timestamp and zero
dispatch/reply while its reservation was fresh. At 1793079563966, just past the
five-minute boundary, it was still waiting for the next normal drain tick.
The normal renderer watchdog dispatched at 1793079564625, **301,334ms after
promotion**. Codex replied UNSENT_RECOVERED_ONCE once; the original admission
became delivered at 1793079567315. Main remained the same PID throughout and
the sweep observer recorded zero calls. The enriched provider input was 268
characters. No manual queue drain, cleanup, fabricated provider event or changed
production clock was used.

Another renderer reload at 1793079603191 read queues={} and idle after 12 seconds,
at 1793079616439, without another dispatch. Evidence: stage-recovery.js receipts,
recovery-watch.ndjson, recovery-final-result.json (including the executing promotion
method), post-reload-wait.js receipts and scoped logs. The disposable instance was
terminated, settings restored and observers removed; provider and app stopped.

The second fresh gate then found another successful-return route: a queued reply
consumed by a pending mode request, or a locally handled command, can return before
the provider receipt. That row also needs claim/settlement at its local action.
Its **VERDICT: FAIL** and passing interim static/build checks are retained under
fresh-review-two. That finding is being repaired and requires another fresh review;
no complete acceptance follows from the genuine-unsent pass alone.

#### Remaining return paths repaired; frozen-build live confirmation

The local-input helper claims an explicit queued row before a recognised mode
reply, typed compact/UI/goal command or command subtask acts, then settles that
same row. Delayed queued mode replies await the owned action instead of falling
through the recognition timeout into provider text. Compact preserves its existing
immediate dispatcher acceptance. Queued provider-limit holds use the existing
null-prompt park/switch path, behind the global-Pause fence, so the durable queue
retains its text instead of handing it to another turn's resender. A consumed,
unsupported attachment-only input is terminal failed rather than falsely delivered.
Receipt recording is idempotent within one send, while independent duplicate
claims are still rejected. Focused regressions cover these branches and failures.

Product source was frozen before final main/renderer builds, both exit 0. The
47-file source snapshot (including untracked local-input helper) still matches
after independent builds and live checks. The final isolated app is PID 82716,
provider 65226, instance xd4zofkee, thread
01a17bf8-ee81-7670-ae49-63613b76bd5d, with the required profile and debug switches.
Its renderer CDP port did not listen although main and renderer were healthy;
debug-port-proof.js preserves actual argv/switch and loaded window proof. No cause
is asserted. Final renderer calls used that same private window's built-in
webContents.debugger through the main inspector. Every call checks profile/URL,
enables focus emulation before commands, and records this transport. All captured
DOM samples are visible; no forced Angular rendering or provider event is used.

**Final check 1:** real usage 205,621/258,400 (79.57%) preceded genuine inline
compaction start at 1793081328113, turn
01a17bf9-b5d1-75c0-bc7f-34c0fa77d866, item
01a17bf9-c1ef-70a0-95b7-024cf64bce78. Composer Enter at 1793081376271 queued
the sole 60-character request under original admission
6b83e630-edda-4644-a84d-86d8987f8c4c. DOM showed one queue badge plus the
compaction banner and send-afterwards hint. Genuine completion at 1793081398422
led to retained busy at 1793081398431 and one enriched 370-character dispatch at
1793081398665. One QUEUE_ACK_FINAL reply completed; main's sole idle edge was
1793081402854 and that original row became delivered at 1793081402855.
The DOM timeline has 776 samples, 112 queued samples all with the compaction hint,
zero retry-failure notices, and every sample visible. Reload at 1793081456228
read queues={} and idle after 12 seconds at 1793081469055. No second dispatch
occurred. Sources: final-native.ndjson, final-native-summary.json,
final-native-export-result.json, final-native-proof.js and reload receipts.

**Final local-reply case:** a controlled pending mode request was seeded through
the real handler, rather than claiming Codex naturally requested it. With manual
Pause active, real composer Enter queued the plain reply `no` at 1793081514105,
admission 27b5cb36-76a8-4d22-939b-8005e5dd3f56. The row and pending request
were read before resume. Manual Pause was cleared at 1793081546656; the actual
mode handler declined the request once at 1793081548424 and the original row
became delivered at 1793081548428. The only provider call was the expected
289-character structured Harness response, not the raw user reply. Reload again
read queues={} and idle after 12 seconds at 1793081654277. A five-minute negative
watch continues before final cleanup. Earlier local-reply build evidence separately
retained the same delivered row and zero raw reply dispatch beyond seven minutes.

The built-in command branches, unsupported attachment outcome, provider-limit
holds, delayed local actions and Pause races are verified by focused runtime/store
tests; real quota exhaustion and every command's separate GUI workflow were not
live-driven. No live claim is made for those extra workflows. The shared local
consumer is live-covered by the declined mode reply; the native queued dispatch
and genuine unsent restoration have their separate live proofs above.

The third independent gate has passed both typechecks, lint, size/UI-hint guards,
both builds and focused ownership/startup/import/dependency checks. Its unfiltered
full suite is now running with the normal automatic worker budget, after waiting
for load to fall below the runbook threshold. There is no final verdict yet.

#### Final live watch and verification-runtime correction

At 1793082029221 the final mode row was still delivered, with one handler call,
no pending request and zero raw-reply provider writes, **480,793ms after its
settlement**. The eight-minute negative watch crosses the five-minute replay
boundary. The final app, direct provider, renderer/utility processes and static
supervisor then stopped. All recorded final PIDs were absent and all three ports
refused connections; original settings and observers were restored/removed and
automation readback was empty. See final-runtime-proof-result.json,
final-shutdown-receipt.json and cleanup-mode.js receipts.

The first complete independent suite exited **1**, not PASS: reported assertions
passed but the SEA repeatability file failed before reporting its two cases.
The visible convert-source-map SyntaxError masked the actual assertion failures.
Normal and no-cache isolated runs reproduced it, ruling out a cache-only remedy.
Read-only diagnostic instrumentation retained the original failure instead of
swallowing it. Exact standalone builder fixtures exposed the actual cause:
the shell selected Homebrew Node 26.12.1, whose binary lacks the SEA fuse required
by scripts/sea-build-support.ts. Both fixtures failed at that explicit guard and
were cleaned in finally blocks.

The existing .nvmrc-pinned Node 24.22.1 installation has the required fuse. With
only child-scoped PATH selection, both unchanged SEA cases passed, exit 0, without
diagnostic preload or cache override. No install, dependency/source/config/test
change or global environment mutation was used. The source-map formatter separately
mistakes a literal generator string in tsx's minified register bundle for a real
inline map; that diagnostic limitation remains recorded, not described as fixed.
The reviewer is rerunning canonical verification and the unfiltered full suite
under the existing pinned runtime. The failed first full run remains preserved.

#### Final canonical result — PASS

The fresh reviewer reran all canonical commands under the existing pinned Node
24.22.1. Both typechecks, lint, TS size/UI-hint guards and both builds exited 0.
The unfiltered normal full suite then exited **0**: **2,796 files and 35,435 passed
tests**, 819.6 seconds. Raw JSON has success=true, zero failed suites/tests, existing
conditional skips unchanged, and both SEA cases passed. No unhandled error or
worker-RPC exception was accepted as success. No filter, cache override,
diagnostic preload, source/test/config change or install was used in that run.

The third independent review has no unresolved actionable code finding and has
read the final native, unsent recovery and local-reply receipts directly. Its
written verdict is **VERDICT: PASS** after current-status reconciliation. Scope limitations remain:
this is the authorised dirty working state with no clean checkout or fresh
dependency install; earlier scoped live checks are retained as identified above,
and the separate display/tooling follow-ups are not fixed. Source hashes match
the frozen snapshot, including the new local-input helper.

The first two FAIL reviews, superseded interrupted suite, unsupported-runtime full
failure and exact runtime correction remain in the evidence directory. Cleanup
and the final seal will record the actual filesystem outcome after report/receipts.

Final independent report: [third fresh gate](2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-verifier-fix/fresh-review-three/report.md).
Both earlier FAIL reviews and every failed/superseded execution remain retained;
only the final supported-runtime unfiltered run supplies the current full PASS.

#### Final cleanup and seal — verified

The report, canonical-redacted complete runner reports/logs, command receipts,
source snapshot and pre-cleanup hash seal were written before runtime removal.
The cleanup command exited 0. Readback confirms dist, .angular, the assigned
/tmp/aio-lt-queue-5223ae4a profile and all owned verifier scratch helpers/reports
are absent. Owned quiet-runner scratch outputs and the temporary dependency-tree
probe were removed after retention. No browser binary, dependency install or
checkout copy was created. Pre-existing node_modules, its existing caches, prior
evidence and the AIO-owned checkout/branch were preserved.

All saved final main/provider/renderer/utility/launcher/supervisor PIDs were absent
and ports 4668/9672/9673 refused connections. Disposable instances were terminated,
settings restored, observers removed and automation list empty. Product hashes
still match the frozen snapshot; no staged paths, project commit, stash, branch
switch/worktree creation or document rename was made. Final Git/source/filesystem
readbacks and the final seal follow this note in the evidence directory.

See cleanup-receipt.json, final-shutdown-receipt.json, final-git-receipts.json,
final-verification.json, seal-pre-cleanup.json and seal.json. Complete JSON runner
reports retain their structure with canonical redaction; concise companion summaries
and original/output hashes are retained too. Failed historical executions remain
failed. This document keeps its original filename for the queue coordinator.


## Evidence run — 2026-10-27 (campaign-defects queue worker)

Additional scoped check-3 evidence on this campaign's assigned base build: manual Compact at measured 29.8905% retained 77,237 tokens as estimated awaiting-post-compaction-usage. DOM showed approximately 30% and a 30% to 30% boundary. The next real bounded response replaced the estimate with measured 78,832 tokens / 30.5077%. No fabricated zero appeared. This is supplementary evidence, not a replacement for that document's separate verifier or other checks.

Full scoped evidence: [campaign final handoff](2026-10-05-livetest-campaign-defects_livetest.md), with command/observation receipts in `2026-10-05-livetest-campaign-defects_evidence/2026-10-27-bd99c0f5/` in the assigned queue checkout. Source f5fffc23c653de06d1dfe409f74b0f776dc2e1db; isolated profile and all owned providers were stopped. No completed-name rename or source repair is claimed.

## Evidence run — 2026-11-08 (resumed parked queue item; no open checks)

**Result: no open live checks in this document, so none were run.** Checks 1–7 each carry a dated PASS above: checks 1 and 4 in the 2026-10-27 resumed and verifier-repair runs, and checks 2, 3, 5, 6 and 7 in the 2026-10-27 round-2 run (scoped evidence, not repeated). No dev app was launched and no runtime was created, so there is nothing to clean up.

Read-only checks made in this session:

- The 47 product files in the frozen source snapshot (`2026-09-24-codex-compaction-turn-visibility_evidence/2026-10-27-verifier-fix/final-source-snapshot.json`) match branch HEAD `91310da8a` by SHA-256. Across the base `7e5222cfe` to HEAD, the only changed file outside that snapshot is the shared remediation register.
- The current seal, `…_evidence/2026-10-27-verifier-fix/seal.json` (07:05:51 UTC), records verdict PASS, stage `final-after-owned-runtime-removal` and an empty `sourceDrift`.
- The independent review `…/2026-10-27-verifier-fix/fresh-review-three/report.md` reads `VERDICT: PASS`.
- Remediation register: the 2026-10-27 "Current compaction re-check" block already records LT-652, LT-653, LT-655, LT-656 and LT-657 as live rechecked, and LT-654 as rechecked within its recorded scope. Those dated blocks govern the older master-table rows, which still say "rebuilt-app check pending". The register's current-status row for LT-680 was merged with main's 2026-10-27 live verification of the same row (both facts kept); LT-681 keeps this branch's 2026-10-27 check-3 confirmation. That merge conflict is resolved and staged. LT-716 and LT-717 remain open display-only defects; LT-718 is an external tooling follow-up. No new defect was reproduced, so no `LT-NNN` was filed.

Items for the queue coordinator (not changed by this worker):

1. The top-level seal `docs/plans/2026-09-24-codex-compaction-turn-visibility_seal.json` is the earlier 2026-10-27 02:47 UTC seal (head `80412201a`, `openChecks: [4]`, `readyForPass: false`). It is stale. The current seal is the verifier-fix seal named above.
2. The paragraph headed "Evidence run — 2026-10-27 (campaign-defects queue worker)" concerns a different document (`2026-10-05-livetest-campaign-defects_livetest.md`, source `f5fffc23`). It is not evidence for this document's checks. It was left in place because it was written by another item's worker.
3. No independent verifier verdict exists for this item yet. The earlier park was "verifier ended its turn without reporting a verdict", so that gate is still open. The completed-name rename stays with the coordinator.
4. The in-progress merge of main, which the coordinator is completing, changes the source that the live evidence above was recorded against. The change is a 3-line `break` in the queued-native-turn join loop of `src/main/cli/adapters/codex-app-server-turn-adapter.ts` (after `followPendingProviderTurn()`, so a queued native turn behind a non-provider turn no longer spins), plus a 225-line provider-turns spec and a one-line spy assertion in `default-loop-native-finality.spec.ts`. The live PASS results for checks 1 and 4 (queued delivery and the 35-minute hold) were recorded before this change. Targeted specs for the merged files pass (3 files, 78 tests). No live re-check of the merged source was run in this turn. The verifier should decide whether check 1's queued-delivery evidence needs a re-run on the merged head.
