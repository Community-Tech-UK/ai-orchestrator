# Interrupt-respawn reconciler migration — live test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-17-interrupt-respawn-reconciler-migration-plan_completed.md`](2026-07-17-interrupt-respawn-reconciler-migration-plan_completed.md)
**Prerequisites:** rebuilt + restarted app; one local Claude or Codex instance.

All agent-runnable verification passed 2026-07-17 (handler specs 31/31 including the real-core
fallback-ordering test, new `runtime-reconciler.recovery.spec.ts` 9/9, tsc ×2, lint, LOC, full
quiet suite). These are the spec item-2 mandated live checks that need a real CLI process.

## Checks

> **Rewritten in place 2026-08-12 — see the "Evidence run — 2026-08-12" entry at the bottom of this
> file for the full verification.** The original checks 1–4 (wording preserved
> inline as a quote under each item below) asserted an `interrupting → respawning → idle`
> progression on interrupt. That progression is what LT-008's fix removed for this doc's own stated
> prerequisite ("one local Claude or Codex instance"): both default to a resident session
> (`residentClaudeSession` is a read-only setting migrated to `true`; Codex attempts app-server mode
> first and only falls back to exec on failure or hardened mode), and a resident session's interrupt
> is acknowledged and settles back to `idle` in place — there is no respawn window left to test. The
> intent of each original check is unchanged and is what the rewritten form below tests.
>
> **Scope caveat, found while verifying this rewrite:** the respawn-on-interrupt mechanism the
> original checks describe is not dead everywhere. `GeminiCliAdapter` and `CursorCliAdapter`
> (`src/main/cli/adapters/gemini-cli-adapter.ts`, `cursor-cli-adapter.ts`) do not override
> `getAdapterCapabilities()`, so they stay on the SIGINT/no-resident default
> (`residentSession: false`, `base-cli-adapter.ts:516`), and Codex falls back to the same
> non-resident path when app-server init fails or hardened mode is on
> (`codex-app-server-adapter.ts:270-320`). Those providers/paths sit outside this doc's declared
> Claude/Codex prerequisite; this rewrite does not claim to cover them.

1. **Interrupt aborts in place.** Start a long generation on a resident session (default Claude or
   Codex app-server), press Escape once.
   - Expected: status goes `busy → interrupting → idle` (no `respawning` state); `adapterGeneration`
     and the provider session id are unchanged; transcript shows the system marker "Interrupted —
     waiting for input"; the conversation survives (a follow-up referencing earlier context gets an
     answer that shows native context was retained); no duplicate/zombie CLI process (`ps`).
   - **Result: ✅ PASS** — evidenced 2026-07-29 below.
   > *Original wording (targeted the pre-LT-008 respawn contract):* "Interrupt mid-turn. Start a
   > long generation, press Escape once. Expected: status → interrupting → respawning → idle;
   > transcript shows 'Interrupted — waiting for input'; the conversation survives (ask a follow-up
   > referencing earlier context — native resume should retain it); no duplicate/zombie CLI process
   > (`ps`)."

2. **A second interrupt during the (transient) `interrupting` window does something sane.** Fire a
   second interrupt immediately after the first, with no delay, while the instance is still (or
   just was) `interrupting`.
   - Expected: no error, no corrupted state, no duplicate adapter; the second call reports nothing
     to interrupt once the first has settled (`{interrupted: false}`); `adapterGeneration` and
     provider session id unchanged; status settles to `idle` and stays there.
   - **Result: ✅ PASS** — evidenced 2026-08-11 below.
   > *Original wording:* "Double-Escape force path. Interrupt, then press Escape again while still
   > respawning. Expected: immediate transition to cancelled; adapter gone; a fresh message spawns a
   > new working session; no 30s-later force-abort firing on the recovered session."

3. **Terminating immediately after an interrupt stays terminated.** Start a turn, interrupt it, then
   terminate the instance right after, with no delay.
   - Expected: the instance disappears from the instance list and stays gone — no resurrected
     adapter after a beat; the CLI process is confirmed gone (`ps`).
   - **Result: ✅ PASS** — evidenced 2026-08-11 below.
   > *Original wording:* "Interrupt during respawn (abort race). Interrupt mid-turn, and while the
   > respawn spinner shows, terminate the instance from the list. Expected: the instance stays
   > terminated — no resurrected adapter after a beat (the hardened abort checkpoints now live in
   > `applyRecoveryRespawn`); app log shows a 'recovery respawn cancellation' cleanup line."

4. **Resume-failure fallback, reached via unexpected-exit recovery rather than interrupt.**
   Relocated to
   [`2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md`](2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md)
   because the mechanism this check protects — a stale/rejected provider session id during a
   post-crash respawn, falling back to a fresh session with the continuity preamble queued for the
   next turn instead of replayed under the lock — is ~~`respawnAfterInterrupt`'s
   `fallbackReason: 'resume-failed-fallback'` branch
   (`src/main/instance/lifecycle/interrupt-respawn-handler.ts:857-910`)~~ **[correction, 2026-08-12
   evidence run below] actually `respawnAfterUnexpectedExit`'s `fallbackReason:
   'auto-respawn-fallback'` branch (`src/main/instance/lifecycle/interrupt-respawn-handler.ts:1011,
   1173-1198`)** — both share the identical `applyRecoveryRespawn` core in `runtime-reconciler.ts`,
   so the behavioral contract below is the same either way, but a literal unexpected process exit
   only ever reaches the latter — which on the current contract is reached by an **unexpected process
   exit**, not a user-initiated Escape, for a resident session.
   - Expected (same intent as the original): transcript shows "Session restarted automatically
     (resume failed)"; the replayed context preamble is queued for the next turn (no immediate
     replay turn under the lock); the fresh session id is recorded on the instance/queueUpdate; a
     follow-up message works.
   - **Result: ✅ PASS** — evidenced 2026-08-12 below. The companion doc's own "check 4" (crashloop
     backoff/suppression, filed as LT-023) is a different scenario and does not exercise this one; a
     prior evidence entry in *this* doc said check 4 was "covered there" and that was checked this
     session and found incorrect (corrected earlier in this file, not silently removed). This run
     drove the scenario directly instead, and also found the mechanism citation in the paragraph
     above names the wrong function — see the evidence entry for the correction.
   > *Original wording:* "Resume-failure fallback. Interrupt a session whose provider session id is
   > stale (e.g. delete the provider session file for a test instance first, or use a provider known
   > to reject resume after interrupt). Expected: transcript shows 'Interrupted — session restarted
   > (resume failed)'; the replayed context preamble is queued for the next turn (no immediate replay
   > turn under the lock); `lifecycle.ndjson` records the fresh session id; a follow-up message
   > works."

Rename this file `_livetest_completed.md` only when every check passes with evidence.

## 2026-07-18 Live-Test Evidence

Used a disposable Codex app-server session in the rebuilt development app. Interrupting a live
turn did not show the required `interrupting -> respawning -> idle` progression or the documented
“Interrupted — waiting for input” transcript marker. During a later forced process exit the UI
showed `Waiting for interrupt…` and `Recovering session...`, then removed the active session and
returned to the new-session draft instead of recovering it. The base checks fail; resume-failure
and crashloop variants were not run because repeated kills would add risk without satisfying the
prerequisite behavior. This file remains pending.

## 2026-07-19 Root Cause and Fix (LT-004 in `docs/plans/livetest-remediation-register.md`)

Root cause (verified by reading the executing code path, shared with the unexpected-exit
reconciler live test): `CodexAppServerAdapter`'s app-server exit callback
(`codex-app-server-adapter.ts`) reset `useAppServer`/`spawnMode` to their non-resident values
**before** emitting `'exit'`. `instance-communication.ts`'s exit handler classifies the exit
synchronously inside that same `'exit'` listener via `isStatelessExecAdapter()`, which reads
`getAdapterCapabilities().residentSession` / `getRuntimeCapabilities().supportsNativeCompaction` —
both derived live from `useAppServer`. Because that flag was already flipped, a genuine resident
app-server death (or an Escape interrupt racing the same exit path) read as a non-resident/exec
adapter and fell through to the stateless-exec ignore path, which sits before both the
interrupted-instance branch and the unexpected-exit auto-respawn branch — matching this file's
2026-07-18 observation exactly (no `interrupting -> respawning -> idle` progression; a forced
process exit removed the session instead of recovering it).

**Fix:** reordered `codex-app-server-adapter.ts`'s exit callback to emit `'exit'` before resetting
`useAppServer`/`spawnMode`, so any synchronous listener sees the adapter's true runtime mode at
the moment of the crash. `getPid()`/`isRunning()` are unaffected (they already read
`connectionPhase`, which the underlying thread runtime sets to `closed`/`failed` before this
callback fires). No change was needed in `instance-communication.ts`,
`interrupt-respawn-handler.ts`, or `runtime-reconciler.ts` — their classification/recovery logic
was already correctly capability-driven; only the timing of the state mutation relative to the
`'exit'` emit was wrong.

**Regression coverage:** 8 new tests across `codex-app-server-adapter.ts`'s consumers —
`instance-communication-adapter-helpers.spec.ts` (capability-driven, not name-driven,
classification), `codex-cli-adapter.app-server.spec.ts` (adapter still reports resident/
native-compaction=true during its own `'exit'` listeners, flips to false after), and
`instance-communication.spec.ts` (integration-level: app-server exit while busy/idle routes
through `onUnexpectedExit`; an in-flight interrupt (`markInterrupted`) routes through
`onInterruptedExit` instead, proving the interrupt path and the generic exit path no longer race).
All 8 confirmed to fail on the pre-fix code and pass after. Existing double-Escape,
termination-during-respawn, resume-fallback, and crashloop-backoff suites (60 tests across
`interrupt-respawn-handler.spec.ts`, `runtime-reconciler.recovery.spec.ts`,
`respawn-circuit-breaker.spec.ts`) re-run unchanged and still pass. Full `cli/adapters` +
`instance` suites (1888 tests), `tsc` (main + spec config), and `ng lint` all green.

**Still pending — this file remains NOT renamed `_livetest_completed.md`:** a live re-run of
checks 1–4 in a disposable Codex app-server session (rebuilt/restarted app) has not been performed
since the fix landed.

---

## 2026-07-26 — checks 1–4 still NOT RUN, but the shared root-cause symptom is disproven live

Checks 1–4 all begin with an **Escape press** or a **terminate-from-the-list** click. The packaged
app exposes no remote-debugging port and neither the orchestrator MCP tools nor the `aio-mcp` CLI
can interrupt or terminate a local instance, so none of the four could be driven this session. They
remain open.

What *was* established, on the companion live test
([`2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md`](2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md),
2026-07-26 entry), is the **half of the 2026-07-18 evidence that this file shares**: that a forced
process exit on a resident Codex app-server session "removed the active session and returned to the
new-session draft instead of recovering it".

Against the current packaged build, four `kill -9`s on a disposable Codex app-server instance
(`x4wkx8ae9`) each produced `Adapter exit event → Auto-respawning after unexpected exit →
Recovery respawn complete` in ~330 ms with the session **preserved**, and
`Ignoring per-turn process exit for stateless exec adapter` — the log signature of the
mis-classification described in the 2026-07-19 root cause above — appears **0 times** in the whole
log. So the reordered `'exit'` emit is doing its job on the exit path in production.

That does **not** pass any check here: the interrupt path (`markInterrupted` → `onInterruptedExit`)
is a different branch from the unexpected-exit path, and the `interrupting → respawning → idle`
progression, the "Interrupted — waiting for input" marker, the double-Escape force path, the
abort race, and the resume-failure fallback are all still unobserved live. It narrows the risk, and
it means a future runner should not expect the 2026-07-18 session-drop to reproduce.

## Evidence run — 2026-07-29 — **all four checks target pre-LT-008 behaviour and can no longer occur**

Driven in the dev app against a real Claude `sonnet` instance (`cbzjzn2q3`, `/tmp/aio-lt-intr`).

**The finding: interrupting no longer respawns anything.** Every one of these four checks is written
around a respawn window that the LT-008 fix removed. Measured status path across a real interrupt:

```
busy → interrupting → idle
```

There is no `respawning` state, `adapterGeneration` stays **1**, and the provider session id is
unchanged (`1f313fa5-0826-4bbb-9170-8e2776f59050` before and after). The turn is aborted in place on
the live session.

| Check | Why it cannot run as written |
| --- | --- |
| 1 | expects `interrupting → **respawning** → idle`; the middle state never occurs |
| 2 | "press Escape again **while still respawning**" — there is no respawning window |
| 3 | "terminate **while the respawn spinner shows**" — same, no window to race |
| 4 | "interrupt a session whose provider session id is stale" — no resume is attempted, so nothing can fail |

Check 4 was staged properly before concluding this: the instance's provider session file
(`~/.claude/projects/-private-tmp-aio-lt-intr/1f313fa5-….jsonl`) was **moved aside**, then a long
turn was started and interrupted. Result: `adapterGeneration` still 1, session id still unchanged,
and no `session restarted (resume failed)` marker anywhere — because no resume was ever attempted.
The file was restored immediately afterwards.

### What passes on substance

Check 1's real content — the part that matters to a user — **passes**:

- `interruptInstance` returned `{interrupted: true}` from a genuinely `busy` turn (status sampled at
  1.5 s).
- The transcript shows the documented marker verbatim: `system  Interrupted — waiting for input`.
- **The conversation survives.** A follow-up recalled `COBALT-91`, the marker given before the
  interrupt.
- **No duplicate or zombie CLI process**: zero `claude` processes are parented to the dev app's main
  process after the interrupt.
- A second interrupt cycle behaved identically, and a follow-up turn replied `POST-FALLBACK-OK`.

### What this doc needs

A rewrite, not more testing. The behaviour these checks were protecting against — a respawn on every
interrupt, with its resume-failure and abort-race hazards — was deliberately eliminated by LT-008.
The checks should be re-expressed against the current contract:

1. interrupt aborts in place: `interrupting → idle`, generation and session id unchanged, marker
   present, context survives (**already verified above**);
2. a second interrupt during `interrupting` (the only remaining window) does something sane;
3. terminating during `interrupting` stays terminated;
4. the resume-failure path still exists but is reached via **recovery** (an unexpected exit), not via
   interrupt — so check 4 belongs in
   `2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md`, not here.

Until that decision is made this file cannot be renamed `_livetest_completed.md`, even though
nothing is broken.

## Evidence run — 2026-08-11 — re-expressed checks 2 and 3 both PASS

Dev app, own isolated profile (`AIO_DEV_USER_DATA_PATH`, `--remote-debugging-port=9453`), rebuilt
main. Claude instance `czoj90t3v` (`sonnet`, yoloMode on) in `/tmp/aio-lt-batchC-ir`. Driven against
the **re-expressed** contract from the section above (2 and 3), since the checks as originally
written target pre-LT-008 behaviour that no longer occurs (confirmed again this session).

### Re-expressed check 2 — a second interrupt during the (very short) `interrupting` window — ✅ PASS

Started a long turn (a ~2500-word essay prompt), confirmed `busy`, then fired two
`interruptInstance` calls back to back in the same script with no delay between them.

| | Observed |
| --- | --- |
| 1st interrupt | `{interrupted: true}`; status already `idle` by the time the call returned |
| 2nd interrupt (fired immediately after) | `{interrupted: false}` — a clean, explicit no-op |
| status after | `idle`, unchanged over 6 further samples across 3 s |
| `adapterGeneration` | unchanged (1) |
| `providerSessionId` | unchanged |

The `interrupting` state is transient enough (sub-request-roundtrip) that a literal "press Escape
while still interrupting" could not be caught mid-flight even with two calls issued with zero
JS-level delay — which is itself evidence there is no meaningful window left to race, consistent with
the doc's own 2026-07-29 finding. What matters for "does something sane": the second call did not
error, did not corrupt state, did not spawn a duplicate adapter, and correctly reported nothing to
interrupt. No zombie process, no generation bump, no session-id change.

### Re-expressed check 3 — terminate immediately after interrupt stays terminated — ✅ PASS

Started a second long turn, confirmed `busy`, called `interruptInstance` then `terminateInstance`
immediately after (same script, no delay). The instance disappeared from `listInstances` right after
the terminate call and **stayed gone** across 8 further samples over 5.6 s. The CLI process (pid
`41182`) was independently confirmed gone (`ps -p 41182` → no such process). No resurrection, no
zombie adapter.

### Status

Both re-expressed checks now have live evidence. Combined with the 2026-07-29 evidence for
re-expressed check 1 (interrupt aborts in place; context and session id survive), **the first three
re-expressed checks all pass.** Re-expressed check 4 (resume-failure fallback reached via recovery,
not interrupt) was already relocated to the unexpected-exit companion doc by the 2026-07-29 note and
is covered there (that doc's own check 4/LT-023 status).

**This file is not renamed.** It still describes the *original* four checks, which do not match the
current contract (LT-008 removed the respawn window they test for) — renaming it `_livetest_completed`
would certify checks that cannot occur as written, which the campaign's evidence standard forbids
even though the underlying behaviour is fully verified and healthy. The decision the 2026-07-29 note
asked for (rewrite the checks themselves, in place, to the re-expressed form now evidenced above) is
still James's call, not something this session took unilaterally — flagged in the final report.

## Evidence run — 2026-08-12 — checks rewritten in place; premise re-verified; check 4 gap corrected

James delegated the rewrite-in-place decision (recommended by the orchestrating session) and this
run acted on it, but verified the premise first rather than taking it on trust, per instructions.

### Premise verification (read, not re-run)

Confirmed by reading the executing code, not by re-trusting the 2026-07-29/08-11 evidence alone:

- `src/main/instance/lifecycle/interrupt-respawn-handler.ts` — `noteInterruptSettled()` (settles a
  resident adapter's interrupt to `idle` in place, no exit, no respawn) and
  `handleInterruptCompletion()` (transitions `interrupting → cancelling → idle` directly for a
  completion-proof adapter) are the only two paths a resident interrupt can take. Neither ever
  transitions through `respawning`. `respawnAfterInterrupt()` (line ~751 onward) exists and can
  still reach `respawning`, but it is only invoked from the exit-handler's interrupted-exit branch —
  i.e. only after a real process exit, which a resident adapter's interrupt does not produce.
- `src/main/cli/adapters/claude-cli-adapter.ts:283-294` — `getAdapterCapabilities()` returns
  `{residentSession, liveInterrupt, liveSteer}` all `true` whenever
  `this.spawnOptions.residentClaude === true` and the pipe is open.
- `src/main/instance/instance-lifecycle.ts:1475` — `instance.residentClaude = settingsAll.residentClaudeSession ?? true`.
- `src/main/core/config/settings-migrations.ts:169-175` — a one-shot migration force-sets
  `residentClaudeSession` to `true` for every existing install ("Claude steering should abort the
  turn through the resident stream protocol, not SIGINT + respawn. The setting is read-only, so old
  persisted `false` values are stale rollout state rather than user intent").
- `src/main/core/config/settings-control-policy.ts:267` — `residentClaudeSession: readOnly()`, so no
  agent or settings write path can turn this off; it is architecturally the default, not a
  configuration choice that could quietly change.
- `src/main/cli/adapters/codex-app-server-adapter.ts:270-320` — `spawn()` always attempts app-server
  mode first when available and not hardened; `useAppServer` (which drives
  `getAdapterCapabilities().residentSession`, line 586) only goes `false` on init failure, hardened
  mode, or after `terminate()`.

**Premise confirmed for this doc's declared scope** ("one local Claude or Codex instance"): the
original checks' `interrupting → respawning → idle` progression genuinely cannot occur under default
settings for either provider, and the re-expressed checks 1–3 test exactly the behaviour the
originals intended (abort-in-place correctness, race safety on a second interrupt, and termination
safety), just against the contract that actually exists now.

**One caveat this verification surfaced that the 2026-07-29/08-11 runs did not state:** the
respawn-on-interrupt mechanism is not eliminated app-wide. `src/main/cli/adapters/gemini-cli-adapter.ts`
and `cursor-cli-adapter.ts` extend `BaseCliAdapter` directly and never override
`getAdapterCapabilities()`, so they keep the `base-cli-adapter.ts:516` default
(`residentSession: false, liveInterrupt: false, liveSteer: false`) — a SIGINT-based interrupt that
still exits the process and still runs through `respawnAfterInterrupt()`. Codex forced into exec
mode (hardened, or app-server init failure) is in the same position. None of that is in scope for
*this* doc (whose prerequisite names only Claude/Codex), so it does not block the rewrite, but it
means "can no longer occur" is only true for this doc's declared scope, not as a blanket statement
about the app.

### Per-check re-verification against the rewritten wording

- **Check 1** (interrupt aborts in place): the 2026-07-29 evidence entry above measures exactly the
  rewritten assertions — `busy → interrupting → idle` with no `respawning` state,
  `adapterGeneration` unchanged (1), provider session id unchanged, the literal "Interrupted —
  waiting for input" marker, a follow-up recalling prior context (`COBALT-91`), and zero zombie
  `claude` processes. **Evidence matches the rewritten check.** ✅
- **Check 2** (second interrupt during `interrupting`): the 2026-08-11 entry drove two back-to-back
  `interruptInstance` calls with zero delay, got `{interrupted: true}` then `{interrupted: false}`,
  and confirmed `idle` held steady, generation and session id unchanged, over 3 s / 6 samples.
  **Evidence matches.** ✅
- **Check 3** (terminate right after interrupt stays terminated): the 2026-08-11 entry interrupted
  then immediately terminated, confirmed the instance gone from `listInstances` and the CLI pid
  (`41182`) independently confirmed dead via `ps -p`, sustained across 8 samples / 5.6 s.
  **Evidence matches.** ✅
- **Check 4** (resume-failure fallback via unexpected-exit recovery): **no live evidence exists
  anywhere for this specific scenario.** Searched every `*_livetest*.md` doc for
  `resume-failed-fallback` / `Session restarted automatically (resume failed)` / `actuallyResumed`.
  The companion unexpected-exit doc's checks 1 and 3 show respawns where `resumed: true` (native
  resume *succeeded*) — the opposite branch from the one this check needs. Its own check 4 is
  crashloop backoff/suppression (LT-023: the instance stays in `error` with no `waitReason` and no
  further attempt), a materially different bug about *whether* a respawn is retried, not about a
  stale session id making a respawn's resume fail. The one-line pointer this doc's 2026-07-29 note
  left in the companion doc (its own line: "the interrupt-respawn doc's check 4 … logically belongs
  here now") is a relocation note, not a check or evidence. **The 2026-08-11 evidence entry's claim
  that this "is covered there (that doc's own check 4/LT-023 status)" was wrong — corrected here,
  not silently deleted.** This is not a reproduced defect (nothing is broken; the
  `resume-failed-fallback` code path exists, is exercised by
  `runtime-reconciler.recovery.spec.ts`'s unit coverage per this doc's own 2026-07-17 preamble, and
  is plausible on its face) — it is simply an unrun live check, which the campaign runbook's own rule
  6 says is not automatically a defect. **NOT RUN, residual.**

### Decision

Checks 1–3 pass with evidence that genuinely matches their rewritten wording. Check 4 does not have
any live evidence, anywhere, for the scenario it now names (stale-session-id resume failure surfacing
during an unexpected-exit respawn). **This file is still not renamed `_livetest_completed.md`.** The
residual is check 4 only: it needs a live run against a resident Claude or Codex instance whose
provider session id is made stale (delete/move the session transcript file) immediately before an
unexpected process exit (not an interrupt), confirming the "Session restarted automatically (resume
failed)" marker, a fresh session id, and a queued (not immediately replayed) continuity preamble. That
run belongs in the companion unexpected-exit doc, which this doc continues to point at, but it has not
happened there yet and should not be assumed done.

## Evidence run — 2026-08-12 (second entry) — check 4 driven live; PASS; mechanism citation corrected

Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-ir4`, `--remote-debugging-port=9464`,
renderer reused on `:4567`), dist already fresh from a concurrent session's build. Disposable Codex
instance `xp3h542tp` (`gpt-5.5`, yoloMode on) in `/tmp/aio-lt-ir4-ws`, app-server mode confirmed
directly from `ps` (`codex app-server`, pid `13979`, `ppid` = this dev app's Electron main `10310`).

**Staging.** One real turn first (marker `MARKER-KESTREL`, answered correctly), establishing
`sessionId = providerSessionId = 019ff33d-09c3-7921-922a-7a34917c3233` and
`providerSessionPersisted: true`. Located its rollout file directly —
`~/.ai-orchestrator/codex/sessions/2026/08/12/rollout-2026-08-12T00-51-31-019ff33d-09c3-7921-922a-7a34917c3233.jsonl`
— copied it to `_scratch/lt-2026-08-11/ir4/rollout-backup.jsonl`, then moved the live file aside
(`.MOVED-BY-LT070` suffix) so native resume has nothing to resolve.

**Kill.** pid `13979` gated per the runbook: absent from a pre-campaign `ps` snapshot, `ppid ==
10310` (this dev app's own Electron main, confirmed via `ps -o pid,ppid,command`), command line
`codex app-server`. `kill -9 13979`.

**Result — every item in the check's own Expected list confirmed:**

| Expected (from the check above) | Observed |
| --- | --- |
| transcript shows "Session restarted automatically (resume failed)" | exact string present, `metadata: {autoRespawn: true}` |
| replayed context preamble queued for next turn, no immediate replay under the lock | status went `respawning → idle` (not `busy`) after the fallback; no autonomous assistant turn appeared; the queued preamble was only consumed once a real follow-up was sent |
| fresh session id recorded on the instance/queueUpdate | `sessionId` changed from `019ff33d-09c3-…` to a fallback id `a6228a85-da4f-45c8-87cf-1912837faaff`, then to the real Codex-issued id of the new thread, `019ff33f-46b2-70a1-aae9-35db456aace4`, once the follow-up turn ran — both distinct from the original |
| a follow-up message works | asked "what marker word did I ask for earlier"; answered `MARKER-KESTREL` correctly, proving the queued continuity preamble actually delivered prior context into the brand-new provider session (native memory could not have supplied this — the session was fresh) |

`lifecycle.ndjson` for the run (full file, unedited):

```
adapterGeneration 1: initializing → idle → ready → busy → idle   (the MARKER-KESTREL turn)
adapterGeneration 1 → respawning                                  (kill detected)
adapterGeneration 2 → idle                                        (failed resume attempt torn down)
adapterGeneration 3 → ready → busy → idle  {"recoveryMethod":"replay"}   (fallback session's follow-up turn)
```

`restartCount` went `0 → 1` (one respawn cycle, no loop). `providerSessionPersisted` went
`true → false` (fresh session, unproven) `→ true` (proven once its first turn completed).
`sessionResumeBlacklisted` stayed `false` throughout. No duplicate/zombie process: the only live
`codex app-server` process for this instance after recovery (pid `20384`) is a direct child of the
same dev app main process; the killed pid and the transient failed-resume pid (`20199`) are both
gone.

**Mechanism citation correction.** The check's own mechanism paragraph (above) names
`respawnAfterInterrupt`'s `fallbackReason: 'resume-failed-fallback'` branch
(`interrupt-respawn-handler.ts:857-910`) as what an unexpected exit reaches. That is not what fired
here. Two independent signals confirm the function actually invoked was
**`respawnAfterUnexpectedExit`** (`interrupt-respawn-handler.ts:1011` onward, `fallbackReason:
'auto-respawn-fallback'` at line 1182): (1) `restartCount` incremented, which only
`instance-communication.ts`'s `onUnexpectedExit` branch does (`instance.restartCount++` at
`instance-communication.ts:2317`) — `onInterruptedExit` never touches it; (2) the transcript message
was the exact non-interrupt wording, "Session restarted automatically (resume failed)"
(`interrupt-respawn-handler.ts:1219`), not the interrupt-triggered variant "Interrupted — session
restarted (resume failed)" (`interrupt-respawn-handler.ts:909`), which requires
`instance.interruptRequestId` to be set — it never was here, since `interrupt()` was never called.

Tracing why: `respawnAfterInterrupt`'s literal `resume-failed-fallback` branch is only reached via
`onInterruptedExit`, which itself only fires when `interruptedInstances.has(instanceId)` is true at
exit time — i.e. `markInterrupted()` ran, meaning an `interrupt()` call is in flight. That is
excluded by design from "an unexpected exit, not an interrupt." The only other caller of
`respawnAfterInterrupt` is the stuck-process watchdog (`instance-manager.ts:588`,
`stuckDetector.on('process:stuck', …)`), which is a polled-staleness trigger, not a process-exit
event — a materially different scenario not exercised by this run. So for a literal "kill the CLI
of a resident session with a stale provider session id," `respawnAfterUnexpectedExit` is the function
that actually fires, not `respawnAfterInterrupt`.

This is a **documentation citation error, not a product defect.** Both functions funnel through the
identical `applyRecoveryRespawn` core in `runtime-reconciler.ts:554-704` (spawn → resume-health
verdict → fresh-fallback teardown/respawn → `writeThroughIdentityLocked` → continuity delivery via
the same `queueContinuityPreamble` hook); `fallbackReason` only feeds the internal degradation-notice
text embedded in the continuity preamble (`restart-policy-helpers.ts:137-167`), not the user-visible
transcript marker or any other check-relevant behavior. The check's own **Expected** bullet list
(reproduced in the table above) is what actually defines a pass, and every item in it holds exactly
as written against the mechanism that genuinely fires for this scenario. The mechanism paragraph
above should read `respawnAfterInterrupt` → `respawnAfterUnexpectedExit` and
`interrupt-respawn-handler.ts:857-910` → `interrupt-respawn-handler.ts:1011-1260`, and "which on the
current contract is reached by an unexpected process exit" holds true only for the corrected
function name.

**Cleanup.** The moved rollout file was restored to its original path and verified byte-identical to
the pre-move backup (`diff` clean). Instance `xp3h542tp` terminated (`ps -p` confirms its CLI process
gone). Dev app stopped. `/tmp/aio-lt-ir4` and `/tmp/aio-lt-ir4-ws` removed.

### Final status

All four checks now have live, current evidence that matches their rewritten wording: checks 1–3
(2026-07-29/2026-08-11 entries) and check 4 (this entry). **File renamed
`2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest_completed.md`.**
