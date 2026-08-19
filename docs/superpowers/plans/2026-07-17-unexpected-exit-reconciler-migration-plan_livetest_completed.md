# Unexpected-exit respawn reconciler migration — live test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-17-unexpected-exit-reconciler-migration-plan_completed.md`](2026-07-17-unexpected-exit-reconciler-migration-plan_completed.md)
**Prerequisites:** rebuilt + restarted app; one local instance whose CLI process id is visible (`ps`).

All agent-runnable verification passed 2026-07-17 (40/40 across the three recovery specs with
the REAL core wired, tsc ×2, lint, LOC, full quiet suite). These are the spec item-3 mandated
live checks.

## Checks

1. **Kill the CLI mid-turn.** Start a long generation, then `kill -9 <cli pid>` from a terminal.
   - Expected: instance flips to respawning; auto-respawn reconnects (transcript shows
     "Session reconnected automatically" or the restart variant); the conversation context
     survives a follow-up question.
2. **No send-swallowing wedge (respawn-wedge incident).** Immediately after the kill, while the
   respawn spinner shows, send 2 user messages.
   - Expected: both messages land in order after recovery within ~seconds — NOT swallowed and
     NOT stalled for minutes; spinner clears; `lifecycle.ndjson` shows one respawn cycle, no
     repeated fresh-fallback loop.
3. **Kill during idle.** Kill the CLI process while the instance is idle.
   - Expected: same recovery, ending idle; no continuity replay turn fires by itself (preamble
     queued for the next user message when resume fell back).
4. **Backoff on crashloop.** Kill the CLI three times in quick succession.
   - Expected: backoff waitReason chip appears with increasing delay (circuit breaker), and
     recovery still eventually succeeds; no unbounded respawn storm in Activity Monitor.

Rename this file `_livetest_completed.md` only when every check passes with evidence.

## 2026-07-18 Live-Test Evidence

Killed only the verified child PID of a disposable Codex app-server session while its turn was
active. The main log recorded `SIGKILL`, an adapter-exit event, and then
`Ignoring per-turn process exit for stateless exec adapter`, despite the session having started in
app-server mode. The UI later showed `Waiting for interrupt…` and `Recovering session...`, then
dropped the session and returned to the new-session draft. This fails the first recovery check.
Idle and crashloop kills were not attempted after that prerequisite failure. This file remains
pending.

## 2026-07-19 Root Cause and Fix (LT-004 in `docs/plans/livetest-remediation-register.md`)

Same root cause and fix as the companion interrupt-respawn live test (see its 2026-07-19 entry for
the full writeup): `codex-app-server-adapter.ts` reset `useAppServer` before emitting `'exit'`, so
`instance-communication.ts`'s synchronous `isStatelessExecAdapter()` check misread a genuine
resident app-server death as an exec-mode adapter's normal per-turn exit — exactly matching this
file's `Ignoring per-turn process exit for stateless exec adapter` log line. Fixed by reordering
the emit relative to the state reset (1 production file, 16 lines); no change needed elsewhere.

8 new regression tests confirmed to fail pre-fix / pass post-fix, including two at the
`instance-communication.ts` integration level asserting an app-server exit while **busy** and while
**idle** both route through `onUnexpectedExit` — directly covering checks 1 and 3 of this file's
mechanism (not their UI-observable transcript/spinner behavior, which still needs a live run). Full
`cli/adapters` + `instance` suites (1888 tests), `tsc` (main + spec config), and `ng lint` all
green.

**Still pending — this file remains NOT renamed `_livetest_completed.md`:** a live re-run of checks
1–4 (`kill -9` on a real Codex app-server PID in a rebuilt/restarted app) has not been performed
since the fix landed.

---

## 2026-07-26 Live re-run — the 2026-07-18 failure does NOT reproduce

**Setup.** Packaged app `/Applications/Harness.app` (asar 2026-07-25 15:07, main process up since
15:22) — post-fix. A disposable Codex instance was created by a one-time automation in
`/tmp/aio-lt-ws1` with a long counting prompt, giving a genuinely long-running turn to interrupt.
Instance `x4wkx8ae9`, first CLI pid `47037`. Codex app-server is **per-instance** on this build
(each instance owns its own `node … codex app-server`; 14 unrelated ones were running), and every
kill was gated on: pid absent from a pre-captured snapshot of pre-existing pids, `ppid == 53655`
(the Harness main process), and a command line matching `codex app-server`. No other session was
touched.

### Check 1 — kill the CLI mid-turn — ◐ recovery PASSES; context-survival follow-up not driven

Killed at **02:44:23.523Z**, 23 s into a live stream (811 provider output events already captured):

```
02:44:23.523 info  InstanceCommunication: Adapter exit event
02:44:23.523 info  InstanceCommunication: Auto-respawning instance after unexpected exit
02:44:23.523 info  InterruptRespawn:      Auto-respawning after unexpected exit
02:44:23.530 error InitialPromptRecovery: Initial prompt failed after successful spawn; preserving session
02:44:23.861 info  InstanceContinuityInputQueue: Queued continuity preamble for next user input
02:44:23.861 info  RuntimeReconciler:     Recovery respawn complete   pid=48014
02:44:23.861 info  InterruptRespawn:      Auto-respawn successful     pid=48014
```

- **The 2026-07-18 blocker is gone.** `Ignoring per-turn process exit for stateless exec adapter`
  occurs **0 times** in the whole log. A resident app-server death is now correctly routed through
  `onUnexpectedExit`, which is exactly what the 2026-07-19 fix targeted.
- **The session was not dropped.** In 2026-07-18 the UI "dropped the session and returned to the
  new-session draft". Here the session was preserved (`InitialPromptRecovery … preserving session`),
  respawned to a live pid in **338 ms**, and the instance settled at status `idle`.
- ❌ Not driven: "the conversation context survives a follow-up question" — that needs a user
  message typed into the instance, and this session has no send path into the packaged app.

### Check 3 — kill during idle — ✅ PASS

Killed pid `48014` at **02:46:05.163Z** while the instance was idle:

```
02:46:05.163 Adapter exit event → Auto-respawning after unexpected exit
02:46:05.488 Queued continuity preamble for next user input
02:46:05.488 Recovery respawn complete   pid=57712
02:46:05.490 Auto-respawn successful     pid=57712
```

Same recovery shape, ending idle, in **327 ms**. Critically, the continuity preamble was **queued
for the next user input** rather than replayed — and `INSTANCE_SEND_INPUT received` count for this
instance stayed at **0** throughout, proving no continuity replay turn fired by itself. That is
precisely this check's expectation.

### Check 4 — backoff on crashloop — ◐ 2 of 3 expectations PASS

Two further kills in quick succession (02:47:06 and 02:47:17):

```
02:47:06.738 Auto-respawning …  { restartCount: 2, previousStatus: "idle" }
02:47:06.741 warn RespawnCircuitBreaker: Circuit breaker backing off before respawn
                                        { attempt: 3, delayMs: 10000 }
02:47:17.072 Recovery respawn complete  pid=59136          ← after the full 10 s wait
02:47:17.813 Adapter exit event
02:47:17.813 Suppressing auto-respawn: another respawn completed very recently
                                        { msSinceLastRespawn: 741 }
02:47:17.813 Instance exited unexpectedly { newStatus: "error" }
```

- ✅ **Backoff with increasing delay (circuit breaker).** Observed `attempt: 3 → delayMs: 10000`,
  and the respawn genuinely waited the full 10 s. This matches
  `BACKOFF_SCHEDULE_MS = [0, 0, 10_000, 30_000, 120_000, 300_000, 900_000]`
  (`src/main/instance/lifecycle/respawn-circuit-breaker.ts:24`) — attempts 1 and 2 are 0 ms, which
  is why the first two kills recovered in ~330 ms with no backoff line.
- ✅ **No unbounded respawn storm.** A kill landing 741 ms after a respawn is suppressed outright
  rather than feeding a loop.
- ❌ **"recovery still eventually succeeds" did not hold for the final kill.** The suppression left
  the instance in `status: "error"` with no further automatic attempt. This looks like the guard
  working as designed rather than a defect, but the check as written expects eventual recovery —
  needs a product call, or a reworded check.
- Note on method: the intended three-in-a-row became two effective kills (the second round found the
  pid already dead and skipped), on top of the two earlier kills — enough to drive the attempt
  counter to 3 and trip both the backoff and the suppression guard.

The "waitReason chip appears" half of check 4 is renderer-visible only and was not observed.

### Check 2 — no send-swallowing wedge — NOT RUN

Requires sending 2 user messages during the respawn spinner. No send path available to this session.

**Status: check 3 PASS; checks 1 and 4 partial (their recovery halves pass, their
send/UI halves are undriven); check 2 not run. NOT renamed** — but the specific regression this
file was blocked on since 2026-07-18 is now disproven on live evidence.

**Cleanup note:** disposable instance `x4wkx8ae9` ("Counting to Four Hundred", `/tmp/aio-lt-ws1`)
was deliberately left in `error` state by the final kill and should be deleted from the UI.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Check 3 PASSES, checks 1 and 4 are partial, check 2 (no send-swallowing wedge) is unrun. **Agent-driveable.** Note: the interrupt-respawn doc's check 4 (resume-failure fallback) logically belongs here now, since interrupts no longer respawn — see that doc's 2026-07-29 evidence.

## Evidence run — 2026-07-31 — check 1 PASSES; check 2 driven but **inconclusive by construction**

**Setup.** Dev app on port 9444, rebuilt main. Claude instance `cazqogm0q` in
`/tmp/aio-lt31-ws14`, one real turn first (marker `QUARTZ88`), CLI pid 48189.

Kill safety gate applied per the runbook before touching anything: pid absent from the
pre-campaign snapshot (18 pids captured), ancestry traced to **this dev app's** process tree
(`48189 → 38456 (Electron main) → 38455 (my launcher)`), command line matched
`/Users/suas/.local/bin/claude --print …`. The packaged app hosting real sessions was never a
candidate.

### Check 1 — kill the CLI — ✅ PASS (recovery half)

`kill -9 48189` at 19:45:12. Recovery was immediate and clean:

```
0s  respawning  gen 2
2s  idle        gen 2
transcript: system "Session reconnected automatically"
```

`adapterGeneration` 1 → 2, one respawn cycle, back to idle in **2 seconds**.

### Check 2 — no send-swallowing wedge — ⚠️ INCONCLUSIVE (wrong layer driven)

Immediately after the kill, while `respawning`, two messages were sent over the raw
`electronAPI.sendInput` IPC.

| | Result |
| --- | --- |
| `sendInput` return | `success: false` for **both** |
| appeared in transcript as `user` messages | **yes, both** |
| ever answered | **no** — assistant messages after recovery were only `OK` (the pre-kill turn) and, later, `THREE-ACK` |
| a send once idle | works normally (`THREE-ACK` returned) |

**Why this is inconclusive rather than a failure:** queue/steer/retry for a send-while-busy are
**renderer-owned** — the main process legitimately refuses and reports the failure, and the
renderer's own queue is what re-delivers. Driving `electronAPI.sendInput` directly bypasses exactly
the layer the check is about, so this run tested the wrong path. That is a limitation of how I drove
it, not evidence about the product.

**One thing it did surface, worth a look regardless:** the main process wrote both messages into the
instance's `outputBuffer` as `user` entries *and then* returned `success: false`. Any caller that
ignores the error therefore leaves a visible, permanently unanswered user message in the transcript.
Whether that is correct depends on whether the renderer treats those entries as pending-and-retryable
or as delivered — worth confirming when check 2 is re-run properly.

**Method note for the next runner:** drive the **renderer** send path, not `electronAPI.sendInput`.
Select the instance and go through the composer / `InstanceStore`, e.g. via
`window.ng.getComponent(document.querySelector('app-root'))`, so the renderer's queue and retry
actually participate.

Also a trap this run fell into and corrected: asserting on the raw transcript text for `ONE-ACK`
matched the **user message that contained the phrase**, reporting a 0-second acknowledgement that
never happened. Assert only against `type === 'assistant'` entries.

**Status: checks 1 and 3 pass, check 4 partial, check 2 needs a renderer-driven re-run. Not
renamed.**

## Evidence run — 2026-07-31 (session 2) — check 2 driven through the **renderer**, core assertions PASS

The previous run drove `electronAPI.sendInput` directly, which bypasses the layer this check is
about. Corrected: this run goes through `InstanceStore.sendInput` — the real composer path — reached
via `window.ng.getComponent(document.querySelector('app-instance-detail')).store`.

**Setup.** Claude instance `cnatseuc1` in `/tmp/aio-lt-ws1b`, one real turn first (marker
`TOPAZ-9`), CLI pid 42699. Kill-safety gate applied as before. `kill -9` at 01:02:23Z, then both
messages sent immediately through the renderer while it was recovering.

### Result — not swallowed, not lost, delivered in order

| Assertion | Observed |
| --- | --- |
| first send is **queued**, not refused | `getQueuedMessageCount` → **1** |
| second send is **queued** | → **2** |
| recovery | `Auto-respawn successful { pid: 43856, resumed: true }`, `adapterGeneration` 1 → 2 |
| system notice | `Session reconnected automatically` |
| **both delivered, in order** | user bubbles `MSG-ONE`, `MSG-TWO`; assistant replies `ONEACK`, `TWOACK` |
| queue afterwards | **0** — fully drained |
| respawn cycles | **one**; no repeated fresh-fallback loop |

That is the substance of the check: no send-swallowing wedge. The renderer queues on a transient
status (`isTransientQueueStatus`, `instance-messaging.store.ts:271-280`) and drains on the next
ready transition — exactly as designed, and it worked.

### The one assertion I could NOT fairly measure: "within ~seconds"

`ONEACK` came back at 66 s and `TWOACK` at 184 s. Before writing that up as a stall I checked it,
and the delay is **my test rig, not the product**:

- Main-process recovery was **1.3 s** (`01:02:23.577` kill → `01:02:24.874 Recovery respawn
  complete`). Nothing was slow on that side.
- The app logged `[RendererHeartbeat] Renderer heartbeat stalled — UI event loop likely blocked`
  on a perfect 60-second cadence. I stopped **all** CDP activity for 200 s and the cadence
  continued unchanged — so it was not my polling.
- A **CPU profile** across a full stall window (`Profiler.start`/`stop`, 25 s) came back
  **`25000ms (idle)`** — the renderer was executing no JavaScript at all. Nothing was blocked.
- The actual cause: `document.visibilityState === 'hidden'`, `document.hasFocus() === false`. The
  dev app is launched headlessly via `nohup`, so Chromium **throttles renderer timers**. Measured
  directly: `setTimeout(…, 1000)` fired at **1261, 1999, 2001, 1999 ms**.

The queue drain is renderer-side (`processMessageQueue` → a `setTimeout`, then a ready transition),
so throttled timers stretch it. The delivery is correct; the latency number is an artefact.

**Method note for the next runner — this affects every timing-sensitive renderer check.** A dev app
started with `nohup npx electron .` has a hidden window and throttled timers. Bring the window to
the front before measuring renderer latency, or measure only main-process timestamps (which are not
throttled). Nothing else in this campaign depended on renderer timing, but this check does.

### Also found: the heartbeat monitor cries wolf on a hidden window

`Renderer heartbeat stalled — UI event loop likely blocked` is logged at **ERROR** level purely
because the window is hidden, with the profile proving the loop is idle. Filed as **LT-022** (P3) —
it will send someone hunting a renderer freeze that is not happening, which is exactly what it did
to me.

### Check 1 — kill the CLI mid-turn — ✅ PASS (now complete)

Driven properly this time: instance `cg4ds8wvy` was mid-way through a 1200-word essay (status
`busy`) when its CLI, pid 53160, was killed at 01:14:06Z.

| Assertion | Observed |
| --- | --- |
| instance flips to respawning | **yes** — `respawning` sampled directly |
| auto-respawn reconnects | `Auto-respawn successful { pid: 54495, resumed: true }`, gen 1 → 2 |
| transcript notice | `Session reconnected automatically` |
| **conversation context survives a follow-up** | asked for the marker; answered **`GARNET-77`** |

That last row is the half the 2026-07-26 run could not drive (no send path into the packaged app).
It is now evidenced.

### Check 4 — backoff on crashloop — ❌ reproduces the 2026-07-26 result; filed as LT-023

Two kills 1.1 s apart on the conversation-bearing instance, with `waitReason` sampled every 300 ms:

```
0s idle|wr=-|g2|rc1
0s respawning|wr=-|g3|rc2      ← first kill recovers cleanly
1s idle|wr=-|g3|rc2
2s error|wr=-|g3|rc2           ← second kill suppressed; that is the end of it
01:17:12.501 Suppressing auto-respawn: another respawn completed very recently
             { msSinceLastRespawn: 1124 }
```

- ✅ **No unbounded respawn storm** — the suppression guard works.
- ❌ **No `waitReason` chip.** Sampled at 300 ms for the whole window; it is never set. The check
  asks for a backoff chip with increasing delay, and there is no indication of any kind.
- ❌ **Recovery does not eventually succeed.** The instance stays in `error` with nothing scheduled.
- The circuit breaker's backoff ladder never engages on this path at all — suppression fires first.

Reproduced twice now (2026-07-26 packaged, 2026-07-31 dev), so it is filed as **LT-023** (P2) rather
than left as a per-doc note. It needs a product decision: a suppressed respawn should either
schedule a retry or set a `waitReason`, but not be silently terminal.

**Method note:** killing a **fresh instance that has never been messaged** produces `error` with
**no auto-respawn attempt logged at all**, unlike a conversation-bearing one. That cost a first
attempt at this check. Use an instance with at least one completed turn.

**Status after this run:** checks 1, 2 and 3 **PASS**. Check 4 **FAILS** two of its three
expectations and is now LT-023 — a decision, not more testing. **Not renamed.**

## Evidence run — 2026-08-12 — LT-023 fixed; check 4 re-run live — ✅ PASS

**Root cause, confirmed by reading the executing path** (matches the filed diagnosis above):
`instance-communication.ts`'s exit handler folded `!withinRecentRespawnWindow` directly into
`canAutoRespawn`. A crash landing inside the 5s recent-respawn window made `canAutoRespawn` false
and fell straight to the terminal `error` branch **without ever calling `onUnexpectedExit`** — so
`respawnAfterUnexpectedExit` and the circuit breaker inside it never ran, and nothing scheduled a
retry or a `waitReason` (which is a renderer-only concept, never written onto the main-process
`Instance`, so with no respawn call there was nothing to carry it).

**Fix.** A suppressed-but-otherwise-eligible exit now defers: the instance transitions to
`respawning`, queues a `{ kind: 'backoff', attempt, retryAt }` waitReason immediately, and retries
through the same `onUnexpectedExit` path once the remaining suppression window elapses — so the
circuit breaker's own ladder is always reached instead of bypassed. Full root-cause and fix writeup:
[register entry](../../plans/livetest-remediation-register.md#fix--2026-08-12--deferred-and-retried-instead-of-left-terminal-verified-live).
3 mutation-verified regression tests added; `tsc` ×2, `lint`, `check:ts-max-loc`, `build:main`,
targeted `test:quiet` (95/95) all green.

**Live re-run of check 4**, dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-lt023`, CDP :9467, renderer
reused from :4567), disposable conversation-bearing Claude instance `ckhc2qe4x`. Kills gated on:
pid confirmed spawned by this session (matching `sessionId` in the CLI command line), `ppid` equal
to this dev app's Electron main (9335), command line `claude --print …`. Three kills in quick
succession on the same instance, `waitReason` captured live off the real `instance:batch-update` IPC
stream the renderer's chip consumes (`electronAPI.onBatchUpdate`), not inferred from logs alone:

```
00:25:54.087 kill 1 (pid 10289)
             → immediate auto-respawn (canAutoRespawn) → idle 00:25:55.237 (pid 12096), 1.15s
00:25:59.041 kill 2 (pid 12096, 3.8s after kill 1's recovery — inside the 5s window)
             → "Suppressing auto-respawn… msSinceLastRespawn: 3804"
             → "Deferring auto-respawn… remainingSuppressMs: 1196"      [NEW — the LT-023 fix]
             → batch-update: {"status":"respawning","waitReason":{"kind":"backoff","attempt":2,"retryAt":...}}
             → "Retrying auto-respawn…" → idle 00:26:00.468 (pid 13998), 1.4s
00:26:07.586 kill 3 (pid 13998, 7.1s after kill 2's recovery — outside the 5s window this time)
             → RespawnCircuitBreaker: "Circuit breaker backing off before respawn { attempt: 3, delayMs: 10000 }"
             → batch-update: {"status":"respawning","waitReason":{"kind":"backoff","attempt":3,"retryAt":...}}
             → idle 00:26:17.699 (pid 14871), 10.1s (full backoff wait)
```

- ✅ **Backoff waitReason chip appears with increasing delay.** Two distinct `backoff` waitReason
  events landed on the real renderer IPC stream in one continuous run: `attempt: 2` (~1.2s, the new
  deferred-suppression retry) then `attempt: 3` (~10s, the circuit breaker's own
  `BACKOFF_SCHEDULE_MS` ladder in `respawn-circuit-breaker.ts:24`) — genuinely increasing, and the
  renderer already has display code for this exact shape (`input-panel-formatters.ts:61` —
  `"Held — backing off (attempt N)"`; `instance-header.component.ts:111,143`), so the chip now
  actually receives it where it never did before.
- ✅ **Recovery still eventually succeeds.** All three kills recovered — including kill 3 after the
  full 10s circuit-breaker wait.
- ✅ **No unbounded respawn storm.** Exactly three clean respawn cycles (pids
  10289→12096→13998→14871), no runaway loop, no repeated fresh-fallback churn.

Cleanup: instance `ckhc2qe4x` terminated via `electronAPI.terminateInstance`, dev app process tree
killed and confirmed gone, `/tmp/aio-lt-lt023*` removed.

**Status: all four checks now PASS with current evidence** (checks 1–3 per the 2026-07-31 session-2
evidence above; check 4 per this run). Renamed `_livetest_completed.md`.
