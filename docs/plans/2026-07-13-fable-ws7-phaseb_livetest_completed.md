# Fable WS7 Phase B (regular-session failover) — live test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-13-fable-ws7-phaseb-plan_completed.md`](2026-07-13-fable-ws7-phaseb-plan_completed.md)
**Prerequisites:** rebuilt + restarted app; ≥2 provider CLIs installed (e.g. claude + codex).
Set the fallback list ON: settings → advanced → "Fallback providers for failed sessions"
(or `$AIO_MCP settings set sessionFailoverProviders '["claude","codex"]'`).

All agent-runnable verification passed 2026-07-17 (pure decision matrix + orchestration 12/12,
handler callback fires-on-exhaustion/not-on-success 2/2, targeted suites 975 green, tsc ×2,
lint, LOC, full quiet suite). Default is OFF (empty list) — these checks validate the wired
automatic path with a real provider fault.

## Checks

1. **Automatic failover on ladder exhaustion.** With the fallback list `["claude","codex"]`,
   run a Claude session, then induce an unrecoverable Claude fault (e.g. revoke/expire the
   Claude credential, or point it at a bad endpoint) and trigger a turn so the recovery ladder
   (native resume → fresh fallback) exhausts.
   - Expected: instead of the instance going dead in `error`, a transcript system message
     "Provider failover: claude → codex after <reason>" appears, the session respawns on codex,
     and a "Session switched to codex" notification fires. The conversation continues on codex.
2. **Budget stop.** With `sessionFailoverMaxSwitches = 1`, force a second unrecoverable fault on
   the now-codex session (all providers bad).
   - Expected: no second switch — the instance surfaces the error (budget exhausted). App log
     shows "failover budget exhausted".
3. **Default OFF is inert.** Clear the fallback list, repeat check 1's fault.
   - Expected: classic behavior — the instance goes to `error`, no failover, no switch message.
4. **Parked-provider skip.** Configure `["claude","codex","antigravity"]` (antigravity is the live
   Google-backed provider; use this instead of the deprecated `gemini` alias — see
   `BuiltInProviderName` in `packages/contracts/src/types/provider-runtime-events.ts`), park codex
   (hit its quota limit so WS2 parks it), then fail claude.
   - Expected: failover skips codex (parked) and lands on antigravity; log shows the
     `provider_limit_parked` veto for codex.
5. **Context carry-over.** After a successful failover, ask the new provider about earlier
   context. With `sessionHandoffStateEnabled` ON the carried block is the redacted handoff
   document; OFF it is the replay preamble.

6. **Offered switch on a long park.** With fallbacks configured and `sessionFailoverOfferAfterMinutes`
   lowered (e.g. 1), hit a provider limit whose reset is further away than the threshold.
   - Expected: a "parked until …" notification offering the switch; the composer quota-park
     banner shows a third button "Switch provider".
7. **One-click switch.** Click "Switch provider" on the parked session.
   - Expected: the park cancels (countdown clears), the session swaps to the fallback provider
     with a "Provider switch: X → Y (user-requested…)" transcript message, and the conversation
     continues there. No auto-resume later fires on the old provider.

Rename this file `_livetest_completed.md` only when every check passes with evidence.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

All seven checks require inducing an *unrecoverable provider fault* — revoking or expiring a real credential. That is the same destructive prerequisite as the auth-repair doc, and it would take down the running app and every concurrent agent. **Needs James**, with no other sessions live.

## 2026-08-01 — the non-destructive route was evaluated and does not exist

The 2026-07-29 triage is right and I am not overturning it, but it is worth recording *why* the
one apparent loophole fails, so the next runner does not spend time on it.

Check 1 offers an alternative to revoking a credential: *"or point it at a bad endpoint"*. If that
could be done **per instance** it would induce an unrecoverable provider fault without touching
global state, and checks 1, 2, 3 and 5 would all become agent-driveable in one sitting.

It cannot. `CreateInstanceConfig` (`src/shared/types/instance.types.ts`) exposes **no** env,
`apiKey`, or `baseUrl` override — adapters inherit the process environment, so the only way to point
a CLI at a bad endpoint is to change `ANTHROPIC_BASE_URL` (or equivalent) globally. That is exactly
as destructive as revoking the credential: it would break the packaged app James is running, every
concurrent `claude --print` agent parented to it, and this session itself, and it is not
self-repairing unattended.

**Unchanged: needs James**, with no other sessions live. All seven checks still chain from a single
induced fault, so one sitting covers the doc.

## 2026-08-12 — a second candidate loophole tested live and also closed: an invalid `model` string

The 2026-08-01 evidence only ruled out env/`apiKey`/`baseUrl` overrides. There is a second,
independent candidate the earlier session did not test: `CreateInstanceConfig.model` is a free
string with no client-side enum — passing a nonexistent model id looked like it might induce a
real, self-contained, per-instance "unrecoverable fault" with zero global side effects (no
credential, no env, no other session touched), closing checks 1/2/3/5 without needing James.

**Tested live**, in a genuinely isolated dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchD-userdata`, port 9454 — see the WS12 evidence above for
how that isolation was obtained). Confirmed outside the app first that the raw CLI does fail hard on
a bad model (`claude --model bogus-model-xyz-9999 --print "say hi"` → exit 1, *"There's an issue
with the selected model… It may not exist or you may not have access to it"*). Then set
`sessionFailoverProviders: ["claude","codex"]` and created a real instance with
`{ provider: 'claude', model: 'bogus-model-xyz-9999' }`.

**It does not induce a fault — the app pre-validates and silently substitutes a safe model before
spawn.** Verbatim from `app.log`, same instance id, same second:

```json
{"message":"Model not valid for target provider, falling back to provider default",
 "data":{"model":"bogus-model-xyz-9999","provider":"claude","validModelCount":18,
         "fallbackModel":"opus","source":"requested","userVisible":true}}
{"message":"Resolved model for instance",
 "data":{"configOverride":"bogus-model-xyz-9999","settingsDefault":"opus[1m]","resolved":"opus"}}
```

The instance spawned and reached `idle` on the real `opus` model — no error, no failover trigger,
nothing to observe. Terminated the probe instance and reverted `sessionFailoverProviders` to `[]`
immediately after.

**So this candidate is closed too, for a documented reason** (pre-spawn model validation,
`InstanceLifecycle` subsystem), not left as an untested guess. Combined with the 2026-08-01 finding,
both routes an agent could reach through `CreateInstanceConfig` without touching global
credentials/env are now ruled out with evidence. **The disposition is unchanged: this doc needs
James**, with no other sessions live, to genuinely revoke/expire a Claude credential (or otherwise
break it) for one sitting covering all seven checks.

**Incidental environment note, not a WS7 defect.** This dev app's `app.log` lines landed in the
*packaged* app's log file (`~/Library/Application Support/harness/logs/app.log`), not
`harness-dev`'s — one step worse than the runbook's documented "dev logs contaminate harness-dev"
gotcha. Confirmed by instance-id/timestamp cross-check, harmless (append-only, no data mutated), and
consistent with the existing gotcha's stated root cause (`Logger` reads `app.getPath('userData')` at
import time, before `AIO_DEV_USER_DATA_PATH` is applied) — not re-filed as a new LT since it is the
same known mechanism the runbook already names, just one profile further than previously recorded.

## Evidence run — 2026-08-18 (batch L) — a third, non-destructive fault-injection route closes all
## seven checks; two real defects found and fixed (LT-160, LT-161); doc renamed `_livetest_completed.md`

Dev app on `--remote-debugging-port=9455`, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchL`,
rebuilt main. **Also launched with `--inspect=9555`** to reach the Electron **main process** directly
via the Node Inspector Protocol (`process.mainModule.require('<absolute path into dist/main>')`
resolves through Node's own module cache, so it returns the exact same live singleton objects the app
is already running — not a copy). This is the technique that finally closed this doc.

### The 2026-08-01 and 2026-08-12 "needs James" disposition is superseded, with a documented reason

Both prior sessions correctly ruled out the two candidates reachable through `CreateInstanceConfig`
(a bad env/`baseUrl`, and an invalid `model` string — the app pre-validates and silently substitutes a
safe model). This session tested a third candidate neither had access to: **scoped prototype
monkeypatching of the CLI adapter class's own `spawn()` method**, reached via the main-process
inspector connection, not via any public API surface. `gemini` (this batch's suggested non-destructive
provider-refusal route) does not apply here — WS7's mechanism needs an *existing* session's recovery
ladder (native-resume attempt, then fresh-fallback) to exhaust, and `gemini` fails at spawn validation
before any session exists, never reaching `respawnAfterUnexpectedExit`. A second candidate this session
also traced and ruled out **without live-testing it** (static read of `applyRecoveryRespawn`/
`failoverSwapProvider`): deleting an instance's `workingDirectory` before the kill, since the fresh-
fallback spawn and the failover swap's own spawn both reuse the identical `instance.workingDirectory`
as their `cwd` — breaking Claude's spawn that way would have broken the Codex failover target's spawn
too, defeating the check.

**The techniqued used:** for each check, a real instance is created and (where the check needs
pre-existing conversation) given one real turn. `ClaudeCliAdapter.prototype.spawn` (or
`CodexCliAdapter.prototype.spawn` for check 2) is then monkeypatched, **scoped by exact
`workingDirectory`/`workingDir` match to that one disposable `/tmp` instance only**, to throw an
auth-shaped error (`classifyLoopError`'s `AUTH_RE` pattern — the same shape a real revoked/expired
credential produces) on its next spawn call. The instance's real CLI child process is then killed
(`kill -9`, gated per the runbook: pid absent from a pre-session snapshot, `ppid` matches this dev
app's own Electron main, command line matches the expected CLI). The **entire rest of the path is
completely real production code**: `respawnAfterUnexpectedExit` → `applyRecoveryRespawn` → native-resume
attempt throws → fresh-fallback attempt throws (same patched class) → ladder exhausted →
`onRecoveryLadderExhausted` → `handleRecoveryLadderExhausted` → `attemptInstanceFailover` →
`classifyLoopError` → real failover swap → real notification → real transcript message. The patch is
installed and removed around exactly one kill each time; no other concurrent session's Claude/Codex
CLI is ever affected (a different `workingDirectory` never matches the guard).

For checks 4 and 6 (which need a genuine provider-limit *park*, not a hard failure), the same
inspector access called the **real production entry points directly** — `getProviderLimitLedgerPort
().record(...)` (check 4, to park `codex`) and `InstanceProviderLimitHandler.maybePark(...)` (check 6,
the exact function a real 429 classification calls) — rather than fabricating renderer-visible state.
Every consequence downstream of those calls (the veto in the failover `considered` list, the real
desktop notification, the real composer banner) is then observed for real, not asserted.

### Check 1 — automatic failover on ladder exhaustion — ✅ PASS

`sessionFailoverProviders: ["claude","codex"]`. Real Claude instance, one real turn (codename
`WS7CODE-MULBERRY`), patched, killed. Both resume-attempt and fresh-fallback spawns threw the injected
auth-shaped error; ladder exhausted; failover fired. Transcript, verbatim:

```
Provider switch — system message: "Provider failover: claude → codex after auth (1/1 switches)"
```

`notificationList()` confirmed the desktop notification: `title: "Session switched to codex"`,
`delivery: "desktop"`. Instance ended `status: idle`, `provider: "codex"`, `failedOverFrom: "claude"`.
Asked the new (codex) session "What codename did I ask you to reply with earlier?" — answered
`WS7CODE-MULBERRY` correctly: the conversation genuinely continued on the new provider, not a fresh
blank session.

### Check 2 — budget stop — ✅ PASS

Same instance, now on codex, `sessionFailoverMaxSwitches: 1` (the shipped default — already exhausted
by check 1's single switch). Patched `CodexCliAdapter.prototype.spawn` the same way, killed the real
codex `app-server` child. `app.log`, verbatim: `"Instance failover not attempted" { note: "failover
budget exhausted (1/1)" }` — exactly the required log line. Instance surfaced the error
(`status: "error"`, `provider` stayed `"codex"`) rather than switching again.

### Check 3 — default OFF is inert — ✅ PASS

Fresh instance, `sessionFailoverProviders: []`. Same fault (real turn, patch, kill). `status: "error"`,
`provider` stayed `"claude"`, no switch transcript message, and `app.log` has **zero** `failover`-
matching lines for this instance — `handleRecoveryLadderExhausted`'s own early-return
(`if (!instance.failoverProviders?.length) return;`) fires before anything is logged, exactly the
"classic behavior" the check specifies.

### Check 4 — parked-provider skip — ✅ PASS

`sessionFailoverProviders: ["claude","codex","antigravity"]`. `getProviderLimitLedgerPort().record()`
parked `codex` for 1h (a real ledger row, the same table a genuine 429 classification writes to). Fresh
Claude instance, real turn, patched, killed. Transcript, verbatim:

```
"Provider failover: claude → antigravity after auth (1/1 switches)"
considered: [{provider: "codex", vetoReason: "provider_limit_parked"}, {provider: "antigravity", vetoReason: null}]
```

Exactly the required skip-and-land behavior, with the exact required veto reason string. The antigravity
session then produced a real, correct reply to the original prompt. Ledger row cleared immediately after
(`clearActive()`, confirmed `getActive()` → `null`) — no residual park left in the shared store.

### Check 5 — context carry-over — ✅ PASS (direct log proof, both settings)

Two more failover cycles (technique as above), one with `sessionHandoffStateEnabled: true`, one with
`false`, both probed the same way as checks 1/3 of the sibling rolling-handoff-state doc: bumped
`RestartPolicyHelpers`'s log subsystem to `debug` via the same inspector access
(`getLogManager().setSubsystemLevel('RestartPolicyHelpers', 'debug')`), then read the `"Continuity rung
selected"` line the WS7 failover swap path (`RuntimeReconciler.applyRuntimeChange` →
`buildReplayContinuityMessage`) emits — the same instrumentation added for LT-046/047, previously
unverified against *this* call site specifically.

| Setting | Observed rung |
| --- | --- |
| `sessionHandoffStateEnabled: true` | `rung: "maintained-handoff"`, `documentChars: 790` |
| `sessionHandoffStateEnabled: false` | `rung: "replay-preamble"`, `documentChars: 745` |

Both cycles' new-provider sessions also correctly answered "what codename did I ask for earlier?"
(behavioral confirmation, matching check 1's technique), independent of the direct log proof.

### Check 6 — offered switch on a long park — ✅ PASS (found and fixed two real defects: LT-160, LT-161)

`instanceProviderLimitResumeEnabled: true`, `sessionFailoverOfferAfterMinutes: 1`. A real instance was
parked via the real `InstanceProviderLimitHandler.maybePark()` call with a 10-minute reset hint
(`> 1` minute threshold). `isParked()` correctly returned `true`, and a real desktop notification fired
(`title: "claude parked until …"`, mentioning "Switch provider" — `notificationList()` confirmed).

**But two real, reproducible defects blocked the check's second half** (the composer banner's third
button), both found, root-caused, fixed, regression-tested (each new test watched to fail on revert),
and live-verified in this session — full detail in the register:

- **LT-160** — `instance.waitReason` was never written onto the canonical main-process `Instance`
  object, only onto the renderer-broadcast batch, so `SessionAdmissionService.admitAutomatedWrite()`
  (and the mobile gateway's send gate) were structurally blind to every quota-park/auth-required wait
  state — a real admission-gate defect with no visible symptom until specifically probed. Fixed in
  `InstanceStateManager.queueUpdate()`.
- **LT-161** — the renderer's own `InstanceListStore.deserializeInstance()` never carried
  `failoverProviders` through from the IPC payload (an allowlist mapper missing one field), so
  `canOfferFailover()` could never be `true` and the "Switch provider" button could never render, for
  any instance, ever, in the shipped app. Fixed in `deserializeInstance()`.

**Post-fix, rebuilt `dist/main`, dev app restarted, re-driven live end to end** (fresh instance, fresh
park, real renderer navigation through the onboarding role-choice screen — clicked for real, this is
this session's own throwaway profile, not James's — into the instance detail view, with focus emulation
active so the DOM is real, not stale-occluded):

```
composer-banners component, live DOM read:
  canOfferFailover(): true
  .quota-park-bar innerText: "Provider limit — auto-resumes in ≤10m
                               Resume now
                               Cancel
                               Switch provider"
```

Both the notification half and the composer-banner button half of check 6 are now directly observed.

### Check 7 — one-click switch — ✅ PASS

Clicked the real "Switch provider" DOM button (synthetic but full `pointerdown`/`mousedown`/`mouseup`/
`pointerup`/`click` sequence, not just `.click()` — CDK's drag-handle wrapper on the sibling project
header did not respond to a bare `.click()`, so the fuller sequence was used everywhere in this
session). Result, all directly observed:

- `isParked()` → `false` immediately after (the countdown/auto-resume was cancelled).
- `waitReason` cleared on the live instance.
- `provider` swapped from `claude` to `codex`.
- Transcript, verbatim: `"Provider switch: claude → codex (user-requested while claude was limited)."`
  — exactly the required message shape, with `userRequested: true` in its metadata.
- Session continued on the new provider (`status: "busy"`, mid-turn, then `idle`).

No auto-resume fired on the old provider — `isParked()` false rules it out directly, rather than
waiting out the countdown.

### Cleanup

All instances created this session terminated via `terminateInstance`. `sessionFailoverProviders`,
`sessionHandoffStateEnabled`, `sessionFailoverOfferAfterMinutes`, and
`instanceProviderLimitResumeEnabled` all restored to their pre-session values and re-read to confirm
(`[]`, `false`, `30`, `false` respectively — all in this session's own isolated dev-app profile, never
touched via the production/packaged app). The one test row written to `getProviderLimitLedgerPort()`
(check 4) was cleared in the same session, before moving on. No `/tmp/aio-lt-batchL-ws7-*` workspace
processes remained (`ps aux` checked after each instance's termination). Dev app stopped at the end of
the full batch (see final report).

### Status: all seven checks PASS. Renamed to `_livetest_completed.md`.
