# Provider hardening: installed-app live checks

Status: pending; all four checks remain unexecuted. Local implementation/canonical/replay verification and fresh reviewer13 whole-task PASS are complete; they do not replace these rebuilt/native/human/external checks.
Plan: [completed local implementation plan](2026-10-02-provider-hardening_plan_completed.md).

> If a check reproduces a defect, record a new LT-NNN in
> [the remediation register](livetest-remediation-register.md), with observed behavior,
> root cause, required behavior and acceptance. Create an active follow-up implementation
> plan linked from the register; the historical
> [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is closed and
> must not receive new content. Keep per-check evidence here.
> Read [the campaign runbook](livetest-campaign-runbook.md) before running these checks.

## Prerequisites and boundaries

Restart an app built from this checkout at a safe time; do not restart the running Harness or
kill existing user sessions to run these checks. Use disposable provider sessions/workspaces
with current authenticated accounts. Record the instance ID, CLI version and log time window.
Never capture source text, thinking, credentials or full tool output as evidence.

The Harness is a hard-denied Computer Use target. These installed-app UI checks require an
authorized operator; backend checks that run in the agent loop remain required and are not
deferred here. Native-provider behavior also requires the external model service. No account
prompt or installed-app interaction is claimed by the isolated API smoke or mocked model tests.

## 1. Installed-app completion and cap behavior

1. Start a disposable root orchestrated OpenCode session using the Xiaomi token-plan
   MiMo v2.6 Pro model, outside a managed loop and with orchestration unpaused.
2. Run a bounded ordinary task, then a task that genuinely reaches the configured output
   ceiling. Use normal task content; do not induce a refusal with harmful instructions.
3. Inspect the transcript notices and metadata-only completion logs.
4. Repeat startup with a smaller explicit global/project cap in a hardened instance.
   Confirm the private config probe uses the granted roots, retains the cap/context and
   either starts inside the existing sandbox or reports a safe startup failure, never
   an unsandboxed fallback. The agent execution route rejected the unchanged hardened
   policy and even an allow-default sandbox with sandbox_apply: Operation not permitted;
   the signal-only policy worked (root-r3-seatbelt-capability.json). Roots/failure handling
   are covered locally, but full hardened startup on the installed app is unverified.

Expected: ordinary completion sends no continuation; a native length/collapse ending is
classified max_output and uses at most two automatic prompts across the same user turn.
The budget metadata reports combinedOutputTokens=32000 (raised from 16384 on 2026-10-14, LT-706; or a smaller explicit existing cap)
and reasoningBudgetSupported=false. Logs contain stop/finish/tokens/classification/hash,
without thinking or task-source text. A paused or managed-loop repetition gets the notice
without a Harness prompt. This needs the rebuilt app plus an actual provider ending.

## 2. Long foreground delegation through the installed CLI

1. In a disposable OpenCode session, delegate a genuine foreground task whose child remains
   active beyond the ordinary 60-minute lease. Record the parent and correlated child IDs.
2. Observe the parent-silence notice and metadata-only child progress logs.
3. Allow the child to finish normally; in a separate disposable case stop child progress.

Expected: only correlated child message/part activity refreshes inactivity; the notice states
observed activity age and lease remaining. A static child row or server heartbeat does not
renew work. Missing activity expires at the ordinary lease; continuous progress never exceeds
the four-hour absolute ceiling. Execute tools and background tasks do not get a blind
four-hour lease. Real duration/provider work is external to the deterministic timer tests.

## 3. Source filtering with native model conversion

1. Re-run an already reproduced, legitimate file-processing workflow that triggered a source
   filter in a disposable OpenCode session. Do not invent a jailbreak-shaped instruction.
2. Inspect the safe notice and whether one automatic continuation starts after native
   read-result compaction. Record only tool call ID and the compacted timestamp.
3. Verify completed work remains available and the legitimate workflow resumes successfully.
   Record only safe notices and exact native tool-result compaction readback. Do not dump
   provider requests or source/account data.

Expected: the notice and recovery prompt contain no blocked text or canned filter sentence.
Instruction refusals or unsupported/failed sanitization remain stopped. Readback must prove
the exact current read result was compacted before any continuation. Installed API persistence and the actual native model-request conversion were checked locally
against a fake loopback provider, including positive baseline output/attachment presence and
negative presence after compaction. This pending check covers the rebuilt app and an externally
reproduced source filter, not the already verified conversion API.

## 4. Native Claude/Codex recovery ownership

1. In disposable Claude work, observe a real max-output or context-overflow boundary and
   its native escalation/compaction behavior. Do not infer installed behavior from sibling
   source alone. Record installed version and safe diagnostics.
2. In disposable Codex work with an active thread goal, observe a native next turn across
   compaction; press Stop and verify the goal no longer restarts work.
3. If a native retry occurs, verify a safe retry notice and continued activity without a
   competing Harness continuation.

Expected: native recovery remains the owner while it runs. A terminal context error does
not acquire another Harness compact/continue on providers that already exhausted native
recovery. Codex goal ownership prevents duplicate prompts; Stop pauses the native goal.
These require installed CLI/account behavior unavailable from local source inspection alone.

## Evidence

All four checks remain pending. Record dated evidence per item before closing this file.

## Status — 2026-10-04 (batch C: check 1 steps 1-3)

Check 1 steps 1-3: ordinary completion PASS; budget metadata PASS; metadata-only logs PASS; **genuine output-ceiling
classification FAIL** (reproduced, filed as [LT-690](livetest-remediation-register.md#lt-690)). Step 4 (hardened) BLOCKED
by the signal fence. Check 2 NOT RUN (long). Checks 3 and 4 are not part of batch C (check 4 is appended by another agent).
Whole file stays open. Evidence: [Evidence run — 2026-10-04 (batch C)](#evidence-run--2026-10-04-batch-c).

## Evidence run — 2026-10-04 (batch C)

Dev app (isolated profile `/tmp/aio-lt-1004-c`, port 9481, focus emulation on, working tree on HEAD `3d05e250e`),
OpenCode 1.18.34, installed `opencode acp`. Log window 22:30Z-22:46Z (23:30-23:46 BST) on 2026-10-04; log slices copied to
`_scratch/lt-2026-10-04/c/` (`log-c-slices.ndjson`, `log-acp-turn-completed-check2.ndjson`,
`log-acp-turn-completed-check3.ndjson`). Nothing below records task text, thinking or credentials.

### Check 1, step 1 — session setup: done

Root orchestrated sessions (`launchMode: "orchestrated"`, `parentId: null`), provider OpenCode, model
`xiaomi-token-plan-ams/mimo-v2.6-pro`, YOLO on, outside any loop: `iypujfrde` (ordinary tasks) and `iy3gral1r` (ceiling).
Orchestration pause state: the app only turned `isPaused: true` (`reasons: ["vpn"]`, automatic VPN detection on the host)
at 22:45:10Z, after every turn below had finished, so all turns ran unpaused.

### Check 1, step 2a — bounded ordinary task: PASS

`iypujfrde`, five ordinary turns (read and edit a file; a shell command; a recall question; "pong"; "ping"). Each
`ACP turn completed` log line: `adapter: "opencode-acp"`, `stopReason: "end_turn"`, `classifierReason: "completed"`,
`evidence: "provider_completed"`, small `outputTokens` (3-37) and `reasoningTokens`, and
`generationBudget: { model: "xiaomi-token-plan-ams/mimo-v2.6-pro", combinedOutputTokens: 16384,
reasoningBudgetSupported: false }`. No continuation was sent: the log shows only my own `sendInput` calls
(`autoContinuation: false`) and the transcript has no extra user row. Budget metadata therefore matches the doc's
then-expected `combinedOutputTokens=16384` and `reasoningBudgetSupported=false` (the cap is 32000 since 2026-10-14, LT-706).

### Check 1, step 2b — a genuine output-ceiling ending: FAIL (LT-690)

`iy3gral1r`. A first request for all integers 1 to 30000 in words was politely declined by the model (156 output
tokens, `completed`, correct). A second request, which said a length cut-off was expected and fine, ran until the cap:
the model emitted 16229 output + 155 reasoning tokens = 16384, the configured combined cap, and OpenCode's own record
shows `finish: "length"` (`opencode export`, `step-finish:length`). Harness logged (22:39:13Z, epoch ms 1791153553822):
`ACP turn completed ... stopReason: "end_turn", outputTokens: 16229, reasoningTokens: 155, classifierReason: "completed",
evidence: "provider_completed"`. So it was **not** classified `max_output`, no notice row appeared, and no automatic
continuation was sent; the visible answer ends mid-number. A raw ACP capture (`acp-wire-probe.out`) shows installed
OpenCode returns `stopReason: "end_turn"` with `_meta: {}` for a capped turn, so no native length signal reaches the
classifier. Root cause, required behaviour and acceptance are in LT-690 in the remediation register. The plan already
recorded the upstream length mapping as an unapplied proposal (`2026-10-02-provider-hardening_plan_completed.md` lines
49 and 172), so this is the known limitation reproduced end to end on the installed app rather than a new surprise, but
the check's expected behaviour ("classified `max_output`, at most two automatic prompts") is not met on the installed
stack. The reasoning-collapse path (the other `max_output` route) was not exercised: reasoning did not collapse here.

### Check 1, step 3 — transcript notices and metadata-only logs: PASS for what exists

- Logs: every `ACP turn completed` line carries only adapter, model, `stopReason`, token counts, `leaseMs`,
  `classifierReason`, `evidence` and the budget block. No `finish` field was present (none arrived), no
  `collapsedTailHash` (no collapse), no thinking, no task or source text. The `ProviderTurnEnding` lines repeat the same
  metadata. Checked by reading the copied slices.
- Transcript notices: none were produced for the ceiling turn (see 2b). The "paused or managed-loop repetition gets the
  notice without a Harness prompt" clause was NOT exercised.

### Check 1, step 4 — hardened instance with a smaller explicit cap: BLOCKED

Hardened spawns cannot run from this shell: the signal fence blocks Seatbelt, and the dev app's own startup banner
reports "Hardened mode (Seatbelt): sandbox-exec probe failed — hardened instances will refuse to spawn". Needs James to run
it from his own Terminal or UI. Not attempted.

### Check 2 — 60+ minute foreground delegation: NOT RUN

Skipped: it needs a delegated OpenCode child that keeps producing correlated message/part activity for over an hour, and
a second case where child progress stops, which is a long unattended provider run. Left for a dedicated run.

### Cleanup

Instances `iypujfrde`, `iy3gral1r` terminated (`listInstances` returned 0 afterwards). Scratch folder and profile removed
at the end of the batch; no settings left changed (`defaultModelByProvider` re-read as `{}`).

## Evidence run — 2026-10-04 (batch B, check 4 only)

Status — 2026-10-04 (check 4): **PARTIAL, still open.** Part 2 (Codex thread goal across compaction, Stop
pauses it) PASS. Part 1 (Claude native boundary): native context auto-compaction observed with no Harness
competition, but no max-output or terminal context-overflow boundary was reached. Part 3 (native retry)
NOT RUN. Checks 1 to 3 untouched. Times are UTC (machine is on BST, +1 h).

Environment: dev app on isolated profile `/tmp/aio-lt-1004-b`, working tree at HEAD `3d05e250e` plus
uncommitted work, Claude Code 2.1.289 (the plan text says 2.1.287), codex-cli 0.160.0. The dev app was
started with `--no-sandbox` and the heap flag directly because Chromium's sandbox could not initialise
inside the agent shell's Seatbelt fence; this is a test-app launch detail. Evidence:
`_scratch/lt-2026-10-04/b/`. Instances were disposable; all terminated.

### Part 1 — Claude native boundary: native context compaction observed; max-output / terminal overflow not reached

Instance `cgje2ctrr`, provider claude, model `haiku` (reported window 200,000; the `sonnet` alias reports
1,000,000, too costly to fill), `yolo` off, `contextEvidenceModeByProvider.claude` = `off` (James's
setting). Filled with 11 "reply OK" turns carrying filler text (no tools); an earlier `sonnet` instance (`c76b7jpm5`) was abandoned at 24% of its 1,000,000 window after 4 turns.

- Occupancy: 34% to 91.4% (23:08:26-23:08:52 UTC), 95.7% (191,407 tokens) at 23:09:06.7 UTC on the K20 turn.
  The next turn (K21, sent 23:09:06.8) took 14 s (23:09:06.822 to 23:09:21.056, one `busy` span) and
  afterwards the context read 43,786 tokens (21.9%): Claude Code compacted its own context inside the turn.
- Harness behaviour: only `[BUDGET_GATE] high context on user input — letting CLI handle` (twice, at 91%
  and 96%); no Harness compaction, no steer, no continuation, no `Context policy decision` lines (mode
  `off`), exactly one reply "OK" for K21, no extra turn (`lifecycle-cgje2ctrr.ndjson`,
  `cgje2ctrr-applog-full.txt`). So the native compaction owned the recovery and Harness added nothing.
- Not observed: a max-output ending or a terminal context-overflow error. Cost/limit judgement: the
  session reported `Provider rate limit "allowed_warning" (seven_day)` at 23:08:25, so I did not push
  Claude into a 32k-64k output run or an overflow loop. Native output escalation therefore remains
  unverified, and so does "a terminal context error does not acquire another Harness compact/continue".
- Side note: Harness shows no transcript marker or notice for Claude's silent native compaction (the
  context meter just drops 96% to 22%); not in this check's scope, not filed.

### Part 2 — Codex thread goal across compaction; Stop pauses it: PASS

Instance `xyynqndg6`, thread `01a10925-fa7b-7841-895f-8a6b6b142725`. Grown to 96.57% with filler turns
(`goalcompact-fill-log.txt`), then a prompt asking the model to call `create_goal` ("one 150-word animal
paragraph per turn, eight turns").

- Compaction: Codex compacted itself at the start of that first turn (`app.log` "Codex compaction started"
  23:02:55.536 `trigger: "self-managed"`, completed 23:03:03.660, 8,124 ms; rollout `compacted` inside turn
  `01a10927-f317-7b03-b9fd-f930006edfea`, no `turn_aborted`).
- Native next turn across compaction: goal-continuation turns `01a10928-8548`, `01a10928-cc70`,
  `01a10929-21e4`, `01a10929-6e70` then started by Codex itself (3 "Following a turn Codex started by
  itself" lines after the compaction, 23:03:32.9, 23:03:51.2, 23:04:13.0, 23:04:32.6). The instance's
  `app.log` slice shows no Harness-originated continuation or second compaction request, and the only
  `INSTANCE_SEND_INPUT` events are my own prompts.
- Stop: real Stop button at 23:04:37.8 during goal turn `01a10929-6e70`: transcript "Paused the Codex goal
  so it does not restart the work by itself. Send a message to continue.", goal store `paused`, rollout
  `turn_aborted interrupted` and no further `task_started` in the 60 s that followed. The same Stop
  behaviour with a longer 2 m 13 s wait is recorded on `xtbdycjw7` in the compaction-reliability doc check 3.
- Competing prompts: none seen. Duplicate-prompt prevention is only evidenced by the absence of
  Harness-originated sends in these runs.

### Part 3 — native retry notice: NOT RUN

No native retry occurred (no rate-limit rejection, no 5xx). Not reproducible on demand.

### Cleanup

Instances `cgje2ctrr`, `xyynqndg6` terminated; the dev app and its `/tmp/aio-lt-1004-b` profile are removed
at the end of the batch.
