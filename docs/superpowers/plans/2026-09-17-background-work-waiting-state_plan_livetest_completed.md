# Background Work Waiting State — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-17-background-work-waiting-state_plan_completed.md](2026-09-17-background-work-waiting-state_plan_completed.md)

**Prerequisites:**

- Rebuild and restart the packaged Harness app from this checkout. The implementing session ran
  inside that app, so it could not restart it. Everything below needs the new main process.
- Use a Claude session. Any model works; Haiku keeps it cheap.
- Coordinator log: `~/Library/Application Support/harness/logs/app.log`.

Already verified in-loop on 2026-09-17 in an isolated dev app (not repeated here): the rail ring and
header halo appear while an explicit `run_in_background` job runs, clear when it finishes, and
Claude resumes on its own with no duplicate "A background task has finished" message.

## Status — 2026-09-21

Open: 0 · Closed: 3 · Failed: 0

All three checks passed against a live dev app on 2026-09-21. Evidence:
[Evidence run — 2026-09-21](#evidence-run--2026-09-21).

### Status — 2026-09-17 (superseded)

Open: 3 · Closed: 0 · Failed: 0

## Outstanding checks

### 1. A command moved to the background by its timeout shows the waiting indicator

Why deferred: needs the rebuilt packaged app. This is the shape of the original incident
(session `c6czs5jux`).

1. In a Claude session send: `Run this with the Bash tool, foreground, timeout 5000, not in the
   background: python3 -c "import time; time.sleep(60); print('done')". When it is moved to the
   background, reply only WAITING and do not check it.`
2. When the reply `WAITING` appears, look at the session's rail row and header.

Expected: the rail badge has a dashed steel-blue breathing ring (no spinner, no amber dot); hovering
the badge shows `Claude · Waiting on 1 background task (since HH:MM)`; the header dot is steel blue
with a halo and titled `Waiting on background work`. About a minute later the ring clears and Claude
posts a short turn about the result by itself.

### 2. A hung background job gets exactly one automatic check-in after 10 minutes

Why deferred: needs the rebuilt packaged app and 10+ minutes of wall time.

1. In a Claude session send: `Use the Bash tool with run_in_background true to run
   python3 -c "import time; time.sleep(1500)". Then reply only WAITING. Do not check it.`
2. Leave the session idle for 12 minutes. Do not send anything.

Expected: between 10 and 11 minutes after `WAITING`, a user message starting
`Automatic check-in: background work you started is still running` appears, followed by a Claude
turn that checks the job. `app.log` has one `Checking in on stalled background work` line for the
instance. No second check-in appears for the same job in the following 10 minutes. Afterwards, stop
the job (ask Claude to stop it) and confirm the ring clears.

### 3. A waiting session is not hibernated

Why deferred: needs the rebuilt packaged app and the idle-hibernation window to elapse.

1. Repeat check 2's prompt with a 40-minute job (`time.sleep(2400)`), and leave the session idle past
   the configured idle-hibernation threshold.

Expected: the session stays live (the rail keeps the ring, no hibernated dimming); `lifecycle.ndjson`
has no `idle -> hibernating` transition for the instance while the job runs.

## Evidence run — 2026-09-21

Run by the Plan Queue livetest worker on branch `queue/2026-09-17-background-work-wai-2de31e`.
**Result: 3 of 3 checks pass. No defect reproduced, so no `LT-NNN` register item was filed.**

### Environment

- The prerequisite above asks for a rebuilt **packaged** app. That was not used and was not needed:
  the packaged app has no debug port and hosts James's live sessions, so the campaign runbook's
  route for any interactive check is a freshly built dev app on its own profile. What the
  prerequisite is actually asking for — a main process built from this checkout, which the
  implementing session could not restart — is satisfied.
- Dev app built and launched from the queue worktree
  (`npm run build:main`; renderer built with `ng build --configuration development` and served on
  `:4567` per the runbook's no-`ng serve` fallback).
- Isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-bb2de31e`, CDP on `9726`.
  `Emulation.setFocusEmulationEnabled` was sent before every DOM assertion, so no reading here is
  the occluded-window artefact.
- Provider: Claude CLI, model `haiku`, YOLO on, working directory `/tmp/aio-lt-bgwork-work`.
- Main-process log lines are quoted from the shared production
  `~/Library/Application Support/harness/logs/app.log` (a dev app writes there); every quoted line
  is keyed by one of this run's instance ids. Lifecycle transitions come from the **dev profile's**
  `/tmp/aio-lt-queue-bb2de31e/logs/lifecycle.ndjson`.
- Evidence bundle (log slices, per-20s state monitor NDJSON, screenshots) copied outside the
  worktree to `_scratch/lt-bgwork-2026-09-21/` in the root checkout.

Two deliberate environment changes were made **in the isolated dev profile only** and are restored
at the end of this section:

| Setting | Default | Set to | Why |
| --- | --- | --- | --- |
| `autoTerminateIdleMinutes` | 30 | 3 | Check 3's threshold. See the note under check 3. |
| `pauseOnVpnEnabled` | true | false | The host had a live VPN tunnel; see the note under check 2. |

Instances used:

| Id | Role |
| --- | --- |
| `cva0ln5mt` | Check 1 — foreground command moved to background by its timeout (two runs) |
| `cdj2tgpbw` | Check 2 — first hung-job run (hit the VPN pause hold) |
| `clk72ttbv` | Check 2 — clean rerun with the app unpaused |
| `crdmt2w98` | Check 3 — 40-minute hung job |
| `c7ytj5h0n` | Check 3 control — no background work, must hibernate |

### Check 1 — a timeout-moved command shows the waiting indicator — PASS

Sent verbatim at 08:21:33.494Z, with a 60-second sleep and `timeout 5000`. Claude ran the command in
the foreground, the CLI moved it to the background, and the session replied `WAITING` at 08:21:45
and went `idle`.

Main-process state while idle (read through `listInstances()`):

```
status: idle    backgroundWork: { count: 1, since: 2026-09-21T08:21:43.978Z }
```

So the timeout-moved wording is parsed and registered — the gap that made the original incident
(`c6czs5jux`) invisible is closed.

A second run with a 240-second sleep (sent 08:23:04.922Z, `WAITING` 08:23:14) gave a long enough
window to read the rendered DOM. At 08:23:40.598Z, with focus emulation on:

```json
{
  "status": "idle",
  "backgroundWork": { "count": 1, "since": 1789978992924 },
  "rail": {
    "badgeClasses": "provider-badge provider-background-waiting",
    "tooltip": "Claude · Waiting on 1 background task (since 09:23)",
    "ringBorder": "2px dashed rgb(122, 162, 200)",
    "ringAnimation": "background-waiting-breathe 2.4s",
    "hasSpinnerClass": false,
    "hasNeedsAttention": false
  },
  "header": {
    "dotClasses": "status-indicator background-waiting",
    "dotTitle": "Waiting on background work",
    "dotAria": "Waiting on background work",
    "backgroundColor": "rgb(122, 162, 200)",
    "animation": "background-waiting 2.4s",
    "spinnerPresent": false,
    "pulsing": false
  }
}
```

Every clause of the expectation is met: dashed steel-blue breathing ring (`#7aa2c8`), no spinner, no
amber attention dot, the tooltip in the required `Claude · Waiting on 1 background task (since
HH:MM)` shape (09:23 local = 08:23 UTC), and a steel-blue header dot with the halo animation and the
title `Waiting on background work`. The tooltip is also the `aria-label`, so it is not colour-only.

When each job finished the ring cleared and Claude posted its own short turn, with no duplicate
app-sent continuation:

```
run 1  08:22:38  ring still present   →  08:22:52  backgroundWork null, classes back to "provider-badge"
                 08:22:43 assistant: "Command completed (exit code 0)."   ← the CLI's own turn
run 2  08:27:09  backgroundWork 1 → 0 (20s state monitor)
```

`requestCount` stayed at 2 across both runs, which is exactly the two prompts this evidence run sent
to `cva0ln5mt` — the counter tracks sends, and neither self-resume added one. The app logged, for
each run, that it stood down:

```
2026-09-21T08:22:39.190Z InstanceAsyncWorkContinuation Background-result continuation not needed; the provider resumed on its own {"instanceId":"cva0ln5mt"}
2026-09-21T08:27:08.170Z InstanceAsyncWorkContinuation Background-result continuation not needed; the provider resumed on its own {"instanceId":"cva0ln5mt"}
```

Screenshot of the waiting state: `_scratch/lt-bgwork-2026-09-21/check1-waiting.png`.

### Check 2 — exactly one automatic check-in after 10 minutes — PASS

**First run hit the documented pause hold, not a defect.** `cdj2tgpbw` replied `WAITING` at
08:24:37.928Z with `backgroundWork {count: 1, since: 08:24:36.616Z}`. The check-in was due at
08:34:38 and did not arrive. The cause was found in the app's own state rather than guessed:

```json
pauseGetState() → { "isPaused": true, "reasons": ["vpn"], "pausedAt": 1789979446481 }
```

The host genuinely had a VPN tunnel up (`utun12`, `inet 10.159.191.254`, MTU 1350), the detector
paused the app at 08:30:46.481Z, and `InstanceAsyncWorkContinuation.automaticInputBlocked()` holds
every automatic send while paused — which is the behaviour the plan specifies. `checkedInWork` is
only recorded *after* that guard passes, so the check-in was deferred, not consumed.

Setting `pauseOnVpnEnabled: false` in the isolated profile cleared the pause at 08:38:31.363Z, and
the very next 60-second sweep delivered the held check-ins:

```
2026-09-21T08:38:36.181Z InstanceAsyncWorkContinuation Checking in on stalled background work {"instanceId":"cdj2tgpbw","backgroundTasks":1,"silentForMs":838144}
2026-09-21T08:38:36.453Z InstanceAsyncWorkContinuation Checking in on stalled background work {"instanceId":"crdmt2w98","backgroundTasks":1,"silentForMs":794540}
```

**Clean rerun with the app unpaused (`clk72ttbv`) is the one that satisfies the stated timing.**
`WAITING` at 08:41:02.261Z; nothing sent to the session afterwards:

```
2026-09-21T08:51:36.264Z InstanceAsyncWorkContinuation Checking in on stalled background work {"instanceId":"clk72ttbv","backgroundTasks":1,"silentForMs":633919}
```

`silentForMs` 633,919 = **10.57 minutes** after `WAITING`, inside the required 10–11 minute window,
on the first sweep tick past the threshold. The transcript shows the expected user message and a
Claude turn that actually checks the job:

```
08:51:36.289 user:      Automatic check-in: background work you started is still running, and this
                        session has been silent for 11 minutes. Check its output now. …
08:51:40.879 tool_use:  Read
08:51:42.597 assistant: The sleep command is still running normally with 14 minutes remaining on the
                        25-minute total.
```

**Exactly one check-in per job.** `app.log` holds one `Checking in on stalled background work` line
for each of `cdj2tgpbw`, `crdmt2w98` and `clk72ttbv`, and no more, over the whole run. The
20-second state monitor (08:25:49 → 09:00:38, 111 snapshots, no gaps) records exactly three `requestCount`
increments in total — one per instance, each at its own check-in — and no others:

```
08:38:49.323Z cdj2tgpbw 1 -> 2
08:38:49.323Z crdmt2w98 1 -> 2
08:51:38.323Z clk72ttbv 1 -> 2
```

`requestCount` counts sends, so this is a direct count of automatic sends: one each. The final
transcripts agree — one user message beginning `Automatic check-in` per instance:

```
cva0ln5mt autoCheckIns=0   cdj2tgpbw autoCheckIns=1   crdmt2w98 autoCheckIns=1
c7ytj5h0n autoCheckIns=0   clk72ttbv autoCheckIns=1
```

Coverage of the "following 10 minutes" clause: `cdj2tgpbw` was still at one check-in and
`requestCount` 2 at 09:00:38, 22.0 minutes after its check-in (its job had finished at 08:49:38,
11.0 minutes in, which itself produced no second check-in). `clk72ttbv` was read directly at
09:03:13 — 11.6 minutes after its check-in, job still live — and had `requestCount` 2 and one
`Automatic check-in` message.

Incidentally, `cdj2tgpbw`'s 1500-second job ran to completion at 08:49:38 and the CLI resumed by
itself, again with no duplicate:

```
08:49:38.834 assistant: Background task completed successfully (exit code 0).
2026-09-21T08:49:36.839Z InstanceAsyncWorkContinuation Background-result continuation not needed; the provider resumed on its own {"instanceId":"cdj2tgpbw"}
```

**Stopping the job clears the ring.** Asked `clk72ttbv` to stop its background task at 09:03:24.010Z;
it replied `STOPPED` at 09:03:29. Rail row before and after, read from the live DOM:

```
before  backgroundWork {count: 1}  class "provider-badge provider-background-waiting"
                                   tooltip "Claude · Waiting on 1 background task (since 09:41)"
after   backgroundWork null        class "provider-badge"     tooltip "Claude"
```

### Check 3 — a waiting session is not hibernated — PASS

`crdmt2w98` ran `time.sleep(2400)` with `run_in_background: true` and replied `WAITING` at
08:25:21.640Z.

**Threshold note.** The idle-hibernation window is the `autoTerminateIdleMinutes` setting, whose
default is 30 minutes (`src/shared/types/settings-defaults.ts:137`, synced onto
`HibernationManager.idleThresholdMs` by `runIdleHibernationSweep`). Left at 30 the check is not just
slow but unsound: the 10-minute stall check-in resets `lastActivity`, so the 30-minute window would
restart at roughly the same moment the 40-minute job ended. The setting was therefore lowered to
**3 minutes** in the isolated profile, which exercises the same `hasInhibitor()` guard on the same
code path, and a control session with no background work was run alongside to prove the sweep was
actually firing.

The control hibernated on schedule; the waiting session never did:

```
2026-09-21T08:28:59.998Z IdleHibernationSweep Auto-hibernating idle root session {"instanceId":"c7ytj5h0n","idleMs":226486,"idleMinutes":3}
2026-09-21T08:31:06.211Z IdleHibernationSweep Auto-hibernating idle root session {"instanceId":"cva0ln5mt","idleMs":236001,"idleMinutes":3}
2026-09-21T08:53:25.383Z IdleHibernationSweep Auto-hibernating idle root session {"instanceId":"cdj2tgpbw","idleMs":226465,"idleMinutes":3}
```

All three are sessions whose background work had already finished (`cva0ln5mt` at 08:27:09,
`cdj2tgpbw` at 08:49:38) or that never had any (`c7ytj5h0n`). Each hibernated 3.8–3.9 minutes after
its last turn. `crdmt2w98` never appears in that list.

Those three lines also prove the sweep was **running and reaching a decision** throughout
`crdmt2w98`'s idle stretch rather than being asleep: it hibernated other sessions at 08:28:59,
08:31:06 and 08:53:25, all of them inside that stretch. So `crdmt2w98` was evaluated and passed
over, which is what `getHibernationCandidates`' `!hasInhibitor(inst.id)` filter
(`src/main/process/hibernation-manager.ts:213`) is supposed to do.

The VPN pause from check 2 does not confound this. `HibernationManager`'s only deferral,
`resumeDeferredUntil`, is set solely by `handleSystemResume()`, not by the pause coordinator — and
observably, `cva0ln5mt` hibernated at 08:31:06, inside the paused window. In any case the
24.8-minute stretch cited below runs from 08:38:42, after the pause had cleared at 08:38:31.

`lifecycle.ndjson` for `crdmt2w98`, complete, from the dev profile:

```
08:25:08.536Z initializing -> idle
08:25:08.573Z idle -> ready
08:25:08.573Z ready -> busy
08:25:21.640Z busy -> idle
08:38:36.477Z idle -> ready      ← automatic stall check-in
08:38:36.477Z ready -> busy
08:38:42.196Z busy -> idle
09:03:30.901Z idle -> ready      ← job killed, CLI resumed on its own
09:03:30.901Z ready -> busy
09:03:31.314Z busy -> idle
```

Zero `idle -> hibernating` transitions (`grep -c hibernating` on the instance's lines returns `0`)
across 38 minutes of session life, including one unbroken **24.8-minute** stretch `idle` while
holding live background work — 8.3× the configured threshold — against controls that hibernated at
3.8–3.9 minutes.

The rail also never showed hibernated dimming for it. At 08:41:16, with three waiting sessions and
two hibernated ones on screen at once:

```
row 1  provider-badge provider-hibernated         "Claude · hibernated — send a message to wake"
row 2  provider-badge provider-background-waiting "Claude · Waiting on 1 background task (since 09:24)"   2px dashed rgb(122,162,200)
row 3  provider-badge provider-background-waiting "Claude · Waiting on 1 background task (since 09:25)"   2px dashed rgb(122,162,200)
row 4  provider-badge provider-hibernated         "Claude · hibernated — send a message to wake"
row 5  provider-badge provider-background-waiting "Claude · Waiting on 1 background task (since 09:41)"   2px dashed rgb(122,162,200)
```

Screenshot: `_scratch/lt-bgwork-2026-09-21/rail-mixed-states.png`.

`crdmt2w98`'s job was killed as collateral at 09:03:31 when `clk72ttbv` was asked to stop its own
sleep; by then check 3's window was long since complete. Its ring cleared on the kill and the CLI
reported the failure by itself, which is the correct terminal behaviour for a `stopped`/failed task.

### Cleanup performed

- All five instances terminated; `/tmp/aio-lt-bgwork-work` removed.
- `autoTerminateIdleMinutes` restored to 30; `pauseOnVpnEnabled` restored to true.
- Dev app stopped, `http-server` stopped, `/tmp/aio-lt-queue-bb2de31e` removed.
