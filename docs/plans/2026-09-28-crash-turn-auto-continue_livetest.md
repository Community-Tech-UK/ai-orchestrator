# Crash-Turn Auto-Continue — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-28-crash-turn-auto-continue_plan_completed.md](2026-09-28-crash-turn-auto-continue_plan_completed.md)

**Prerequisites:**

- Install or restart Harness from a DMG built from this checkout. James restarts it himself; do not
  restart Harness while live sessions run.
- A root, non-loop Copilot session (any provider works; Copilot matches the original report) in a
  scratch working directory, orchestrator not paused.
- Evidence sources: `~/Library/Application Support/Harness/logs/app.log` and
  `~/Library/Application Support/Harness/logs/lifecycle.ndjson`. Record the instance id and time
  window for every check.

## Status — 2026-09-28

Open: 3 · Closed: 0 · Failed: 0

Code, 18 unit tests (seven guards revert-checked), canonical gates, the full suite (26,895 tests)
and three fresh-eyes reviews passed. These checks remain open only because they need the rebuilt
app and a real provider process to kill.

## LT-A — A crash mid-turn continues automatically

Steps:

1. Ask for a long task (for example a 1,500-word essay written to a file) so the session is `busy`.
2. `pgrep -f "copilot.*--acp"`; `kill -9 <pid>` while it is working.

Expected:

- "Session reconnected automatically" (or "restarted automatically (resume failed)"), then
  "Continuing the interrupted turn automatically (attempt 1 of 2)", then the model resumes the task
  without the user typing anything.
- app.log: `Continuing a turn cut off by a provider restart`.
- The model does not describe the continuation as something the user said.

## LT-B — No continuation for an idle crash or a user interrupt

Steps:

1. With the session idle, kill its provider process. Wait for "Session reconnected automatically".
2. Start a long task, press Stop/interrupt in the UI.

Expected: neither produces a "Continuing the interrupted turn" notice or a new turn.

## LT-C — Cap and user takeover

Steps:

1. Repeat LT-A's kill three times in a row, each time after the automatic continuation starts.
2. Then send any message yourself and repeat LT-A once more.

Expected: attempts 1 and 2 continue; the third restart shows "The session restarted again after 2
automatic continuations. Work is preserved. Send "continue" to try again." and sends nothing.
After your own message, the next crash continues automatically again (attempt 1 of 2).

## Status — 2026-10-06

Open: 1 (LT-A's fresh-replay race, five first-seconds kills, was not re-run) · Closed: LT-B
(2026-10-04), LT-C including the post-takeover crash, and the LT-670 backoff survival · Failed: 0.
Not renamed `_completed`.

## Evidence run — 2026-10-06

Same dev app as the title-quality run (`/tmp/aio-lt-1006`, CDP 9444, Codex because Claude's weekly
quota was exhausted). Instance `xq4912snd`, scratch `/tmp/aio-lt-1006-ws`. Each `kill -9` was the
instance's own `processId`, parent Electron pid 2384, cwd `/tmp/aio-lt-1006-ws`, command
`codex app-server`. No other Codex process was killed.

- Stop while busy: `interruptInstance` returned `{interrupted: true}` and the session went idle.
  System lines were only the interrupt notices. "The provider ended this turn with an error" did
  not appear (LT-672).
- Kill 1 while the essay turn was busy (pid 60299): "Session reconnected automatically",
  "The provider process stopped during this turn. The work above is kept.",
  "Continuing the interrupted turn automatically (attempt 1 of 2).", status `busy`.
- Kill 2 (pid 69630): the same sequence at attempt 2 of 2, status `busy`.
- Kill 3 (pid 72602): status stayed `idle` with `waitReason {kind: "backoff", attempt: 3}` and the
  session was not terminated. When the backoff ended, the transcript showed
  "The turn was cut off again after 2 automatic continuations. Work is preserved. Send \"continue\" to try again."
  and nothing was sent (LT-670 and the cap).
- User message `continue`, then kill 4 (pid 76617) during that turn: backoff attempt 4, still not
  terminated, then "Continuing the interrupted turn automatically (attempt 1 of 2)." and status
  `busy`. The counter reset. The continuation was then interrupted so it would not keep writing.

LT-671's fresh-replay skip was not exercised: every recovery in this run resumed the session.

## Status — 2026-10-04

Open: 3 · Closed: 0 · Failed: 0 (see the 2026-10-04 evidence run: LT-A partial, LT-B pass,
LT-C partial; two defects reproduced, LT-670 and LT-671). Not renamed `_completed`.

## Evidence run — 2026-10-04 (batch A)

Dev app on the current working tree (HEAD `3d05e250e` plus other sessions' uncommitted work),
isolated profile `/tmp/aio-lt-1004-a`, Claude provider (`opus[1m]`, yolo, resident
`claude --print` child), scratch directory `/tmp/aio-lt-1004-a-ws`. Provider processes were killed
with `kill -9` only after confirming the pid was the instance's own `processId`, a child of this dev
app's main pid and a `claude --print` command line. Main-process logs are the dev app's stdout
(`_scratch/lt-2026-10-04/a/devapp-run1.log`, `devapp-run2.log`, `devapp-run3-ladder.log`,
`devapp.log`; UTC timestamps), plus `lifecycle-ladder-and-cap.ndjson`, `renderer-console.log`,
`dispatch-debug-1.json` / `dispatch-debug-2.json`. Launch deviation: the app had to be started with
`--no-sandbox` (Chromium's own sandbox cannot start inside this shell's Seatbelt fence: "sandbox
initialization failed: Operation not permitted"). For the dispatch traces the dev app was also
started with `--inspect=9469` and the continuation dispatch owner was wrapped in memory (no source
edit). One dev-profile setting was changed: `pauseOnVpnEnabled: false`, because a VPN interface came
up at 22:45 UTC and paused orchestrator input ("Instance input refused while orchestrator is
paused"); the profile is deleted at cleanup, production settings were not touched.

### Drift from the document (stated explicitly)

The document's expected strings predate the turn-ending refactor. Current source:
`src/main/instance/instance-crash-turn-continuation.ts` is only a compatibility entry point that
extends `InstanceReasoningCollapseContinuation` (`instance-reasoning-collapse-continuation.ts`) with
`crashOnly = true`; prompts and notices live in `turn-ending-continuation-policy.ts`, delivery in
`instance-continuation-dispatch.ts`.

- `Continuing a turn cut off by a provider restart` (app.log) no longer exists anywhere in `src/`
  (only in git history, `4de3be292`, `b8e064b9d`). Nothing is logged on a successful continuation any
  more; the observable signals are the transcript notices and `InstanceCommunication: sendInput called
  { autoContinuation: true }`. A refused or failed continuation logs nothing (except `Provider turn
  continuation failed` on a thrown error).
- Current transcript notices, in order: the recovery notice ("Session reconnected automatically" or
  "Session restarted automatically (resume failed)"), then "The provider process stopped during this
  turn. The work above is kept." (new, not in the document), then "Continuing the interrupted turn
  automatically (attempt N of 2)." The continuation prompt itself is stored as a `system` message with
  `internalInput` metadata, not a user message.
- The exhausted notice is now "The turn was cut off again after 2 automatic continuations. Work is
  preserved. Send \"continue\" to try again." (shared with reasoning-collapse/content-filter), not the
  document's "The session restarted again after 2 automatic continuations...". Judged against the
  current intended behaviour: same meaning, same remedy.
- The "evidence sources" in the prerequisites name `~/Library/Application Support/Harness/logs/`;
  the real directory is `harness` (lower case) and a dev app writes `lifecycle.ndjson` into its own
  profile (`<profile>/logs/`), but `app.log` into the production path.
- The commands `pgrep -f "copilot.*--acp"` apply to Copilot; Claude was used here
  (`pgrep -fl -P <dev app main pid>`, matched on the `claude --print` command line).

### LT-B — idle crash and user interrupt: PASS

1. Idle crash: instance `cy6mjrefx`, idle after a one-word turn, `kill -9` 88290 at 22:24:37 UTC.
   `Adapter exit event ... SIGKILL`, `Auto-respawning after unexpected exit`, `Recovery respawn
   complete ... resumed: true` (22:24:38.820), transcript notice "Session reconnected automatically".
   Observed for a further 40 s: status stayed `idle`, no "Continuing" notice, no new turn.
2. User interrupt: instance `ct26bzgb7`, `interruptInstance` at 22:46:31 and again at 22:47:31 on a
   busy long essay turn (`{interrupted: true}`). Status returned to `idle`; no "Continuing" notice and
   no new turn after 35 s; the instrumented dispatch owner recorded zero reservations
   (`__ltlog` empty).
   Side finding: both interrupts also posted "The provider ended this turn with an error. The work
   and error above are kept." — filed as **LT-672** (does not change the LT-B verdict, which is about
   continuation).

### LT-A — a crash mid-turn continues automatically: PARTIAL (passes when the session is resumed, fails intermittently when it falls back to a fresh replay)

- PASS path (resume succeeded): instance `cftjslroy`, essay turn killed 25 s in at 22:35:38 UTC after
  a completed first turn: "Session reconnected automatically" 22:35:39.742, "The provider process
  stopped during this turn..." 22:35:39.742, "Continuing the interrupted turn automatically (attempt 1
  of 2)." 22:35:39.906, status `busy`, `sendInput called { autoContinuation: true }`. Dispatch trace:
  `reserve ok:true` then `dispatch-end result:true` 167 ms later. Same on `cxjgp3fij` (22:42:57 kill,
  continuation 22:42:58.923) and `cy6mjrefx` (22:27:41 kill).
- Model behaviour: on `cy6mjrefx` (fresh-replay path, 22:25:34) the model resumed and wrote the full
  essay (1,749 words) on its own; the only occurrence of "cut off" in the answer is part of the essay
  ("cut off for weeks by storms"). It never described the continuation as something the user said
  (`LT-A-assistant-final.json`).
- FAIL path (fresh-replay fallback, "Session restarted automatically (resume failed)"): continuation
  silently skipped on five kills across four instances (`c790o4t0r` 22:29:51, `ckazlgmob` 22:31:08 and
  22:31:59, `cftjslroy` 22:34:27, `c1b9g729t` 22:38:35). Transcript ends at "The provider process
  stopped during this turn..."; session idle; no notice, no log. Instrumented trace for `cftjslroy`:
  `guard-false ... wait:{"kind":"respawning","strategy":"fresh-replay"} ... reserve ok:false`. Filed
  as **LT-671** with root cause (the `waitReason` is cleared after the `autoRespawn` message that
  triggers admission). Fresh-replay recoveries did continue in three other runs, so this is a race,
  not a constant.
- The document's second expectation (app.log line) does not exist any more (see drift).

### LT-C — cap and user takeover: PARTIAL (cap passes; the literal procedure fails at the fourth crash because of LT-670)

- Cap, instance `cxjgp3fij` (one short turn first, then a long essay; breaker attempts 0 s, 0 s, 10 s):
  kill 1 at 22:42:57 -> "Continuing ... (attempt 1 of 2)" 22:42:58.923; kill 2 at 22:43:20 ->
  "Continuing ... (attempt 2 of 2)" 22:43:20.710; kill 3 at 22:43:42 (10 s breaker wait) ->
  "The turn was cut off again after 2 automatic continuations. Work is preserved. Send "continue" to
  try again." at 22:43:53.024 and **nothing sent**: status `idle`, no new turn, the dispatch trace
  has no third `reserve`. PASS (message text drift noted above).
- Takeover reset, instance `cy6mjrefx` (first run): attempt 1 of 2 at 22:25:34, then my own message
  22:27:32, then `kill -9` at 22:27:41 -> "Continuing ... (attempt 1 of 2)" at 22:27:52.512 again.
  PASS — the counter resets on a user message.
- Literal doc sequence, same instance `cxjgp3fij`: after the cap I sent "continue" and killed once
  more (22:44:23). That is the instance's fourth crash within the hour, so the circuit breaker
  imposed a 30 s wait; the renderer watchdog terminated the session 15.06 s later (22:44:38.827,
  `respawning -> terminated`), so the "next crash continues automatically (attempt 1 of 2)" step could
  not be completed on any instance inside one hour. Filed as **LT-670** (P1). The takeover reset
  itself is proven by the `cy6mjrefx` run above.

### Residual (why this doc stays open)

Fix LT-670 and LT-671, then re-run: LT-A with the kill in the first seconds of a brand-new session's
first long turn (five times), and LT-C's complete sequence including the post-takeover fourth crash.
Everything else in the document is verified live above. Instances created: `cy6mjrefx`, `c790o4t0r`,
`ckazlgmob`, `cftjslroy`, `c1b9g729t`, `ce1ab6sw7` (lost in an app restart), `c3c1wkkq5`,
`cxjgp3fij`, `ct26bzgb7`; all terminated or destroyed.
