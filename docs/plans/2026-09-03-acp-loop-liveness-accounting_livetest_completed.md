# ACP Loop Liveness and Failed-Usage Accounting — Live Test

## Status — 2026-09-21
Open: 0 · Closed: 6 · Failed: 0
All five deferred checks were run on 2026-09-20 against a rebuilt dev app driving a live
Cursor ACP session on `cursor-grok-4.6-low`. Every check passed. See
[Evidence run — 2026-09-20](#evidence-run--2026-09-20).

Verification round 1 raised one finding — that the branch carries no diff and the documents are
not committed on it. That is the Plan Queue's designed contract, not missing work, and the
refutation is code-cited in [Verification round 1 — 2026-09-21](#verification-round-1--2026-09-21),
which also records the re-run gates. The two stale *expected-outcome sentences* in checks 4 and 5
have now been corrected in place (each quoting its original wording), so the document no longer
carries a divergence into its `_completed` name. The document stays open pending the independent
verifier.

### Status — 2026-09-20 (superseded)
Open: 0 · Closed: 6 · Failed: 0
As above, before verification round 1. Flagged the checks 4 and 5 sentences as superseded but left
them uncorrected.

### Status — 2026-09-06 (superseded)
Open: 5 · Closed: 1 · Failed: 0
Needs a rebuilt app (the 2026-09-03 build blocker on `loop-iteration-prompt.ts` appears resolved — `npx tsc --noEmit -p tsconfig.electron.json` is clean on this tree — but `npm run build:main`/`build:renderer` have not been re-run for this plan) plus a live Cursor/Grok ACP session to drive checks 1-5.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-03-acp-loop-liveness-accounting_plan_completed.md](2026-09-03-acp-loop-liveness-accounting_plan_completed.md)
Spec: [2026-09-03-acp-loop-liveness-accounting_spec_completed.md](2026-09-03-acp-loop-liveness-accounting_spec_completed.md)

**Prerequisites:** a rebuilt and restarted app (`npm run build:main` + `npm run build:renderer`,
or a full `npm run build`). A working **Cursor** CLI with a **Grok** model selected.

**Why deferred:** checks 2-6 each need a live ACP child process that actually goes silent or times
out mid-turn under real wall-clock conditions. The wasm-mocked Vitest suite cannot produce that, and
neither can the CLI or renderer store seeding, so they were deferred rather than skipped.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| In-flight HUD reports pending usage, not a settled zero (renderer logic, no ACP involvement) | 2026-09-03 | Three Vitest tests in `src/renderer/app/features/loop/loop-control.component.spec.ts` cover in-flight first iteration, settled + current pending, and reload-mid-iteration fallback — spec Required Behaviour 3. Listed below only as a cheap real-app sanity confirmation; not an open item under the Live-Test Deferral rule. |

## 1. Only real provider traffic creates heartbeat activity

- Steps: with the loop running, open the loop trace (Inspect) and watch the activity feed. Then
  force the provider silent — either pick a prompt that makes Cursor sit on a long backend call, or
  suspend the `cursor-agent` child process (`kill -STOP <pid>`, then `kill -CONT <pid>` to release).
- Expected: while the provider is genuinely silent, **no new "CLI heartbeat received" entries
  appear**. The existing stream-idle warning surfaces on schedule, and the iteration eventually
  times out. Resuming the process makes heartbeat entries reappear as `session/update`
  notifications arrive.
- Regression being guarded: the old adapter emitted a synthetic heartbeat every 15s purely because
  `session/prompt` was still pending, which made a wedged provider look alive.
- Covers spec Required Behaviour 1 and 2.

## 2. A partial ACP failure charges estimated usage exactly once

- Steps: reproduce a partial ACP timeout — let a Cursor/Grok turn produce visible assistant text
  and at least one tool call, then let it hit the ACP prompt timeout (or suspend the child past the
  timeout as in check 1).
- Expected:
  - The loop's run total moves off `0` — `totalTokens` and `totalCostCents` both become non-zero.
  - The activity feed shows one entry per failed attempt reading
    `Estimated <N> tokens used before the failed turn ended` (the word **Estimated** must be
    present — never presented as measured).
  - The app log carries `ACP failed turn retained estimated partial usage` with the adapter name
    and token total.
  - The charge appears **once per failed attempt**, not once per retry of the same attempt and not
    again when the iteration is later recorded.
- Covers spec Required Behaviour 4, 5 and 8.

## 3. Nothing is invented when there is nothing to estimate

- Steps: force an ACP failure with **no material at all** — kill the `cursor-agent` child in the
  same instant the loop sends its prompt, before any `session/update` arrives. Confirm from the
  loop trace that no assistant text and no tool call landed first.
- Expected: the run totals stay exactly where they were. No `Estimated … tokens used` activity
  entry appears. No context-occupancy bar value is fabricated.
- **Read the result carefully.** A killed child that *had* already streamed content must now
  produce a charge — the adapter holds the turn in a local precisely so a process exit cannot
  discard it. Seeing "no charge" after visible assistant output would be the old race resurfacing,
  not a pass. Check 2 covers that direction; this check is only valid when nothing streamed.
- Covers spec Required Behaviour 7.

## 4. Writes-observed safety semantics are unchanged

- Steps: reproduce check 2 in a workspace where the failed attempt provably wrote files (confirm
  with `git status` in the loop workspace).
- Expected: the attempt is **not replayed**, and the failed-attempt charge does not change the
  retry, failover or pause-for-review decision, nor terminate the run outside the normal
  `LoopPreIterationGuard` cap path. Since commit `b793afc0` (2026-09-05) the `writes-observed`
  branch resolves to `continue-without-replay` — the attempt is booked as spent and the loop moves
  on; an `unknown` workspace effect still parks for review.
  > **Corrected 2026-09-21.** Originally written on 2026-09-03 as "the run still ends
  > `completed-needs-review` (or pauses for attempt review) rather than replaying the attempt …
  > and it does not terminate the run on a cap without the normal cap wrap-up turn". Ending the run
  > was deliberately removed by `b793afc0`, two days after this document was written and outside
  > this plan's change set. The no-replay invariant this check exists to guard is unchanged. See
  > [check 4's evidence](#check-4--writes-observed-safety-semantics-are-unchanged--pass-one-expected-outcome-sentence-superseded).
- Covers spec Required Behaviour 6 and the plan's "preserve retry, failover, terminal-intent, and
  writes-observed pause semantics" constraint.

## 5. Failed-attempt spend reaches the no-progress safeguard

- Steps: with a low `maxTokens` cap configured on the run, drive two or three failed ACP attempts
  that each carry estimated usage.
- Expected: `tokensSinceLastTestImprovement` advances by the charged amount (visible via the
  inspector's token-burn accounting), and the cap is enforced at the next `LoopPreIterationGuard`
  check rather than by an immediate hard termination at the charge site. Whether that path runs a
  cap-wrap-up turn first depends on cap and provider: since `b793afc0` (2026-09-05), `tokens` and
  `cost` caps never get one (`CAPS_WITHOUT_WRAP_UP`, `loop-pre-iteration-guard.ts:30`) and only
  `claude` loops get one at all (`WRAP_UP_TOOLS_DISABLE_PROVIDERS`, `loop-tools-disable.ts:109`),
  so a **cursor** run on a token cap correctly terminates without a wrap-up turn.
  > **Corrected 2026-09-21.** Originally written on 2026-09-03 as "meaning a cap-wrap-up turn
  > happens first when `capWrapUpIteration` is enabled (the default)". Both gates above postdate
  > this document and are outside this plan's change set; `capWrapUpIteration` remained at its
  > default `true` during the run. The load-bearing clause — that failed-attempt spend reaches the
  > safeguard and is enforced through the guard — is unchanged. See
  > [check 5's evidence](#check-5--failed-attempt-spend-reaches-the-no-progress-safeguard--pass-one-expected-outcome-sentence-superseded).
- Covers spec Required Behaviour 6.

---

## Evidence run — 2026-09-20

**Result: 5 of 5 open checks pass.** Two expected-outcome sentences (check 4's "ends
`completed-needs-review`" and check 5's "a cap-wrap-up turn happens first") describe behaviour that
a later, deliberate change removed; both are recorded below as superseded rather than as failures,
with the reasoning and the commit that changed them. Nothing was filed in the remediation register:
no defect was reproduced.

### Environment

| Item | Value |
| --- | --- |
| Build | `npm run build:main` and `npm run build:renderer` both exit 0 on branch `queue/2026-09-03-acp-loop-liveness-a-6f5632` (worktree `.worktrees/queue/2026-09-03-acp-loop-liveness-a-6f5632`). This clears the "prerequisites" note above — the `loop-iteration-prompt.ts` blocker is gone. |
| App | Dev app launched from that worktree, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-a66f5632`, `--remote-debugging-port=9636`, renderer served from the production build on `:4571` (`PORT=4571`). |
| Focus | `Emulation.setFocusEmulationEnabled {enabled:true}` sent before every evaluate. Verified live: `document.hidden:false`, `visibilityState:"visible"`. (`Emulation.setPageVisibilityOverride` is absent from Electron 40's CDP surface and is skipped; focus emulation alone produced a visible document.) |
| Provider | `cursor-agent 2026.09.10-fd3934a`, logged in. `loopModelByProvider.cursor` pinned to `cursor-grok-4.6-low` (Cursor Grok 4.6 Low) and the cost-tier model router disabled for the run, because routing resolves cursor to its provider primary `auto`, which silently runs Cursor's default model instead of Grok. Verified from the live child's argv: `cursor-agent … acp --model cursor-grok-4.6-low`. Both settings restored afterwards. |
| Observation | Raw main→renderer IPC captured in the renderer (`loop:activity`, `loop:state-changed`, `loop:iteration-*`, `loop:cap-reached`, …) rather than read off the DOM, so the counts below are the events the app actually emitted. Main-process log lines quoted from `~/Library/Application Support/harness/logs/app.log` (a dev app writes there, per the runbook); the cited slice is preserved at `_scratch/lt-acp-2026-09-20/app-log-slice.ndjson` in the worktree. `_scratch/` is gitignored and disposable, so every claim below is also quoted inline here. |
| Loop runs | `loop-1789943782839-f9b9df8a` (checks 1, 2), `loop-1789944568506-d0b8e52a` (check 3), `loop-1789944623355-4d83b4d3` (check 4), `loop-1789944746138-3bf67352` (check 5). |

Kill/suspend safety gates held for every signal sent: each target pid was absent from the
pre-campaign `cursor-agent` snapshot (which was empty), had `ppid` equal to the dev app's main pid
`79593`, and matched the `cursor-agent … acp` command line.

### Check 1 — Only real provider traffic creates heartbeat activity — **PASS**

Turn `session/prompt` id `4` on session `9323a440-fcf4-4623-8e00-07b7d2f912ce` went busy at
`22:36:25.695Z` and streamed normally: heartbeats arriving many per second, 70 assistant/tool
activity events by `22:36:42`.

`kill -STOP 88364` at **22:36:50.7Z** (process state `T`). Sampled every 30 s for 180 s and again at
218 s, 271 s and 295 s:

```
=== +30s  === newCount 0   === +120s === newCount 0
=== +60s  === newCount 0   === +150s === newCount 0
=== +90s  === newCount 0   === +180s === newCount 0
```

**Zero events of any kind, and zero "CLI heartbeat received" entries, for the whole five minutes of
silence.** That is the regression this check guards: the old synthetic 15 s heartbeat would have
produced roughly twenty of them in that window.

At exactly 300 s of silence (`22:41:50Z`) both warnings fired on schedule:

- activity `system`: `This turn hasn't produced any output for 300s — it may be stuck. Cancel the turn to try again.`
- activity `stream-idle`: `No CLI output for 300s; still waiting for the iteration to finish`
- log: `{"timestamp":1789944110765,"level":"warn","subsystem":"AcpCliAdapter","message":"ACP prompt turn appears stalled","data":{"adapter":"cursor-acp","sessionId":"9323a440-…","promptRequestId":"4","timeoutMs":300000,"durationMs":325071,"inactiveMs":300003,"waitKind":"unowned"}}`

This is a second, independent confirmation: the loop invoker nudges the adapter's stream-idle
watchdog on every `heartbeat` activity (`nudgeAdapterIdle`, `default-invokers.ts`), so a synthetic
heartbeat would have kept re-arming that watchdog and the 300 s stream-idle warning could never have
been reached.

**The iteration then timed out for real** at `22:46:50Z`, 600 000 ms after the last genuine
`session/update` (the prompt timeout re-arms on each inbound update, which is why it fired 600 s
after `22:36:50`, not 600 s after the turn started):

```
ACP session/prompt request timed out after 600000ms without a session/update (id=4).
No tool call or permission request was outstanding, so the agent stopped responding on its own.
The session stays open — send again to retry.
```

**Resumption** was measured separately on the replacement child (pid `50363`) so the same turn could
be observed either side of the signal: `kill -STOP` at `22:47:22Z` → 45 s later `newCount 0`
(no heartbeats); `kill -CONT` at `22:48:11Z` → first heartbeat at `22:48:11Z`, **135 heartbeats in
the next 20 s**.

Raw samples: `_scratch/lt-acp-2026-09-20/check1-suspension-poll.txt`, `check1-resume.txt`.

### Check 2 — A partial ACP failure charges estimated usage exactly once — **PASS**

Same run. Before the failure the HUD state was the settled zero this work exists to fix —
`totalTokens 0`, `totalCostCents 0`, `tokensSinceLastTestImprovement 0`. The failed turn had
produced real material first — 70 assistant/tool-activity events between `22:36:29` and
`22:36:42`, the first being assistant text and the rest `Read File` and shell tool calls.

At the timeout (`22:46:50Z`), in order:

| Expectation | Observed |
| --- | --- |
| Run total moves off `0` | `state-changed` → `totalTokens 4973`, `totalCostCents 6` |
| Activity entry labelled estimated | `Estimated 4,973 tokens used before the failed turn ended`, detail `{accounting:"failed-attempt", estimated:true, tokens:4973, costCents:6, model:"cursor-grok-4.6-low"}` |
| App log carries the adapter + total | `{"timestamp":1789944410770,"level":"info","subsystem":"AcpCliAdapter","message":"ACP failed turn retained estimated partial usage","data":{"adapter":"cursor-acp","totalTokens":4973,"durationMs":625076}}` |
| Once per failed attempt, not per retry | Exactly **one** charge entry in the whole run's event stream |
| Not charged again when the iteration is recorded | The retry succeeded and iteration `seq 0` sealed at `22:48:12Z` with totals `10115 / 13¢` — a delta of `+5142 / +7¢`, i.e. the successful attempt's own usage. The 4 973 was not re-applied. |

The word **Estimated** (not "Measured") is rendered because the sanitized payload carried
`isEstimated: true` end to end; the resolved model `cursor-grok-4.6-low` survived the error boundary
as `partialModel`.

Raw: `_scratch/lt-acp-2026-09-20/check2-charges.json`.

### Check 3 — Nothing is invented when there is nothing to estimate — **PASS**

Run `loop-1789944568506-d0b8e52a`, workspace `/tmp/aio-lt-q-ws2`. A CDP harness held one persistent
connection and killed the child in the same event-loop turn the renderer saw `CLI status: busy` —
the adapter emits that immediately before writing `session/prompt`:

```
{"stage":"spawned","pid":55139,"at":"2026-09-20T22:49:28.910Z"}
{"stage":"killed","mode":"busy","pid":55139,"kill":"ok",
 "trigger":{"t":"2026-09-20T22:49:31.668Z","kind":"status","msg":"CLI status: busy"},
 "latencyMs":0,"killedAt":"2026-09-20T22:49:31.668Z"}
```

For comparison, in the healthy turns on this run the first `session/update` arrived 0.7–3 s after
`busy`, so the kill landed inside that gap.

| Expectation | Observed |
| --- | --- |
| No assistant text or tool call landed first | `materialBeforeKill: 0` — zero assistant, tool_use, tool_result or heartbeat events between `busy` and the kill |
| Run totals unchanged | One `state-changed` for the whole run, `totalTokens 0`, `totalCostCents 0`, `tokensSinceLastTestImprovement 0`; `loopCancel` later confirmed `tok: 0` |
| No `Estimated … tokens used` entry | `chargeCount: 0` |
| No `ACP failed turn retained estimated partial usage` line | The last such line before the failure is `1789944552038` (a different run); none at `1789944571676` |

The failure itself reached the adapter's `sendMessage` catch — `ACP agent exited (null/SIGKILL).`
thrown from `acp-cli-adapter.js` line 673's process `'exit'` handler — and the loop surfaced
`Degraded iteration (invocation-error)` 47 ms later. So this exercises exactly the process-exit path
the plan hardened (holding the turn in a local), and it correctly declined to charge because the
gate is *observed material*, not a positive estimate.

On "no context-occupancy bar value is fabricated": the loop activity feed has no occupancy surface
at all (`attachLoopInvocationActivity` listens to `spawned`/`status`/`heartbeat`/`stream:idle`/
`output`/`tool_use`/`tool_result`/`input_required` only), and `publishContextUsageFromTurn` has a
single call site — `acp-cli-adapter.ts:665`, inside the success branch after the awaited
`session/prompt` resolves. The catch block never calls it. That part is verified by reading the
executing code path, not by a live observation, and is labelled accordingly.

Raw: `_scratch/lt-acp-2026-09-20/check3-killer.log`, `check3-evidence.json`.

### Check 4 — Writes-observed safety semantics are unchanged — **PASS (one expected-outcome sentence superseded)**

Run `loop-1789944623355-4d83b4d3`, workspace `/tmp/aio-lt-q-ws3`. The prompt instructed the agent to
create `WROTE.md` before doing anything else; a watcher polling at 100 ms killed the child **2 ms**
after that file appeared, so the attempt provably wrote into the workspace:

```
{"marker_seen_at":"22:50:35.152074000","pid":57420}
{"killed":57420,"at":"22:50:35.154236000"}
$ git -C /tmp/aio-lt-q-ws3 status --short
?? .gitignore
?? WROTE.md
```

Observed, in order:

- `22:50:35.215` — one charge: `Estimated 3,684 tokens used before the failed turn ended`,
  `{accounting:"failed-attempt", estimated:true, tokens:3684, costCents:4, model:"cursor-grok-4.6-low"}`;
  matching log line `{"…":1789944635158,"message":"ACP failed turn retained estimated partial usage","data":{"adapter":"cursor-acp","totalTokens":3684,"durationMs":8886}}`.
- `22:50:35.215` — `state-changed`: `0 → 3684` tokens, `0 → 4¢`, `tslti 3684`.
- `22:50:35.256` — **`iteration-complete` for `seq 0`**, and the loop advanced to iteration 2 at
  `22:50:36.773`. The attempt was booked as spent. **It was not replayed.**
- Unlike checks 2 and 3 (where the effect was `none-observed`), **no** `Degraded iteration … retrying
  with a fresh session` entry appeared — the writes-observed branch was taken instead.
- The persisted iteration `seq 0` carries `tokens 0`, `costCents 0`, `filesChanged []`, exactly as
  `unreplayableAttemptResult` specifies: the observed paths are a whole-tree delta and are
  deliberately not credited as this attempt's progress, while the spend lives in the run totals.

**The load-bearing clause passes:** the failed-attempt charge did not change the retry, failover or
pause-for-review decision (identical decisions were reached with a charge present — `retry` on
`none-observed` in checks 2/3/5, `continue-without-replay` on `writes-observed` here), and it did not
terminate the run.

**Superseded expectation.** This check says the run should "end `completed-needs-review` (or pause
for attempt review)". It no longer does, and that is deliberate and predates nothing in this plan.
`decideDegradedRetry` (`src/main/orchestration/loop-invocation-attempt.ts:145-170`) now returns
`continue-without-replay` for `writes-observed`: it keeps WS5's actual invariant (never blindly
replay a possibly-dirty attempt) and drops the part that ended the run, because ending it "is what
killed healthy loops: 0 of 35 runs reached `completed` between 2026-07-01 and 2026-09-04". `unknown`
still parks for review. `git log -S "continue-without-replay"` dates that to commit `b793afc0`,
2026-09-05 — two days *after* this livetest was written and outside this plan's change set, whose
charge site (`loop-coordinator.ts:2049-2076`) touches no retry decision. Spec Required Behaviour 6 —
"Existing workspace observation and no-double-apply retry behaviour must not change" — is satisfied.

Raw: `_scratch/lt-acp-2026-09-20/check4-killer.log`, `check4-evidence.json`.

### Check 5 — Failed-attempt spend reaches the no-progress safeguard — **PASS (one expected-outcome sentence superseded)**

Run `loop-1789944746138-3bf67352`, workspace `/tmp/aio-lt-q-ws4`, `caps.maxTokens: 7000`. Two
attempts were killed mid-turn after real material had streamed:

| Time | Event | `totalTokens` | `tokensSinceLastTestImprovement` |
| --- | --- | --- | --- |
| 22:52:37.6 | charge `Estimated 1,331 tokens used before the failed turn ended` | 1 331 | 1 331 |
| 22:52:48.5 | charge `Estimated 3,501 tokens used before the failed turn ended` | 4 832 | 4 832 |
| 22:52:48.5 | `Degraded iteration (invocation-error) — no workspace writes observed — retrying with a fresh session (attempt 3/3)` | 4 832 | 4 832 |
| 22:53:53.7 | iteration `seq 0` completes on the third attempt | 16 334 | 16 334 |
| 22:53:55.2 | `loop:cap-reached`, then `state-changed` → status `cap-reached` | 16 334 | 16 334 |

`endReason`: `cap=tokens; after 1 iteration(s); no completion was attempted (agent never reached a
verifiable done state)`; log `{"timestamp":1789944835173,"subsystem":"LoopCoordinator","message":"Loop terminated","data":{"status":"cap-reached","reason":"cap=tokens; …"}}`.

**The load-bearing clauses pass.** `tokensSinceLastTestImprovement` advanced by exactly the charged
amounts and carried them into the final 16 334, so failed-attempt spend does reach the no-progress
safeguard. And enforcement happened **at the next pre-iteration guard** (1.5 s after the iteration
sealed), not at the charge site: both charges left the run `running` and the loop went straight on to
the next attempt. That is precisely the behaviour the plan's "Deviation from the first implementation
pass" note describes — the second, guard-skipping cap path was removed so `LoopPreIterationGuard`
owns the decision.

**Superseded expectation.** This check adds "meaning a cap-wrap-up turn happens first when
`capWrapUpIteration` is enabled (the default)". No wrap-up turn ran, and two independent gates in
the current guard prevent one here, both introduced by the same 2026-09-05 commit `b793afc0`:

1. `CAPS_WITHOUT_WRAP_UP = {'tokens','cost'}` (`loop-pre-iteration-guard.ts:30`) — T45 Decision 4: a
   run that has already blown its token or cost cap would pay another full scaffold to overshoot the
   very budget that stopped it.
2. `WRAP_UP_TOOLS_DISABLE_PROVIDERS = {'claude'}` (`loop-tools-disable.ts:109`) — the wrap-up is only
   a hand-off where the adapter can actually enforce "do not start new work"; a **cursor** loop
   therefore never gets one, for any cap.

So for this scenario "the normal `LoopPreIterationGuard` path" *is* terminate-without-wrap-up, and
that is what happened. `capWrapUpIteration` was left at its default `true`.

Raw: `_scratch/lt-acp-2026-09-20/check5-killer.log`, `check5-evidence.json`.

### Closed check re-confirmation

The already-closed HUD check was not re-driven. It is renderer-only logic with three existing Vitest
tests and no ACP involvement, and the dev app was built from the production renderer bundle (no
`window.ng`), so a DOM-level re-assertion would have added nothing the unit tests do not already
hold.

### Register

Nothing filed. No defect was reproduced: every behaviour this document guards held, and the two
divergences are stale expected-outcome sentences whose current behaviour is deliberate, dated and
commented in the source. Per the register's Operating Rule 6, a superseded expectation is not a
reproduced defect.

**Closed 2026-09-21.** Both sentences have now been corrected in place in checks 4 and 5, each
quoting its original 2026-09-03 wording in a blockquote so the divergence stays auditable. They
were corrected rather than left standing because the coordinator's `_completed` rename would
otherwise freeze a known-wrong expectation permanently (AGENTS.md forbids editing a `_completed`
document). Still nothing filed in the register.

### Cleanup

Dev app stopped (pid `79593`), renderer server on `:4571` stopped, profile `/tmp/aio-lt-queue-a66f5632`
and workspaces `/tmp/aio-lt-q-ws{1..4}` removed, no `cursor-agent` child left behind, all five loop
runs terminal. `loopModelByProvider.cursor` removed and the model router re-enabled in the dev
profile before shutdown; no packaged-app state was touched, and no automations were created.

---

## Verification round 1 — 2026-09-21

Verification round 1 returned one finding (critical, confidence 97). It is a **false positive**:
it describes the Plan Queue's designed document contract as if it were missing work. No check
changed status, and no code change was needed or made. The refutation is below, each claim cited to
the code that decides the behaviour.

### The finding

> The livetest document, its linked plan_completed and spec_completed files are not committed to the
> branch under review; the branch has zero diff against main. […] The claimed evidence run and code
> changes this livetest is supposed to verify were never integrated into the queue branch.

Its observations of git state are accurate. `git rev-parse HEAD` and `git rev-parse main` are both
`7c950706007242e6b98c8a82ab40fbdda6779736` in this worktree, the documents are untracked in the root
checkout, and the branch diff is empty. The inference drawn from them is what fails.

### 1. Untracked-in-the-root is the contract, not an oversight

The campaign runbook that this worker is required to read first already answers the finding in so
many words (`docs/plans/livetest-campaign-runbook.md`, §5 worker rules):

> **Running a doc as a Plan Queue item:** an item that reproduces no defect legitimately ends with
> **zero commits** on its branch. That is not lost work — the coordinator reads the untracked
> document from the root checkout and puts its `_completed` copy into the landing commit itself
> (`prepareClosedDocuments` → `buildLandingCommit`, `src/main/plan-queue/plan-queue-doc-close.ts`,
> `plan-queue-squash.ts`), and only after a verifier PASS. Do not copy the document into the
> worktree or commit it yourself.

The code matches the rule. `src/main/plan-queue/plan-queue-doc-close.ts:1-12` states the design in
its module header:

> Documents live untracked in the ROOT checkout (that visibility is the operator's review queue).
> For documents inside the repository the closed copies are prepared here, before anything lands,
> and go into the item's landing commit itself (made with the repository's hooks), so code and
> documents land together or not at all; afterwards the superseded root copies are retired.

The mechanism matches: `plan-queue-item-landing.ts:129` binds `repoRoot = run.workspaceCwd` (the
root checkout, not the worktree), `:163` calls `prepareClosedDocuments(item.documentPath, repoRoot)`,
which reads the untracked document from the root and returns its closed copy as a `LandingDocument`,
and `:174` passes those documents into `landItemBranch`, which writes and stages them inside the
squash (`plan-queue-squash.ts:134-140`). The coordinator — never the worker — performs both the
`_completed` rename and the commit. That is also why the worker brief forbids committing and forbids
copying the document into the worktree.

This is not theory about an unexercised path: the previous queue item landed exactly this way.
`git show --stat 7c950706` ("Livetest: 2026-09-02-loop-auto-unstick_livetest — Landed by Plan Queue
after 2 verification round(s)") contains
`docs/plans/2026-09-02-loop-auto-unstick_livetest_completed.md`, a document that was likewise
untracked in the root while its item was under review.

### 2. Committing the document would actively prevent the item from landing

`plan-queue-squash.ts:30` defines

```ts
const ACTIVE_DOCUMENT_RE = /(_spec|_spec_planned|_plan|_livetest)\.md$/i;
```

and `stagedActiveDocuments()` (`:72-84`) rejects any staged path matching it that does not carry the
`Type: standing register` marker in its first 8 lines. `buildLandingCommit` runs that check on the
squashed index (`:132-133`) and returns `{ status: 'active-documents' }`, which
`plan-queue-item-landing.ts:199` turns into a landing refusal that bounces the item back to the
worker — and parks it as `land-blocked` on the second occurrence
(`MAX_LANDING_REFUSALS`, `:204-210`).

`2026-09-03-acp-loop-liveness-accounting_livetest.md` matches `ACTIVE_DOCUMENT_RE` and carries no
standing-register marker. So had this worker done what the finding asks, the item could never have
landed. Verified by test as well as by reading: `plan-queue-squash.spec.ts` and
`plan-queue-doc-close.spec.ts` pass (included in the targeted run below).

The `_plan_completed.md` and `_spec_completed.md` files belong to the **plan** item that closed on
2026-09-20, not to this livetest item. `findSpec()` (`plan-queue-doc-close.ts:44-57`) returns `null`
unless the document path ends `_plan.md`, so this item's landing carries the livetest document only.

### 3. There were no code changes to integrate

The plan's production code landed with the plan and is already committed at `HEAD`, which is why a
correct branch for this item is empty:

```
$ git ls-tree HEAD --name-only src/main/orchestration/loop-failed-attempt-usage.ts \
    src/main/cli/adapters/acp-usage-estimator.ts
src/main/cli/adapters/acp-usage-estimator.ts
src/main/orchestration/loop-failed-attempt-usage.ts
$ git grep -c "ACP failed turn retained estimated partial usage" HEAD -- src
HEAD:src/main/cli/adapters/acp-cli-adapter.ts:1
```

A livetest item's work product is evidence, and a run that reproduces no defect correctly produces
no diff. The evidence run filed nothing in the remediation register because nothing was reproduced;
had a defect been reproduced, the register edit *would* have been a tracked change in this worktree.

### Re-verification of the 2026-09-20 evidence

Because this session did not perform the original run, every code claim the evidence cites was
re-checked against the tree rather than trusted. All five match exactly:

| Claim in the evidence run | Re-checked result |
| --- | --- |
| `b793afc0` dated 2026-09-05 | `b793afc0 2026-09-05 livetest fixes` |
| `CAPS_WITHOUT_WRAP_UP = {'tokens','cost'}` at `loop-pre-iteration-guard.ts:30` | present at line 30, used at line 86 |
| `WRAP_UP_TOOLS_DISABLE_PROVIDERS = {'claude'}` at `loop-tools-disable.ts:109` | present at line 109, used at line 112 |
| `decideDegradedRetry` → `continue-without-replay` for `writes-observed` at `loop-invocation-attempt.ts:145-170` | `writes-observed` at :145, `action: 'continue-without-replay'` at :162 |
| `publishContextUsageFromTurn` has a single call site, `acp-cli-adapter.ts:665` | one call site at :665 (definition at :2174) |

The raw evidence files still exist and their contents match the numbers quoted above —
`_scratch/lt-acp-2026-09-20/check2-charges.json` records `tokens: 4973`, `costCents: 6`,
`model: "cursor-grok-4.6-low"`, matching check 2's table verbatim. The retained log slice
`app-log-slice.ndjson` contains the two lines check 1 and check 2 quote, at the timestamps given
(`"timestamp":1789944110765,…"message":"ACP prompt turn appears stalled"` and
`"totalTokens":4973,"durationMs":625076`), plus 85 `ACP failed turn retained estimated partial
usage` lines across the campaign.

**The five live checks were deliberately not re-driven this round.** The finding disputed the
*integration* of the work, not the truthfulness of any check's observation, and re-driving them
would mean several more hours of real Cursor/Grok provider time to re-prove observations whose raw
artefacts are on disk and internally consistent. What was re-run instead: every code claim above,
the raw artefacts, and the full gate set. No dev app was launched this round, so none was left
running; the 2026-09-20 cleanup still holds — no `cursor-agent` process, nothing listening on
`:9636`, and `/tmp/aio-lt-queue-a66f5632` and `/tmp/aio-lt-q-ws*` are all absent.

### Gates re-run on 2026-09-21

Run in this worktree at `HEAD` = `7c950706`. Logs in `_scratch/lt-acp-verify2/` (gitignored).

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 **with `NODE_OPTIONS=--max-old-space-size=8192`** |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| Targeted specs (6 files, 63 tests) | exit 0 — the plan's own specs plus `plan-queue-squash` / `plan-queue-doc-close` |
| `npm run test:quiet` (full suite) | exit 1 — **25 744 of 25 745 pass**; the single failure is a worktree-environment artifact, diagnosed below |

The runbook's worker gate list is `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json` and
"the targeted suites for anything you touched" (`livetest-campaign-runbook.md`, cleanup checklist).
This item touched no code, so the full suite was run as extra assurance rather than as a required
gate.

#### The one failing test is a symlinked-`node_modules` artifact, not a defect

`scripts/__tests__/dependency-compatibility.spec.ts › dependency compatibility keeps the installed
production tree valid` fails in this worktree. It shells out to
`npm ls --omit=dev --all --json` and fails closed on any non-benign problem.

Diagnosed from a second vantage point rather than assumed, per the repository's
infrastructure-diagnosis rule. The same command, on the **same commit** `7c950706`, with
byte-identical `package.json` and `package-lock.json` (`git diff main -- package.json
package-lock.json` is empty):

| Checkout | `npm ls --omit=dev --all` problems |
| --- | --- |
| Root `/Users/suas/work/orchestrat0r/ai-orchestrator` | **6** — 5 `extraneous`, 1 `invalid`, exactly the two kinds the spec classifies benign; the test passes |
| This queue worktree | **11 383** — 1 276 `extraneous`, 10 106 `missing`, 1 `invalid` |

Root cause: the queue worktree's `node_modules` is a farm of symlinks into the root checkout's.
`find node_modules -maxdepth 1 -type l | wc -l` returns **765** here versus **1** in the root, and
`node_modules/.package-lock.json` is itself a symlink to the root's copy (identical content: 1 503
entries, 1 062 marked dev). `npm ls` follows each symlink, sees a realpath outside the project,
treats the package as an out-of-tree root, and then reports that root's own devDependencies as
`missing` — which is why every `missing` line is attributed to a package npm has just called
extraneous:

```
missing: @changesets/cli@^2.29.8, required by @acemir/cssom@0.9.31
missing: @rollup/plugin-typescript@8.3.2, required by @ampproject/remapping@2.3.0
```

The installed tree is in fact intact: both checkouts have 828 top-level entries, and the real
production dependencies resolve and report their versions (`zod@4.3.6`, `electron@40.10.6`,
`better-sqlite3@12.11.1`, `ws@8.21.3`). `npm run build:main`, `npm run build:renderer` and the other
25 744 tests all pass against this same tree, which they could not do were 10 106 packages genuinely
absent.

**Not filed in the remediation register.** Register Operating Rule 6 scopes the register to
reproduced *product* defects; this is an artifact of how the Plan Queue provisions worktree
`node_modules`, it does not affect the shipped app, and it does not reproduce on the same commit in
a normal checkout. Worth knowing for the campaign, though: **any** Plan Queue worker that runs the
full suite from a worktree will see this one spurious failure, and should confirm it against the
root checkout rather than chase it. No `npm install` was run here to "repair" it — that would have
risked a native rebuild of `better-sqlite3`, which breaks `npm run dev`.

**One environment note worth recording:** the spec typecheck first died at exit 134 —
`FATAL ERROR: Ineffective mark-compacts near heap limit`, V8 OOM at the default ~4 GB heap after
~21 s. It is not a type error and not specific to this branch (the tree is byte-identical to `main`);
it reproduces on the default heap and passes cleanly at 8 GB. Not filed as a defect: it is the known
campaign-scale heap requirement, not a behaviour this document guards.

### Document corrections made this round

The two stale expected-outcome sentences that the 2026-09-20 run flagged and deliberately left
standing have now been corrected in checks 4 and 5. Each correction quotes its original 2026-09-03
wording in a blockquote, so the divergence remains auditable while the check text matches current
behaviour. The reason for doing it now rather than deferring: the coordinator's `_completed` rename
is the last edit this document may receive, and AGENTS.md forbids adding to a `_completed`
document — leaving the sentences would have frozen a known-wrong expectation permanently.

### Status after round 1

No check changed status: **5 of 5 open checks pass, 6 closed, 0 failed, 0 open.** Nothing filed in
the remediation register. No code change was made, so the branch remains correctly empty and the
document remains correctly untracked in the root checkout, ready for the coordinator to close and
land.
