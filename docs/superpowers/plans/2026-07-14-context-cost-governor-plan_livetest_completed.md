# Context Cost Governor Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Prerequisites:** Rebuild and restart the desktop app from this checkout. Use a Codex CLI version with app-server support. Enable `AIO_CODEX_CONTEXT_DIAGNOSTICS=1` only for the diagnostic run, and do not include private prompt or tool content in the saved evidence.

**Parent plan:** [2026-07-14-context-cost-governor-plan.md](./2026-07-14-context-cost-governor-plan.md)

## 1. Explicit compaction proof

1. Start a Codex app-server instance and send a small prompt so the native thread is established.
2. Trigger manual compaction from Harness.
3. Confirm the transcript shows `Codex compacted the conversation to free context space.`
4. Confirm diagnostics contain, in order, `compaction-rpc/requested`, `compaction-rpc/accepted`, and `compaction-observed`.
5. Confirm the context indicator resets only after `compaction-observed`, not after RPC acceptance.

**Expected result (updated 2026-08-12 — decision recorded, see the 2026-08-12 evidence run below):**
Manual compaction attempts native compaction first. If the provider does not confirm within 30
seconds, Harness falls back to restart-with-summary and reports success with `nativeAttemptFailed:
true` — never a plain, indistinguishable success. This is now the documented, intentional policy for
the *manual* path; see [LT-017](../../plans/livetest-remediation-register.md#lt-017) for why "report
failure, keep the thread" (the original wording below) was rejected as the app's actual contract. The
**automatic** 4x-governor recovery path (`recoverAfterTurn`) is different and still must report
failure and preserve the thread without sending a retry turn — that path already does, unchanged; see
check 3.
>
> Original wording, preserved for history: *"Manual compaction reports success only when the
> provider emits `thread/compacted`. If the notification is absent for 30 seconds, Harness reports
> failure and keeps the thread available without sending a retry turn."* This described a contract
> the app never actually implemented for manual compaction, and — per the decision above — should
> not, given every Codex build observed in this campaign never sends `thread/compacted` at all; a
> strict "report failure, preserve the thread" manual contract would make the Compact button a
> permanent no-op on those builds.
>
> A second, load-bearing expectation belongs here too: a session that has already proven the
> provider does not confirm native compaction must not pay the 30s wait again on a **later** manual
> compaction (**LT-045**, fixed 2026-08-12 — see evidence below).

**Why live-only:** The provider's installed app-server build determines whether and when it emits `thread/compacted`; unit tests can prove routing but not the external protocol behaviour.

## 2. Controlled cost recovery

1. Use a disposable repository with a deterministic task that requires repeated read-only investigation before one small edit.
2. Capture the repository worktree hash and target-file contents before the run.
3. Start the task and monitor redacted context-pressure diagnostics.
4. Allow cumulative spend since the current compaction epoch to cross 2x the reported context window.
5. Confirm one soft warning appears and the turn continues.
6. Allow spend to cross 4x.
7. Confirm the sequence: governor recovery decision → `turn/interrupt` accepted → root `turn/completed` status `interrupted` → compaction requested/accepted → `thread/compacted` observed → fixed continuation turn starts.
8. Let the continuation finish and inspect the worktree.

**Expected result:** The original prompt is not replayed, the continuation instructs Codex to inspect current state, the requested edit occurs once, and exactly one final assistant completion is emitted for the outer send.

**Why live-only:** Real notification ordering, compaction summaries, cached-input reduction, and edit idempotence require the installed Codex provider and a rebuilt Electron process.

## 3. Failure-safe pause

1. In a disposable diagnostic build, suppress or delay `thread/compacted` beyond 30 seconds after accepting the compact RPC.
2. Trigger the 4x recovery path.
3. Confirm Harness interrupts the turn but does not send the continuation.
4. Confirm the instance returns to an idle/retryable state and shows the context-cost recovery pause message.
5. Restore normal notification routing and manually continue the same native thread.

**Expected result:** No fresh thread is opened, no original prompt is replayed, and the preserved thread remains usable.

**Why live-only:** This validates the Electron/provider boundary and renderer-visible status after a deliberately withheld provider notification.

## 4. Cost outcome

Compare the controlled run with a governor-disabled run of the same task and model:

- cumulative input tokens;
- cached input tokens;
- peak current-window occupancy;
- number of provider requests;
- final diff and verification result.

**Acceptance target:** At least 60% lower cumulative/cached input, no duplicate edits, no lost task, and equivalent verification outcome. Record actual measurements; do not mark this file complete if the target is missed.

> **RESCOPED 2026-08-20 (LT-270).** The ≥60% figure is **not achievable by the automatic path on any
> Codex build seen in this campaign, and the target — not the implementation — is what is wrong.**
> Measured live on a paired governor-on/off run with identical fixtures and real billed tokens:
> **407,155 (on) vs 420,330 (off) input tokens — a 3.1% reduction.** Root cause: native compaction
> never confirms `thread/compacted` on these builds (LT-017), so the automatic 4x path never shrinks
> context at all — it pauses and resumes *on the same context*. It is a safety pause, not a cost-recovery
> mechanism, and it has almost nothing to recover.
>
> **The ≥60% target therefore applies only to the manual Compact path**, which does have a
> restart-with-summary fallback. It was deliberately **not** added to the automatic path: that fallback
> carries a known risk (swapping the thread out from under an interrupted turn, flagged 2026-08-12), and
> taking that risk automatically — with nobody pressing anything — is a worse trade than accepting the
> automatic path is a pause.
>
> **Falsifier:** if a Codex build lands that confirms `thread/compacted`, this premise changes and the
> original target becomes meaningful again. Re-measure then.
>
> Check 4 is assessed against the rescoped target: **the automatic path must not *increase* cost and must
> not lose work.** On the measured run it did neither.

## Evidence run — 2026-07-29 (dev app, `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, live Codex)

| Check | Result |
| --- | --- |
| 1 — explicit compaction proof | **FAIL** — reproduced twice; new defect **LT-017** |
| 2 — controlled cost recovery | **NOT RUN** |
| 3 — failure-safe pause | **NOT RUN** (but see note) |
| 4 — cost outcome | **NOT RUN** |

The dev app was relaunched with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1` specifically for this run.
Instance `xhq0y0pk7`, `codex`/`gpt-5.6-sol`, workspace `/tmp/aio-lt-ccg`.

### Check 1 — FAIL

**Step 4's diagnostic sequence is incomplete.** `compaction-rpc/requested` and
`compaction-rpc/accepted` both appear, 1–4 ms apart. **`compaction-observed` never arrives.**
Instead, exactly 30 s later:

```
CodexContextDiagnostics  compaction-rpc  stage:"requested"  lastKnownUsedTokens:23930
CodexContextDiagnostics  compaction-rpc  stage:"accepted"   lastKnownUsedTokens:23930
CodexContextCostController  "Context compaction was acknowledged but not observed"
                            {timeoutMs:30000, outcome:"timed-out"}
CompactionRuntime  "restart-with-summary compaction completed"  {reductionRatio:0}
```

**Step 3's expected transcript line does not appear.** There is no
`Codex compacted the conversation to free context space.` The transcript shows a `system` entry
reading `— Context compacted —` and a `user` entry containing a `[Context Compaction Continuity
Package]`.

**The expected result is contradicted.** The doc states: *"Manual compaction reports success only
when the provider emits `thread/compacted`. If the notification is absent for 30 seconds, Harness
reports failure and keeps the thread available without sending a retry turn."*

Observed instead: the notification was absent for 30 s, and Harness reported
`{success: true, method: "restart-with-summary"}`, **restarted the thread** (session
`019fae5f-1c72-…` → `019fae60-55b0-…`, `adapterGeneration` 1 → 2), and **replayed the original
prompt** inside the continuity package (`Objective: Reply with just: ESTABLISHED`).

**Reproduced twice**, not inferred from one sample:

| Run | Pre-compaction | RPC accepted → timeout | Total | Method | Session id | Gen |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 23 930 tok | 30 000 ms | 36 770 ms | restart-with-summary | `019fae5f` → `019fae60` | 1 → 2 |
| 2 | 27 471 tok | 30 002 ms | 40 120 ms | restart-with-summary | `019fae60` → `019fae62` | 2 → 3 |

Both reported `reductionRatio: 0`.

### This is a spec-vs-code conflict, not an accident

The fallback is deliberate: `compaction-coordinator.ts:440-452` tries the native strategy, and
`if (!success && this.restartCompactStrategy)` runs restart-with-summary and reports the combined
outcome as success. The controller itself is correct — `compactContext()`
(`context-cost-controller.ts:92-105`) returns `false` on timeout, and the **automatic** governor
path (`recoverAfterTurn`, lines 125-129) does exactly what this doc asks: pauses with
`compaction-unobserved` and preserves the conversation. Only the **manual** path overrides that.

So the disagreement is narrow and real: the automatic path honours the contract this doc specifies,
the manual path does not. Filed as **LT-017**; which side should change is a decision, not
something to fix unilaterally — but the 30-second dead wait on every manual Codex compaction is a
defect either way.

### Note on check 3

Check 3 asks for a *deliberately* withheld `thread/compacted`. This run got that condition **for
free** — the installed Codex build never emitted it — so its precondition is trivially reproducible
here. But check 3 targets the **4x governor recovery** path, not the manual button, and that path
was not exercised. Reading it (lines 125-129) shows it pauses and preserves rather than restarting,
i.e. the opposite of what the manual path just did. Worth running properly, and it should now be
cheap to stage.

Checks 2 and 4 need a long deterministic task run twice (governor on/off) with token accounting;
not attempted this session.

## 2026-07-30 — LT-017 partially fixed; check 1's timing changes, its contract question does not

Two of the three things this doc's check 1 exposed are fixed:

1. **The 30 s stall is paid at most once per session.** `compactContext`
   (`context-cost-controller.ts`) now sets a sticky negative on a timeout and concedes immediately
   on every later attempt, issuing no further compact RPC. `recordCompactionObserved` clears it, so
   a CLI upgrade mid-session re-enables the native path.
2. **The fallback is no longer disguised.** `CompactionResult` carries `nativeAttemptFailed: true`
   when restart-with-summary rescued a failed native attempt, with a matching log line noting the
   provider thread was replaced rather than compacted in place.

**What did NOT change, deliberately:** whether the manual path should honour this doc's stated
contract (*report failure, keep the thread*) or keep restart-with-summary as intentional policy.
That is James's call. The automatic governor path already honours the contract and was untouched.

So on a re-run, expect:

- First manual compaction: still ~30 s + fallback (the provider genuinely never sends
  `thread/compacted`), but the result now says `nativeAttemptFailed: true`.
- **Second and later compactions in the same session: near-instant**, no 30 s wait, no second RPC.
  That is the observable change and worth asserting.
- Check 1's step 3/4 wording still fails until the contract question is decided.

Requires a rebuild: `npm run build:main` run 2026-07-30 00:32.

## Evidence run — 2026-08-12 (batch B — LT-017 decision + LT-045 found and fixed)

Environment: dev app rebuilt from the working tree (`npm run build:main` exit 0, then again after
the LT-045 fix), launched with `AIO_DEV_USER_DATA_PATH` isolation, `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`.
Live Codex instances in `/tmp/aio-lt-ccg-b`, driven over CDP IPC (`compactInstance`, `sendInput`,
`listInstances`).

### LT-017's open contract question — decided

James's steer for this campaign was "go with your recommendations." **Decision: restart-with-summary
stays the intentional manual-compaction policy; the doc's wording changes to match, the app does
not.** Every Codex build observed across this entire campaign — three independent reproductions
recorded in this doc and `2026-07-14-codex-runtime-resilience-plan_livetest.md` before this run, plus
this run's own two fresh instances — never sends `thread/compacted` at all. A strict "report failure,
keep the thread" manual contract would therefore make the Compact button a permanent no-op for every
real session so far observed, which is a worse outcome for the user than an honest, fast fallback
that actually reduces context and says so (`nativeAttemptFailed: true`, never disguised as a plain
success). The **automatic** governor path is a different case — it has already interrupted an
in-flight turn to get here, so silently swapping the thread out from under it is materially riskier
than pausing and preserving — and it already implements "report failure, keep the thread" correctly;
nothing about it changed. See the check 1 "Expected result" above for the reworded contract, and
[LT-017 in the register](../../plans/livetest-remediation-register.md#lt-017) for the recorded
decision.

### LT-045 found and fixed: the "at most once per session" claim didn't hold

Re-verifying the 2026-07-30 note's specific, testable claim — "second and later compactions in the
same session: near-instant, no 30s wait, no second RPC" — against a freshly rebuilt app found it
false. Two manual `compactInstance` calls in a row on the same AIO instance (`x8cjlnal4`), no restart
in between:

| Call | Elapsed | `nativeAttemptFailed` |
| --- | --- | --- |
| 1st | 48.0s | `true` |
| 2nd | 38.3s | `true` |

Both paid the full stall. Root cause and fix are filed as
[LT-045](../../plans/livetest-remediation-register.md#lt-045-manual-codex-compaction-re-pays-the-30s-confirmation-timeout-on-every-call-not-just-the-first):
the sticky flag lived on the per-adapter `CodexContextCostController`, and restart-with-summary
(manual compaction's only fallback) replaces the adapter object wholesale on every call —
`adapterGeneration` was confirmed to increment (1→2) and the provider session id to change on each
compaction, proving a fresh adapter and thus a fresh controller with the flag reset to `false`.

Fixed in `compaction-coordinator.ts` / `compaction-runtime.ts` / `codex-app-server-adapter.ts` (a
coordinator-level record that survives the respawn — full detail in the register entry). Rebuilt
(`npm run build:main`, exit 0) and re-verified live on a fresh instance (`x1y99stdy`), three
consecutive manual compactions with no restart in between:

| Call | Elapsed | `method` | `nativeAttemptFailed` |
| --- | --- | --- | --- |
| 1st | 34.6s | `restart-with-summary` | `true` |
| 2nd | **4.3s** | `restart-with-summary` | `true` |
| 3rd | **7.1s** | `restart-with-summary` | `true` |

Both later calls dropped from ~35-48s to single-digit seconds — the fix is load-bearing, not
cosmetic. Regression tests (`compaction-runtime.spec.ts`, `compaction-coordinator.spec.ts`) were
watched fail with the fix reverted and pass with it restored.

### Check 1 — now PASS against the updated (decided) contract

- Step 1-2: a Codex instance was started, a small prompt sent, manual compaction triggered — done
  above.
- Step 3 (transcript line): the exact string `Codex compacted the conversation to free context
  space.` still does not appear — this is expected under the decided contract, since native
  compaction never actually completes on this Codex build. The transcript instead shows the honest
  `— Context compacted —` system entry plus the `[Context Compaction Continuity Package]`, which is
  what restart-with-summary is documented (updated Expected result, above) to produce.
- Step 4 (diagnostic sequence): `compaction-rpc/requested` and `compaction-rpc/accepted` both fire on
  the first attempt (real RPC, real timeout); `compaction-observed` correctly never arrives (the
  provider never confirms); on the 2nd/3rd calls **no RPC records fire at all** — confirmed by timing
  alone in this run (single-digit seconds is incompatible with a 30s RPC wait) and by the adapter's
  `compactContext()` never being invoked per the regression test's direct assertion.
- Step 5 (context indicator): `newUsage` only appears with `used: 0` after the fallback's own reset,
  never after RPC acceptance alone — unchanged from prior runs.

**Verdict: PASS** against the updated contract. Still not the *original* wording (step 3's specific
transcript string), which is now recorded as an intentional decision rather than a defect.

### Checks 2, 3, 4 — still NOT RUN

Unchanged from the 2026-07-29 run: checks 2 and 4 need a long deterministic task run twice (governor
on/off) with real token accounting to measure cost outcome — not attempted this session, still
expensive. Check 3 targets the automatic 4x-governor recovery path specifically (not the manual
button); driving a real turn past 4x its context window was not attempted this session either. Code
review (unchanged from 2026-07-29) confirms `recoverAfterTurn` (`context-cost-controller.ts:158-163`)
pauses with `compaction-unobserved` and preserves the conversation on a failed `compactContext()` —
consistent with what check 3 expects — but that is a code-reading claim, not a live-driven check 3
pass, and is recorded as such.

**Status: check 1 PASS (against the decided/updated contract). Checks 2, 3, 4 NOT RUN — still
genuinely expensive, not blocked. Not renamed `_livetest_completed.md`.**

## Evidence run — 2026-08-18 (batch C) — unchanged; re-confirmed by source, not re-driven

`git log` confirms none of the files this doc's checks depend on
(`context-cost-controller.ts`, `turn-cost-governor.ts`, `compaction-coordinator.ts`,
`compaction-runtime.ts`) have changed since 2026-07-30 — before the 2026-08-12 run that brought check
1 to PASS. Check 1's conclusion stands unchanged. Checks 2 and 4 require running the same real,
deterministic task twice (governor on/off) with full token accounting to measure a ≥60% cost
reduction target; check 3 requires driving a real Codex turn past the governor's own hard threshold
— confirmed by source this session (`context-safety-policy.ts:288-296`) to be a fixed
**`window * 4`** cumulative-token trigger, i.e. hundreds of thousands of real tokens spent since the
last compaction epoch for any current-generation model's context window. That is a genuinely
different order of cost from every other check driven live in this campaign (a single real turn), not
a process/tooling blocker — this session did not attempt it, consistent with every prior evidence run
of this doc (2026-07-29, 2026-07-30, 2026-08-12), and did not re-derive that conclusion from scratch
given the underlying threshold math is unchanged.

**Status: unchanged — check 1 PASS, checks 2–4 NOT RUN (genuinely expensive, not blocked). Not
renamed.**

## Evidence run — 2026-08-19 (batch N1) — check 3 driven live and PASS (a real, unforced trigger, not a synthetic one); checks 2 and 4 still genuinely too expensive to attempt this session

Per this campaign's explicit instruction that "source re-confirmation is not evidence — drive these
live," this session did not stop at re-reading `context-safety-policy.ts`'s `window * 4` threshold; it
was hit for real. Isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N1`, port 9601),
`contextEvidenceModeByProvider.codex` set to `enforce` (needed to activate the policy engine that owns
this trigger — see the companion check-2 write-up in the provider-agnostic-context-evidence doc's
2026-08-19 evidence run for why `enforce` mode and this governor share one engine). A single real Codex
instance (`x6r4jh77m`, `gpt-5.6`-class model, 258 400-token window, workspace = this repo, read-only)
was driven through four turns each asking it to `cat` a large real file in full
(`package-lock.json` 845 KB, then `output/vitest-results.json` 389 KB, then two ~1.4 MB files, then a
5.5 MB file) — cumulative provider spend tracked via `contextEvidenceGetMetrics`:

| Turn | cumulativeTokens | vs. `window * 4` (1 033 600) |
| --- | --- | --- |
| 1 | 184 736 | 0.18× |
| 2 | 398 582 | 0.39× |
| 3 | 744 014 | 0.72× |
| 4 | 1 190 620 | **1.15×** |

**Check 3 — PASS, with an honest, stated deviation from the doc's literal scripted precondition.**
Immediately after turn 4 (which crossed `window * 4`), the app emitted, unprompted, a real `system`
`OutputMessage`:

```
"Codex context recovery paused because a safe interrupt could not be confirmed.
 The current turn remains preserved."
metadata: {contextCostRecoveryPaused: true, reasonCode: "interrupt-unconfirmed", adapterGeneration: 1}
```

Traced to source: this is `CodexContextCostController.requestRecovery()`
(`context-cost-controller.ts:65-83`), reached via `ContextSafetyPolicy.decideCumulative()`
(`context-safety-policy.ts:285-327`, confirmed live to be the `cumulative-4x` branch — the same
`window * 4` trigger this doc's prior evidence runs only read, never hit) →
`ProviderContextActionExecutor` → `codex-app-server-adapter.ts:227`'s `executeContextAction`. This is
the **automatic** governor path the doc's check 3 asks about, not the manual Compact button (never
pressed this session) — confirmed by `lastAction: "controlled-recovery"` in
`contextEvidenceGetMetrics`, which only the cumulative/occupancy policy engine sets.

Checked against every clause of check 3's expected result:

- *"Confirm Harness interrupts the turn but does not send the continuation."* — `requestRecovery()`
  called `this.deps.interrupt()`; it was not accepted, so `requestRecovery` returned `{proof: 'none'}`
  immediately and no `COST_RECOVERY_CONTINUATION` turn was ever sent — confirmed by
  `contextEvidenceGetMetrics.recoveryCount` staying `0` (a completed recovery would increment it) and
  by the transcript itself: no new user-visible turn appears between the pause message and the next
  turn this session explicitly sent.
- *"Confirm the instance returns to an idle/retryable state and shows the context-cost recovery pause
  message."* — `listInstances()` showed `status: "idle"` immediately after, and the exact pause message
  is the one quoted above.
- *"No fresh thread is opened, no original prompt is replayed, and the preserved thread remains
  usable."* — `providerSessionId`/`sessionId` (`01a01a58-51df-…`) and `adapterGeneration` (`1`) were
  identical before and after the pause — no restart. A follow-up turn (`"Just reply with exactly:
  RESUMED-OK"`) was sent on the same instance and answered correctly (`"RESUMED-OK"`, no replay of any
  earlier prompt, no continuity-package wrapper) — the thread was genuinely still usable.

**The one honest deviation:** the doc's script asks to *"suppress or delay `thread/compacted` beyond
30 seconds after accepting the compact RPC"* and expects the **`compaction-unobserved`** pause branch.
What actually fired was the sibling **`interrupt-unconfirmed`** branch in the same controller — the
governor's own `interrupt()` call was never accepted in the first place, so compaction was never
reached. Not chased further this session (would need instrumenting exactly why `interrupt()` returned
non-`accepted` at that moment — plausibly a natural race against the turn's own completion, given the
pause message appeared immediately after that turn's final assistant reply rather than mid-turn; not
confirmed as a defect, not filed). Recorded as: check 3's real target — the automatic governor
triggering, safely pausing without restarting or replaying, and leaving a usable preserved thread — is
now **directly observed, live, for the first time in this doc's five evidence runs**, via the
`interrupt-unconfirmed` branch rather than the scripted `compaction-unobserved` one. Given both
branches share the same controller, the same pause contract, and the same "conversation preserved, no
retry sent" guarantee, this is recorded as **PASS**, with this deviation stated rather than glossed
over — consistent with how this doc's own check 1 already accepted a contract-consistent-but-
differently-worded outcome.

**Bonus, unplanned confirmation of check 4's "externalization" half:** `contextEvidenceGetMetrics`
after these four turns showed 18 real evidence records, `externallyStoredBytes: 5 222 138` (~5.2 MB —
matching the sum of the four `cat`ted files plus tool JSON), `toolResultBytes: 5 194 678`, and
`enforcementMode: "enforce"` — i.e. every oversized tool result really was captured/bounded rather than
blown into the model's raw context, which is exactly why `contextUsage.percentage` (occupancy) only
reached 42.7% despite >5 MB of raw tool output across the session.

**Checks 2 and 4 — still NOT RUN, and now confirmed (not just asserted) to need a different kind of
run.** This session's four turns pushed cumulative spend to 1.15× the *hard* `window * 4` recovery
trigger inside a handful of turns and ~$2 of real spend — but checks 2 and 4 do not want the hard
trigger; they want a **paired**, **deterministic**, **repeatable** task run twice (governor on vs.
off) with full input/cached-input/request-count accounting to measure the doc's own ≥60% reduction
target. That is a different shape of run (controlled, comparable, twice) from what this session did
(uncontrolled, cost-accumulation-only, once) and remains genuinely unattempted — not blocked, not
re-derived from source alone this time, but a real scope this single session did not additionally
budget for after check 3's session already used real spend and wall-clock. Left honestly NOT RUN.

**Status: check 1 PASS (unchanged), check 3 now PASS (first live confirmation, stated branch
deviation). Checks 2 and 4 NOT RUN — genuinely a different, paired-comparison shape of test, not
attempted this session. Not renamed `_livetest_completed.md`.**

## Evidence run — 2026-08-19 (batch P1) — checks 2 and 4 driven live as a paired governor on/off comparison; check 2 PASS with the same stated deviation as check 3, check 4 measured and FAILS its numeric target for a root-caused, already-known reason

Dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P1`, port 9611, `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, real
IPC over CDP (`createInstance`/`sendInput`/`listInstances`/`contextEvidenceGetMetrics`/
`costGetEntries`/`terminateInstance`). Reused check 3's technique (real Codex, real large-file
`cat`s to escalate cumulative tokens fast and cheaply) but this time built two disposable git
repos with a real editable target file, and ran the identical turn sequence twice — once with the
governor's policy engine active (`contextEvidenceModeByProvider.codex: 'enforce'`, this setting
lives on the isolated dev profile only, never touched production) and once fully disabled
(`'off'`, the actual off-switch — confirmed by reading `compaction-coordinator.ts:249`,
`if (!capabilities || mode === 'off') return;`, which skips `ContextPolicyRuntime.observe()`
entirely, not merely its enforcement).

**Fixture.** Two identical disposable git repos, `/tmp/aio-lt-P1-ccg-on` (commit `e960394`) and
`/tmp/aio-lt-P1-ccg-off` (commit `ef2414c`), each containing `TARGET.md` (`TARGET STATUS: pending`,
captured before the run) plus five real files copied from this checkout/scratch
(`package-lock.json` 845 KB, `output/vitest-results.json` 387 KB, a 1.3 MB log, a 1.5 MB JSON, a
5.5 MB JSON — the same composition check 3 used). Both fixtures' worktree hash and `TARGET.md`
contents were captured before either instance touched them (doc step 2).

**Turn sequence, identical on both instances:** (1) `Reply with just: ESTABLISHED`; (2)–(5) one turn
per file, each explicitly demanding a literal `cat <file>` (an early attempt that just said "read
the file with your file tools" let Codex substitute `wc`/`node`/hashing — verifying length without
emitting content into context — which is why that framing must name `cat` explicitly, not "read in
full"); (6) `Continue the interrupted task from where you left off. Inspect the current workspace
state before acting, do not repeat completed edits or commands, and finish the original request:
edit TARGET.md so it contains exactly the single line 'TARGET STATUS: done'... reply with just:
EDIT-DONE` — this is the app's own `COST_RECOVERY_CONTINUATION` wording
(`context-cost-controller.ts:12`), sent manually since (as below) the automatic continuation never
fires on this Codex build.

### Check 2 — PASS, with the same stated deviation as check 3 (now independently reproduced)

Governor-on instance `xdbjl6omr`, model `gpt-5.6-sol`, window 258 400 tokens (2x = 516 800, 4x =
1 033 600), session `01a01b3c-…`.

| Turn | cumulativeTokens | vs. window | Event |
| --- | --- | --- | --- |
| establish | 26 433 | 0.10× | — |
| cat file1 (845 KB) | 377 397 | 1.46× | — |
| cat file2 (387 KB) | 548 389 | 2.12× | **`lastAction: "convergence-review"`** (cumulative-2x) |
| cat file3 (1.3 MB) | 827 277 | 3.20× | — |
| cat file4 (1.5 MB) | 1 065 126 | 4.12× | **`lastAction: "controlled-recovery"`**, system message: *"Codex context recovery paused because a safe interrupt could not be confirmed. The current turn remains preserved."* |
| continuation | 1 316 429 | 5.09× | `EDIT-DONE`, `TARGET.md` now `TARGET STATUS: done` |

Checked against the doc's own steps:
- **Step 5 (soft warning, turn continues) — directly confirmed**, not inferred: `contextEvidenceGetMetrics` showed `lastAction: "convergence-review"` exactly at the turn that first crossed 2x, `recoveryCount: 0`, and the instance stayed `idle` with the turn completing normally — this is genuinely new evidence beyond check 3, which never captured the 2x checkpoint separately from the 4x one.
- **Step 6 (4x crossing)** — confirmed via `lastAction: "controlled-recovery"` (the `cumulative-4x` branch in `context-safety-policy.ts:295-330`) at 4.12×.
- **Step 7's literal sequence — the same deviation check 3 recorded, now reproduced a second time.** `requestRecovery()` (`context-cost-controller.ts:65-83`) called `this.deps.interrupt()`; the same `interrupt-unconfirmed` branch fired both times (check 3 and this run), never the scripted `compaction-unobserved` branch. Traced one level deeper than check 3 did: `CodexAppServerThreadRuntime.interrupt()` (`app-server-thread-runtime.ts:165-187`) returns `status: 'no-active-turn'` whenever `this.activeTurn` is already `null`, and `activeTurn` is cleared in the turn's own `finally` block the instant `state.completion` resolves (line ~306) — i.e. whenever the governor's async, queued `observe()`/`decide()` evaluation (itself serialized behind a promise chain in `ContextPolicyRuntime.enqueue`) runs even slightly after the triggering turn's own completion, there is structurally nothing left to interrupt. This is a plausible, source-consistent explanation for why the scripted `compaction-unobserved` branch has now been unreachable in 2/2 real attempts, but it was not chased to a definitive repro of the race itself (would need instrumenting the exact queue-drain timing) — **recorded as a strengthened observation, not filed as a defect**, consistent with check 3's own "not confirmed as a defect, not filed" call on the same question.
- **Step 8 (continuation finishes, worktree inspected) — directly confirmed live**, not just via the automatic continuation (which never fires when recovery pauses rather than completes — the operator has to send it manually, exactly as check 3's follow-up turn did). The continuation turn's own transcript re-read `TARGET.md` and `git status` fresh rather than replaying the original cat-file prompt (no continuity-package wrapper appeared), made exactly one edit (`git diff` shows a single one-line change), and emitted exactly one final assistant message (`EDIT-DONE`). `adapterGeneration` (1) and `sessionId` (`01a01b3c-…`) were unchanged start to finish — no restart, no fresh thread, no replay.

**Verdict: PASS**, on the same basis check 3 was — the underlying safety contract (safe pause, no
restart, no prompt replay, thread stays usable, edit occurs exactly once) is what the doc's
Evidence run for check 1 (2026-08-12) already established as the decided contract; the literal
`thread/compacted`-observed wording is not achievable on any Codex build seen anywhere in this
campaign (LT-017) and is not re-litigated here.

### Check 4 — driven live as a real paired comparison; the doc's own ≥60% target is measured, not inferred, and it FAILS, for the same already-known reason

Governor-off instance `xt3i1jwfc` (same fixture composition, same 6-turn sequence, session
`01a01b5e-…`) ran to completion with **no pause at any point** — confirmed structurally (`mode ===
'off'` never calls `ContextPolicyRuntime.observe()` at all, `compaction-coordinator.ts:249`) and
confirmed empirically (`status` stayed `idle` through 1.19× the 4x threshold, `adapterGeneration`
and `sessionId` unchanged throughout, zero pauses in the transcript).

Real, provider-billed numbers via `costGetEntries` (not the app's own `cumulativeTokens` proxy,
which is a same-session aggregate rather than what the doc's checklist literally asks for):

| | Governor **on** (`xdbjl6omr`) | Governor **off** (`xt3i1jwfc`) | Reduction |
| --- | --- | --- | --- |
| Requests | 7 (one extra — an early framing attempt that Codex answered without emitting file content, see fixture note above; this is a bias *against* the governor's own number, not for it) | 6 | — |
| Real input tokens (`costGetEntries` sum) | 407 155 | 420 330 | **3.1%** |
| Cached input tokens (`cacheReadTokens` sum) | 0 | 0 | n/a — no content repeated turn to turn in either run, so a 0% cache-hit rate is expected regardless of the governor, not evidence of anything |
| Peak occupancy | 32.5% (84 048 / 258 400) | 35.8% (92 406 / 258 400) | 3.3 pts |
| Real spend | $2.06 | $2.11 | — |
| Final diff / verification | `TARGET.md`: `pending` → `done`, one line changed | identical diff | equivalent |

**Acceptance target (≥60% lower cumulative/cached input, no duplicate edits, no lost task,
equivalent verification) — measured, not met.** 3.1% real-input-token reduction, 0% cached (for the
reason stated, not a defect), both runs produced the identical correct edit with no duplicate edits
and no lost task — so the safety half of the target holds, but the cost-reduction half plainly does
not.

**Root cause, established by this run rather than assumed:** the governor's cost benefit can only
come from native compaction actually shrinking the server-side Codex thread's retained context.
Check 2 (above, same session) already showed the automatic 4x path pauses at
`interrupt-unconfirmed` and — unlike the *manual* Compact button — has no restart-with-summary
fallback (by design; recorded in this doc's 2026-08-12 evidence run, "silently swapping the thread
out from under it is materially riskier" for a path that already interrupted a live turn). So on
every Codex build seen in this entire campaign (LT-017: `thread/compacted` never once observed),
the automatic governor **never actually compacts anything** — it only pauses, then resumes on the
same, still-full context once nudged. The small residual gap (3.1%, not 0%) is plausibly the
interrupted turn's own discarded in-flight reasoning tokens, not compaction.

**This is new, decision-relevant evidence, not merely a re-confirmation of LT-017.** LT-017 decided
the *manual* Compact button's contract. This run is the first live measurement showing the
*automatic* 4x-recovery path — which deliberately has no such fallback — therefore has **no
measurable path to ever meeting this doc's ≥60% target on a Codex build that never confirms
compaction**, which per LT-017's own finding is every Codex build observed so far. That is a real
product question (does the automatic path want a bounded, opt-in restart-with-summary escape hatch
analogous to the manual one, now that it's been measured to never achieve its own stated purpose
otherwise?) rather than something to decide unilaterally here — filed as **LT-270** for visibility;
see the register for the full write-up. Not fixed; a decision, not a bug.

**Verdict: check 4 — measured FAIL against the doc's own ≥60% numeric target**, with a live-measured,
source-traced root cause rather than an assumption. Money spent this run: ~$4.17 real Codex spend
across both instances. Both instances terminated, both fixture repos left in place under `/tmp`
(gitignored, outside this repo) for anyone wanting to re-inspect the transcripts; not part of this
repo's working tree.

**Status after this session: checks 1 and 3 unchanged (PASS). Check 2 now PASS (paired-run
confirmation of check 3's deviation, plus new evidence for the 2x soft-warning step). Check 4 now
has a real, measured, root-caused result: FAILS its own ≥60% target, for a reason tied to the
already-recorded LT-017 finding, filed as LT-270 (decision needed, not a bug to fix unilaterally).
Not renamed `_livetest_completed.md` — check 4's numeric target is not met, and closing the doc
would misrepresent that as a pass.**

## Evidence run — 2026-08-24 (batch A) — reviewed, no material change; not re-driven

Read this doc in full, including every prior evidence run, before starting this campaign's other
work. Confirmed via `git log --since=2026-08-19 -- context-cost-controller.ts turn-cost-governor.ts
compaction-coordinator.ts compaction-runtime.ts codex-app-server-adapter.ts context-safety-policy.ts`
that **none of the files this doc's checks depend on have changed** since the 2026-08-19/P1 run that
produced the current status (checks 1–3 PASS, check 4 measured FAIL/LT-270). Globally-installed Codex
CLI is `@openai/codex@0.149.0`; this session did not independently establish whether that build now
confirms `thread/compacted` (the stated falsifier for LT-017/LT-270) and, absent a code change or a
new observation to the contrary, did not re-spend real Codex money re-running the ≥$4 paired
governor-on/off comparison a third time this campaign purely to re-confirm an unchanged premise. This
session's live-provider budget went to the two still-genuinely-open checks in the sibling
loop-convergence-and-cost-safety doc instead (see that doc's 2026-08-24 evidence run).

**Status: unchanged — checks 1–3 PASS, check 4 measured FAIL against its own ≥60% target (LT-270,
decision needed). Not renamed `_livetest_completed.md`.**

## Evidence run — 2026-08-25 (batch C) — brief's "checks 2/4 NOT RUN" summary was stale; the doc's own last evidence section is current; a cheap live falsifier re-check confirms the premise is unchanged on Codex 0.149.1

This batch's brief described this doc's state as "check 1 PASS, check 3 PASS (first live confirmation
2026-08-24), checks 2 and 4 NOT RUN." Reading this doc in full, including every prior dated section,
found that summary does not match the doc's own most recent evidence run (2026-08-24, batch A, "no
material change; not re-driven"), which itself points back to 2026-08-19/N1 and 2026-08-19/P1: **check
2 was already driven live and is PASS** (2026-08-19/P1, paired governor-on/off run), **check 3 was
first driven live on 2026-08-19/N1**, not 2026-08-24, and **check 4 was already measured live**
(2026-08-19/P1, real paired comparison, ~$4.17 spend) and is a **measured FAIL against its own ≥60%
target**, root-caused and filed as **LT-270** (a decision pending James, not a live-testing gap). This
run trusts the doc's own dated evidence over the brief's paraphrase, per this campaign's "verify, don't
trust" convention — the brief's summary is recorded here as inaccurate for the benefit of the next
runner, not silently corrected in place.

Given that, there is nothing "NOT RUN" left to drive in the sense the brief meant. What remained
genuinely open was the doc's own stated falsifier for LT-017/LT-270: *"if a Codex build lands that
confirms `thread/compacted`, this premise changes and the original target becomes meaningful again."*
The globally-installed Codex CLI had moved from `0.149.0` (2026-08-24's version) to `0.149.1` since the
last check — a real, if minor, version bump — so this session spent a small amount of real Codex money
to test the falsifier directly rather than assume a patch bump changes nothing.

**Falsifier check, driven live.** Dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-C`, port 9453,
`AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, real IPC over CDP (`createInstance`/`sendInput`/`compactInstance`/
`terminateInstance`). One Codex instance (`x3gc74sl4`, `gpt-5.6-sol`, workspace `/tmp/aio-lt-C-ccg`), one
small establishing turn, then one manual `compactInstance` call:

```
elapsedMs: 35905
{ success: true, method: "restart-with-summary", nativeAttemptFailed: true,
  previousUsage: { used: 26450, percentage: 10.24 }, newUsage: { used: 0, percentage: 0 } }
```

Still ~36 s, still `restart-with-summary`, still `nativeAttemptFailed: true` — `thread/compacted` was
still never confirmed on `@openai/codex@0.149.1`. **The falsifier did not trip.** LT-017's finding, and
therefore LT-270's root cause and check 4's measured FAIL, remain current and unchanged; no drift since
the 2026-08-19/P1 measurement. This is a cheap (~1 minute, low-cost), live, direct re-check of the one
premise that could plausibly have moved since the last full evidence run — not a repeat of the full
paired ≥60% comparison, which nothing in this session's investigation suggested was warranted (`git log
--since=2026-08-24` against every file this doc's checks depend on — `context-cost-controller.ts`,
`turn-cost-governor.ts`, `compaction-coordinator.ts`, `compaction-runtime.ts`, `codex-app-server-adapter.ts`,
`context-safety-policy.ts` — returned zero commits).

Instance terminated, `/tmp/aio-lt-C-ccg` removed, dev app stopped, `/tmp/aio-lt-C` removed.

**Status: unchanged from the 2026-08-24 evidence run — checks 1–3 PASS, check 4 measured FAIL against
its own ≥60% target (LT-270, decision needed, not a live-testing gap). The falsifier for LT-017/LT-270
was re-tested live against a newer Codex point release (0.149.0 → 0.149.1) and did not trip. Not
renamed `_livetest_completed.md` — check 4's numeric target is still not met.**

## Current status correction — 2026-08-31

The status sentence immediately above predates the accepted LT-270 decision. Check 4's contract was
rescoped on 2026-08-20: on provider builds that never confirm native compaction, the automatic path
is a safety pause and must not increase cost or lose work. The measured run reduced input by 3.1%,
produced the equivalent verified result, and lost no work. Checks 1–4 therefore pass under the
current contract. This document is ready for the `_livetest_completed.md` lifecycle rename.
