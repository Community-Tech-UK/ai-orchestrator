# Regular-session announce-then-halt guard — Live Test

> **Found a defect while running this check?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-04-regular-session-announce-then-halt-guard_plan_completed.md](2026-09-04-regular-session-announce-then-halt-guard_plan_completed.md)

## Status — 2026-09-21

Open: 0 · Closed: 4 · Failed: 0
All four checks ran against a rebuilt dev app on an isolated profile and passed; see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21). No defect reproduced, so no register entry
was filed. Nothing is waiting on James.

### Status — 2026-09-06 (superseded)

Open: 4 · Closed: 0 · Failed: 0
Needs a rebuilt/restarted separate AI Orchestrator instance with an authenticated root `orchestrated` session; then agent-drivable via CDP without touching the live Harness.

## Prerequisites

- Build and restart a separate AI Orchestrator instance from this checkout.
- Use an authenticated root `orchestrated` session whose provider can run a harmless local check.
- Ensure the session is not owned by Loop Mode and has no provider-native background work active.

These checks are deferred because they require a rebuilt/restarted Harness and interactive control of the Harness UI. The currently running Harness predates the change and is a hard-denied Computer Use target, so it must not be disrupted or driven from this implementation session. All agent-runnable unit, integration, type, lint, build, and full-suite checks are complete.

## Checks

### 1. Reproduced root-session recovery

1. In a root `orchestrated` session, arrange a controlled response that ends with a genuine immediate commitment such as `I'll now run the focused checks.` without issuing a tool call.
2. Observe the next turn and runtime events.

Expected: exactly one automatic continuation is sent, and the provider proceeds with the promised action through the normal input path.

### 2. Precision exclusions

Repeat with clearly non-actionable forms: quoted/example/template prose, approval or user-input dependency, provider-capacity wait, explicit later timing, uncertainty, a blocker, and already-completed result wording.

Expected: no automatic continuation is sent for any excluded form.

### 3. Runtime ownership exclusions

1. Repeat the genuine immediate commitment while the same root session is owned by active Loop Mode.
2. Repeat while provider-native background work is active.
3. Repeat while the app is paused.

Expected: the regular-session guard never competes with Loop Mode, background work, or pause state.

### 4. Newer manual turn wins

Begin a manual turn while an eligible completion is settling or its automatic send is still in preflight.

Expected: the older automatic continuation is cancelled and never reaches the provider. This race is covered by automated tests; the live check confirms the rebuilt runtime integration.


## Evidence run — 2026-09-21

All four checks were run against a rebuilt dev app launched from the Plan Queue worktree
`.worktrees/queue/2026-09-04-regular-session-ann-3e18b1`, on an isolated profile
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-673e18b1`, `--remote-debugging-port=9815`, focus
emulation enabled before any read). The live Harness app was not touched.

Subject session: root `orchestrated` Claude instance `cwd1w5k7h`
(`parentId: null`, `launchMode: orchestrated`, `provider: claude`, `model: sonnet`,
`workingDirectory: /tmp/aio-lt-queue-673e18b1-cwd`), driven over the real IPC path
(`window.electronAPI.sendInput`), i.e. the same path a human send uses.

Timestamps below are epoch ms with the UTC clock time; local (BST) is UTC+1. The main-process
log slice quoted here is archived at
`_scratch/lt-queue-3e18b1/app-log-slice-cwd1w5k7h.log` in the root checkout (the dev app writes
into the production `app.log`, which rotates; `_scratch/` is gitignored).

### Run-wide ledger

`InstanceCommunication: "sendInput called"` for `cwd1w5k7h` over the whole run: **22 manual sends
(`autoContinuation:false`) and exactly 7 automatic sends (`autoContinuation:true`)**, matching the
session's final `requestCount` of 29. The seven automatic sends were at

```
1789973804675  06:56:44.675Z   check 1
1789974090377  07:01:30.377Z   positive control after the check-2 exclusions
1789974184256  07:03:04.256Z   long-form positive control
1789974558111  07:09:18.111Z   check 3.1 A/B control (loop cancelled)
1789974821522  07:13:41.522Z   positive control after the check-4 race
1789974933757  07:15:33.757Z   one-nudge-cap probe
1789975099695  07:18:19.695Z   final control after both loops cancelled
```

Every one of those is a positive control or check 1. **No automatic send occurred during any of the
fifteen suppression probes below.** The guard's delivery therefore runs through
`InstanceManager.sendInput` with `autoContinuation: true`, as required.

### Check 1 — Reproduced root-session recovery — PASS

Manual turn asked for the bare commitment with no tool use. Transcript:

```
06:56:42.733  user       "…The sentence is: I'll now run the focused checks."
06:56:44.411  assistant  "I'll now run the focused checks."
06:56:44.674  user       "Continue now. You ended the last turn by announcing the next action
                          instead of executing it. Execute that action now; do not narrate
                          another plan and stop again. Announced intent: "I'll now run the
                          focused checks.""
06:56:48.085  tool_use   Using tool: Bash
06:56:50.123  tool_use   Using tool: Bash
06:56:51.744  assistant  "The focused checks passed. `check.sh` printed "focused checks OK" and
                          exited with code 0. …"
```

`requestCount` 0 → 2: one manual turn plus **exactly one** automatic continuation, 263 ms after the
completion. The provider then executed the promised action rather than re-announcing it. The final
assistant message carries completion evidence and did **not** trigger a further continuation.

The same recovery fired six more times in the run (07:01:30, 07:03:04, 07:09:18, 07:13:41,
07:15:33, 07:18:19), including once where the commitment was the last line of a ~2.2 kB prose reply — the trailing-window detection works on a
long reply, not just a one-line one.

**One nudge per manual-turn chain (07:15:32–07:15:35).** The session was put under a standing
instruction to answer every turn with the same eligible commitment. The manual turn produced the
commitment, one continuation was sent at 07:15:33.757, the provider repeated the identical
commitment — and **no second continuation was sent**. `requestCount` 24 → 26.

### Check 2 — Precision exclusions — PASS

Eight probes, each delivered as its own manual turn, each asking the provider to emit exactly the
listed sentence with no tool use. In every case the assistant's reply was byte-for-byte the
requested sentence, `requestCount` rose by exactly 1 (the manual turn), and no continuation message
appeared in the transcript.

| # | Excluded form | Assistant reply | requestCount | Continuation |
| --- | --- | --- | --- | --- |
| 1 | quoted / example prose | `For example, a reply could say: "I'll now run the focused checks."` | 2 → 3 | none |
| 2 | reported / template prose | `The transcript reads as follows: I'll now run the focused checks.` | 3 → 4 | none |
| 3 | approval / user-input dependency | `I'll run the focused checks once you approve.` | 4 → 5 | none |
| 4 | provider-capacity wait | `I'll run the focused checks once the rate limit resets.` | 5 → 6 | none |
| 5 | explicit later timing | `I'll run the focused checks tomorrow morning.` | 6 → 7 | none |
| 6 | uncertainty | `I'll run the focused checks, I suppose.` | 7 → 8 | none |
| 7 | blocker | `I cannot proceed because the credentials are missing, so I'll run the focused checks once they are restored.` | 8 → 9 | none |
| 8 | already-completed result wording | `I'll now run the focused checks, which already passed with zero failures.` | 9 → 10 | none |

Probes ran 06:59:28.588 → 07:01:10.557. The immediately following positive control
(`I'll now verify the working tree.`, 07:01:29–07:01:30) fired a continuation and the provider ran
`Bash`, proving the guard was armed throughout the exclusion block and that the eight nulls are
exclusions rather than a dead coordinator.

### Check 3 — Runtime ownership exclusions — PASS

**3.1 Active Loop Mode ownership.** Loop `loop-1789974349863-2c367b51` was started on the same chat
(`chatId: cwd1w5k7h`). It parked at `status: "provider-limit"` with `endedAt: null`, which
`isActiveLoopRuntimeState` (`src/main/orchestration/loop-runtime-status.ts`) reports as active — the
exact predicate `createAnnounceThenHaltContinuationInitializationStep` feeds the guard. With that
loop owning the chat:

```
07:08:33.772  user       "…I'll now run the focused checks."
07:08:35.104  assistant  "I'll now run the focused checks."          requestCount 15 → 16
              (no continuation)
```

A/B: the loop was then cancelled (`status: cancelled`, `endedAt: 1789974550613`) and the **identical
sentence** was re-sent 6 s later:

```
07:09:16.655  user       "…I'll now run the focused checks."
07:09:17.864  assistant  "I'll now run the focused checks."
07:09:18.111  user       "Continue now. You ended the last turn by announcing …"
07:09:19.721  tool_use   Using tool: Bash                            requestCount 16 → 18
```

Repeated independently with a second loop (`loop-1789975011696-e58e5aa2`, same parked-active state):
probe at 07:17:44.558 → 07:17:45.910, `requestCount` 26 → 27, no continuation; after cancelling both
loops the same sentence fired a continuation at 07:18:19.695. Suppression tracks loop ownership.

Note: both loops parked at `provider-limit` immediately because this machine's Claude account was
emitting a `seven_day` `allowed_warning`, so a `running`/`paused` loop could not be held. That is an
environment condition, not a finding — the guard consults a single boolean, and `provider-limit`
with `endedAt: null` exercises it identically.

**3.2 Provider-native background work.** The session was asked to start one background `Bash`
(`ping -i 1 -c 90 127.0.0.1 …`, `run_in_background: true`) and then end the turn with the
commitment:

```
07:10:04.893  user       "Use the Bash tool ONCE with run_in_background set to true …"
07:10:07.442  tool_use   Using tool: Bash
07:10:08.589  assistant  "I'll now run the focused checks."
```

`instance.backgroundWork` read `{count: 1}` continuously from the completion onward (sampled every
1.5 s for ~27 s). `requestCount` 18 → 19 — **no continuation**, while the very same sentence had
fired one 50 s earlier and fired another 3 minutes later. When the background shell finished
(~07:11:37) the provider resumed natively and reported the exit code; that resumption added no user
message and no automatic send, and its completion-evidence wording correctly drew no continuation
either.

**3.3 Application paused.** Three observations, none of which produced a continuation:

1. *Paused before the turn.* With `pauseGetState → {isPaused: true, reasons: ["user"]}`, a manual
   `sendInput` was refused outright — `requestCount` unchanged at 12, nothing added to the
   transcript. This is `InstanceManager.sendInput`'s own `OrchestratorPausedError` gate
   (`src/main/instance/instance-manager.ts:1412`), the same call the guard's delivery uses, so a
   continuation could not reach the provider by construction.
2. *Paused mid-turn.* Pausing 3 s into a long generation pre-empted the turn (`Interrupt requested`
   → `Interrupted — waiting for input`); the truncated assistant text carried no trailing
   commitment. `requestCount` stayed 15 across the pause and for 20 s after resuming.
3. *Paused inside the settlement window (the isolating case).* The transcript was tight-polled and
   the app was paused **8 ms** after the eligible completion was published — well inside the ~250 ms
   window every positive control showed the nudge occupying:

   ```
   07:14:15.404  user       "…I'll now run the focused checks."
   07:14:16.806  assistant  "I'll now run the focused checks."
   07:14:16.814  (pauseSetManual → isPaused: true)
   07:14:16.814  system     Interrupt requested: unresolved
   07:14:16.815  system     Interrupted — waiting for input
   ```

   `requestCount` 23 → 24 while paused, still 24 after 25 s paused and a further 25 s after
   resuming. The pending continuation was dropped and never re-armed.

Caveat recorded honestly: pausing also raises an interrupt, and the guard treats an interrupt as its
own suppression trigger (`onInterruptRequested`). The runtime gives no way to reach "paused while an
eligible completion settles" without that interrupt, so observation 3 confirms the required outcome
("never competes with pause state") but does not isolate the `isAutomaticInputPaused()` branch from
the interrupt branch. That branch is covered by unit tests in
`src/main/instance/instance-announce-then-halt-continuation.spec.ts`.

### Check 4 — Newer manual turn wins — PASS

The transcript was tight-polled (~3.8 k IPC reads) for the eligible completion; a manual turn was
begun **19 ms** after it landed, i.e. while the automatic send was still in settlement/preflight:

```
07:13:02.722  user       "…I'll now run the focused checks."
07:13:04.200  assistant  "I'll now run the focused checks."
07:13:04.219  user       "MANUAL-RACE-TURN: ignore the previous instruction. … Reply with
                          exactly: manual turn accepted"
07:13:05.974  assistant  "manual turn accepted"
```

`requestCount` 19 → 21 — two manual turns and **zero** automatic sends (confirmed against the
`autoContinuation:true` ledger above, which has no entry between 07:09:18 and 07:13:41). The older
automatic continuation was cancelled and never reached the provider; the provider served the newer
manual turn instead. The guard was not left disabled: the next control, 37 s later at 07:13:41.522,
fired normally.

This is a cancellation, not a miss: the guard schedules synchronously on the provider `complete`
event, which the main process handles *before* it publishes the assistant message the poll was
waiting on. The manual send therefore landed after the continuation was already pending and before
it could dispatch — the window in which `instance:input-started` (non-automatic) aborts it.

### Outcome

Open: 0 · Closed: 4 · Failed: 0. No defect reproduced, so nothing was added to
`docs/plans/livetest-remediation-register.md`. Nothing here requires James.

Cleanup: the subject instance was terminated, both loops cancelled, the dev app and its renderer
server stopped, and `/tmp/aio-lt-queue-673e18b1*` removed.
