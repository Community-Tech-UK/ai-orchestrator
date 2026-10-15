# Codex Compaction Turn Visibility — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-24-codex-compaction-turn-visibility_plan_completed.md](2026-09-24-codex-compaction-turn-visibility_plan_completed.md)

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
