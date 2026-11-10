# Crash-Turn Auto-Continue — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-28-crash-turn-auto-continue_plan_completed.md](2026-09-28-crash-turn-auto-continue_plan_completed.md)

**Current status — 2026-11-10, queue-worker run on a rebuilt dev app (fcade3):** LT-A PASS
(five of five fresh first-turn replays continued); LT-B PASS (idle crash and Stop cause no
continuation, and Stop no longer posts the provider-error notice); LT-C PASS (cap, takeover
and post-takeover fourth crash); the original four-idle-crash shape also PASS. Earlier
2026-10-27 failures (LT-A, LT-672) do not reproduce on this checkout. Verification round 1 fixes: LT-A's
Expected app.log line was stale (that string was removed from source) and now names the live
`sendInput called { autoContinuation: true }` line; the evidence `seal.txt` no longer lists itself and
`shasum -a 256 -c seal.txt` passes. No check needs James.
Ready for independent verification; the coordinator owns any `_completed` rename.

**Prerequisites:**

- The current Plan Queue brief authorizes building and launching an isolated dev app. That
  runtime satisfies this campaign's process-crash checks; the original installed-release
  procedure below does not require James to restart his live Harness for this queue run.
- Install or restart Harness from a DMG built from this checkout. James restarts it himself; do not
  restart Harness while live sessions run.
- A root, non-loop Copilot session (any provider works; Copilot matches the original report) in a
  scratch working directory, orchestrator not paused.
- Evidence sources: `~/Library/Application Support/Harness/logs/app.log` and
  `~/Library/Application Support/Harness/logs/lifecycle.ndjson`. Record the instance id and time
  window for every check.

## Status — 2026-09-28

On main: yes (this landing commit)
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
- app.log: `sendInput called { instanceId: <id>, autoContinuation: true }` (the original wording `Continuing a turn cut off by a provider restart` was removed from source by commits `4de3be292`/`b8e064b9d`; the current log line and the in-session transcript notice are the equivalent evidence, corrected 2026-11-10).
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


## Evidence run — 2026-10-27 (campaign-defects queue worker)

Claude LT-C and LT-670 PASS on the assigned rebuilt runtime: four idle crashes survived backoff; a separate established-session busy sequence continued twice, capped the third, and reset to attempt one after user takeover. LT-A fresh first-turn replay FAIL in five of five new sessions: strategy fresh-replay was actually sampled, with no continuation during the 45-second recovery watches. Real Claude Stop did not auto-continue, but reproduced LT-672's erroneous provider-error notice. These are separate assertions.

Full scoped evidence: [campaign final handoff](2026-10-05-livetest-campaign-defects_livetest.md), with command/observation receipts in `2026-10-05-livetest-campaign-defects_evidence/2026-10-27-bd99c0f5/` in the assigned queue checkout. Source f5fffc23c653de06d1dfe409f74b0f776dc2e1db; isolated profile and all owned providers were stopped. No completed-name rename or source repair is claimed.

## Evidence run — 2026-10-27 (crash-turn queue worker, b26e570b)

All three checks were exercised on the assigned checkout at HEAD `80412201a`, which has
no implementation diff from its base (`git diff main...HEAD` empty). Main/preload and a
fresh renderer were built from this worktree. Real Claude Code 2.1.310 (`sonnet`) was used;
Copilot and an installed DMG were not tested. Isolated profile
`/tmp/aio-lt-queue-b26e570b`, CDP 9643, renderer 4663, main inspector 9743, main PID 16675.
The existing bootstrap heap flag was passed explicitly and the disposable app used
`--no-sandbox`. Focus emulation preceded renderer evaluation; `document.hidden` was false.
The separate CDP visibility-override method is unsupported in this Electron.

Durable evidence in the assigned queue checkout:
[report](2026-09-28-crash-turn-auto-continue_evidence/2026-10-27-b26e570b/report.md),
with source hashes, per-command build/typecheck/test receipts, per-kill ownership checks,
event histories, timelines, lifecycle records and cleanup/integrity receipts beside it.
The document was edited at its canonical root-checkout path, not copied into the worktree.

### LT-A — FAIL: five early crashes recover without continuation

Each new root, non-loop Claude session was killed roughly one second after entering busy on
its first long request. Every recovery used fresh replay. All showed the restart and
"provider process stopped" system notices, then remained idle with request count 1, no
continuation notice and no automatic input event during the observation window.

| Trial | Instance | Killed PID | Kill time UTC | Observation |
| --- | --- | --- | --- | --- |
| LT-A1 | ccvpasmau | 27796 | 10:27:52.018 | 45 seconds |
| LT-A2 | cunsbox8e | 36000 | 10:29:06.081 | 45 seconds |
| LT-A3 | crqrjqhy7 | 41059 | 10:29:56.531 | 45 seconds |
| LT-A4 | c1vc6jj4k | 47557 | 10:30:49.782 | 70 seconds |
| LT-A5 | c09aoor7j | 56485 | 10:32:04.829 | 70 seconds |

Receipts: `LT-A<N>-kill.json`, `-timeline.json`, `-result.json`, `-termination.json`.
Before each actual SIGKILL, the PID was matched to the instance, checked absent from the
pre-provider process snapshot, checked parented to this Electron PID, and matched against
the actual Claude `--print` argv. `/bin/ps` was explicitly refused by the environment;
the permitted macOS process APIs supplied these checks instead. No pattern kill was used.

Pass-through dispatcher observers on trials 3–5 establish that the old admission guard now
accepts the stale recovery wait. On trials 4 and 5 `reserve` succeeds but `dispatch` returns
false after its 60-second settlement timeout, with no input sent. The executing dispatcher
waits on `InstanceManager.waitForInstanceSettled`, which delegates to
`InstanceSettledTracker`; its idle predicate requires assistant/error output
(`src/main/instance/instance-continuation-dispatch.ts:172`, `instance-manager.ts:1015`,
`instance-state-machine.ts:115`). These first-turn transcripts contain only user/system
messages. The current blocker is therefore settlement after admission, not the historical
stale-wait reservation refusal. This is recorded as the existing **LT-671** acceptance
failure, with matching status in the active campaign follow-up. The first three watches
ended before the dispatch deadline; no timeout claim is made for those trials.

The old app.log success string remains absent from current source, as noted in the prior
evidence. No fresh-replay model response exists to assess attribution wording. LT-C verifies
that dispatched continuation prompts are Harness-authored system input; it does not reverify
the model's narration or completion of the essay.

### LT-B — PASS; LT-672 remains a separate failure

`cuz7b1w7o` completed a real `READY` turn. Its idle PID 52642 was killed at about
10:32:17 UTC; recovery reconnected it and the 35-second watch stayed idle at request count
1, with no automatic input or continuation. See `LT-B-idle-kill.json` and
`LT-B-idle-result.json`.

Two actual busy essay turns were interrupted through the real `interruptInstance` IPC.
The first return could not be retained because CDP reported "Promise was collected";
its actual events/state are in `LT-B-stop-first-observation.json`. After pinning the
evaluation promise, the repeated check returned `{ interrupted: true }`, reached idle and
stayed there at request count 3 through 35 seconds without continuation or automatic input.
See `LT-B-stop-result.json` for the immutable busy pre-state, return and full watch.

Both stops nevertheless posted "The provider ended this turn with an error. The work and
error above are kept." Normalized completions at 10:33:46.768 and 10:34:46.756 UTC carry
`finish: aborted_streaming`, `unknown_error / provider_error`. This reproduces **LT-672**;
it does not change LT-B's narrower no-continuation verdict.

### LT-C — PASS, including the post-takeover fourth crash

Established session `c8a4psjb0` first returned `READY`, then received the long essay request.

- PID 72257 killed busy at 10:33:45: automatic attempt 1, request count 3.
- PID 85640 killed during that continuation at 10:33:50: automatic attempt 2, count 4.
- PID 87252 killed during the second continuation at 10:33:55: exhausted notice, idle,
  count 4 unchanged through a 20-second watch, no third automatic input.
- A user continuation request was sent at 10:34:27, then busy PID 92013 killed at
  10:34:30. The session survived the 30-second circuit-breaker backoff, recovered and
  automatically continued at attempt 1 at 10:35:02, count 6. It was then interrupted.

See `LT-C-1` through `LT-C-3` kill/recovery receipts, `LT-C-capped.json` and
`LT-C-takeover-recovery.json`. Exactly three automatic input-started events were retained.
Continuation prompts are `system` messages with
`internalInput: { actor: harness, source: crash-turn-continuation }`. This confirms the
LT-670 fourth-crash survival condition for LT-C; its separate four-idle-crashes procedure
was not repeated here.

### Verification, handoff and cleanup

The main/preload build, fresh renderer dev compilation, both TypeScript checks and the
focused continuation tests passed. No product code or tests changed. Full-suite, lint,
production renderer build, packaged-app, Copilot and model-narration checks were not rerun;
this was an evidence-only run with failed first-turn acceptance, not a repair or closure.

LT-671 and LT-672 are technical repair work, with no missing authority or human fact from
James. The register has current evidence; the existing untracked
`2026-10-27-campaign-defects-runtime-followup_plan.md` records matching implementation status.
The historical `_completed` remediation plans remain unchanged. The backlog file now
explicitly forbids adding current status, so this owner and the register carry the result.

Report, command/observation receipts and the pre-cleanup seal precede runtime deletion.
Final settings/process/port/path readback is recorded in `cleanup-receipt.json`; final
evidence integrity is in `seal.json`. This document is not renamed. Independent acceptance
and closure remain the queue coordinator's work.

## Evidence run — 2026-11-10 (crash-turn queue worker, fcade3)

All checks run on the assigned checkout, branch `queue/2026-09-28-crash-turn-auto-con-fcade3`, HEAD
`f4cc70357a5b37871cbc3f065bb8fd363b16f6d0`, no source diff and no product code or test changed.
`npm run build:main` (exit 0) and a development renderer build were made from this worktree. Real Claude Code
(`sonnet`, yolo, resident `claude --print`); Copilot and an installed DMG were not tested (the prerequisites allow
any provider and the queue brief supersedes the installed-release procedure). Isolated profile
`/tmp/aio-lt-queue-83fcade3`, CDP 9893, renderer :4683, Electron `--no-sandbox` (Chromium's own sandbox cannot start
inside this shell's fence). Focus emulation on, `document.hidden` false. One dev-profile setting changed:
`pauseOnVpnEnabled=false` (profile deleted at cleanup). Durable evidence (gitignored, in the queue checkout):
`docs/plans/2026-09-28-crash-turn-auto-continue_evidence/2026-11-10-fcade3/` (`report.md`, `trials/*.json`,
`main-process-log-slice.txt`, `command-receipts.json`, `seal.txt`, the two driver scripts).

Session note: the session was paused for provider usage mid-run. The first dev app (pre-pause) was closed over CDP
and relaunched (main pid 97647) because the reopened session could not signal the earlier processes; every result
below is from the relaunched app. The old `ng serve` renderer server (pid 82037) belongs to the earlier session and
could not be signalled from here; it only serves files and is listed under cleanup.

Every SIGKILL passed four gates first: pid is the instance's own `processId`; absent from the pre-run `claude --print`
snapshot; parent is the Electron main pid (`lsof -R`); cwd is the scratch directory; command line is `claude --print`.
No pattern kill.

### LT-A — PASS, five of five

New root, non-loop session; the long essay request sent immediately; kill about one second after the session turned
busy and while the first turn had no resumable transcript. All five recoveries were fresh replays
(`Recovery respawn complete ... resumed: false`).

| Trial | Instance | Kill UTC | Continuation |
| --- | --- | --- | --- |
| LT-A1 | cnzhei1q4 | 02:38:32.5 | `sendInput { autoContinuation: true }` 02:38:33.774; request count 1 to 2, busy |
| LT-A2 | cl6bux61r | 02:40:25.0 | `autoContinuation: true` 02:40:26.202; count 1 to 2, busy |
| LT-A3 | chzyu1yge | 02:42:16.0 | transcript below; count 1 to 2 |
| LT-A4 | c08syn8k5 | 02:43:42.2 | same transcript; count 1 to 2 |
| LT-A5 | c7azevsrs | 02:45:05.6 | same transcript; count 1 to 2 |

A3 to A5 transcripts, in order: "Session restarted automatically (resume failed)", "The provider process stopped
during this turn. Your message and the work above are kept.", "Continuing the interrupted turn automatically
(attempt 1 of 2).", then the continuation prompt as a `system` message with
`internalInput: {actor: harness, source: crash-turn-continuation}`. A1 and A2 transcripts were not captured (capture
was added for A3); they rest on the main-process log, request count and status. The model resumed the task each time
(tool calls, then the single word `DONE`; `essay.md` was 1,551 words after the last trial). Its output never
attributes the continuation to the user. The original `Continuing a turn cut off by a provider restart` app.log string no longer exists in source, so
LT-A's Expected line was corrected to the live equivalent: the `sendInput called { autoContinuation: true }` line (present
for all five trials at the times above) plus the transcript notice "Continuing the interrupted turn automatically
(attempt 1 of 2)". Nine `autoContinuation: true` inputs appear in the log: these
five, one from the mid-turn kill in the first LT-B attempt, and three from LT-C, and no others.

The 2026-10-27 failure (continuation never sent on a fresh replay) does not reproduce here. The earlier run's
diagnosis was a settlement timeout in `waitForInstanceSettled`; the dispatcher in this checkout asks for
`mode: 'input-ready'` for crash continuations (`instance-continuation-dispatch.ts:175`, added by `67adab3ec`).

### LT-B — PASS (both halves), and LT-672 is fixed live

- Idle crash, instance `c075n3ljt` (`LT-B2run.json`): a READY turn completed (assistant reply seen), 1.5 s later the
  idle provider pid 61581 was killed at 02:48:49. Native resume, "Session reconnected automatically", idle at request
  count 1 for the 40 s watch; no continuation notice, no automatic input in the log.
- Stop, same instance: essay turn busy, `interruptInstance` after 4 s returned `{success:true,data:{interrupted:true}}`,
  idle at once, request count 2 unchanged for 40 s. Transcript: "Stopping…", "You stopped the agent.", "Stopped.
  Ready for your next message." No "The provider ended this turn with an error" notice (the LT-672 symptom). The first
  attempt (`LT-B.json`, instance `cqt2g2j79`) shows the same clean Stop. Its "idle" kill actually landed mid-turn (my
  wait returned before the turn started), so it is not used as idle-crash evidence; the mid-turn kill continued
  correctly.

### LT-C — PASS, including the post-takeover fourth crash

Established session `cwx1q67ia` (READY first, then the essay request; `LT-C.json`).

- Kill 1 02:50:37 busy: "Session reconnected automatically", "Continuing ... (attempt 1 of 2)", count 3.
- Kill 2 02:50:41: fresh replay, "Continuing ... (attempt 2 of 2)", count 4.
- Kill 3 02:50:46: 10 s backoff, fresh replay, then "The turn was cut off again after 2 automatic continuations. Work
  is preserved. Send "continue" to try again." Idle, count 4 unchanged for the 45 s watch, nothing sent.
- User message `continue` 02:51:~40 (count 5, busy), then kill 4 at 02:51:45: backoff attempt 4 (30 s) at 02:52:16
  while the session stayed `respawning` and was not terminated, then "Continuing ... (attempt 1 of 2)", count 6, busy.
  The counter reset on the user message. The session was then interrupted and terminated.

### LT-670 original shape (extra) — PASS

Instance `cwzummxrm` (`LT-D.json`): four idle crashes after a completed READY turn. Recoveries: native resume,
then backoff attempt 2 (a few seconds), attempt 3 (10 s) and attempt 4 (30 s), each ending in "Session reconnected/restarted
automatically" and idle. The session was never terminated and no continuation was sent (count stayed 1 for a further
15 s).

### Verification and cleanup

`npm run test:quiet` on the five continuation, dispatch, settled-tracker and policy specs: 63 tests passed (exit 0).
`npm run typecheck` and `npm run typecheck:spec`: exit 0. Not run: the full suite, lint, production renderer build,
packaged app, Copilot, installed-DMG procedure. Nothing here changes code, so those were not needed for this
evidence-only run. No new defect was reproduced, so no new `LT-NNN` was added; the register status rows for LT-670,
LT-671 and LT-672 carry the live result. This document is not renamed.

Cleanup: all instances terminated; the dev app was closed over CDP (port 9893 no longer answers, main pid 97647
gone); `/tmp/aio-lt-queue-83fcade3`, its `-ws` scratch directory, the worktree `_scratch` and `.angular` cache were
deleted; the dev-profile `pauseOnVpnEnabled` change went with the profile. Left running: the development `ng serve`
(pids 82037 and 82353, port 4683, a file server only) started before the pause. This session cannot signal it and
`stop_leftover_processes` refused it ("still has a parent program" / "was not started by a Harness session"); stop it
with `kill 82037` from a normal shell or let it exit with its parent.

> Plan Queue parked work: `queue/2026-09-28-crash-turn-auto-con-6e570b` — 2 commit(s), reason: verifier-unreliable.
