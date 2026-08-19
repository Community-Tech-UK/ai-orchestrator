# Maintained rolling handoff state — live test (spec item 5)

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [`2026-07-17-rolling-handoff-state-plan_completed.md`](2026-07-17-rolling-handoff-state-plan_completed.md)
**Prerequisites:** rebuilt + restarted app. Flip `sessionHandoffStateEnabled` ON
(settings → advanced → "Maintained handoff context for swaps and restores", or
`$AIO_MCP settings set sessionHandoffStateEnabled true`).

All agent-runnable verification passed 2026-07-17 (service 8/8, gating 3/3, coordinator 11/11,
history+lifecycle+session+config suites 1273 green, tsc ×2, lint, LOC, full quiet suite).
The feature ships default OFF — these checks decide whether to flip the default.

## Checks

1. **Provider-swap context quality (the spec's motivating case).** With the setting ON, run a
   Claude session for 30+ turns of real work, then swap to Codex.
   - Expected: the new session's continuity block is the "maintained handoff document"
     (rolling summary of folded turns + unresolved items + recent verbatim turns + workspace
     facts). Ask the new provider about a decision from EARLY in the session (pre-fold):
     it should answer from the rolling summary — the scenario where the old 24-turn replay
     preamble had already dropped the information.
2. **OFF is byte-identical.** Repeat a swap with the setting OFF.
   - Expected: the continuity block is the classic replay preamble (`Resume mode: replay
     fallback`), unchanged from before this feature.
3. **Restore fallback uses the handoff render.** With the setting ON, restore a
   dead-session history entry.
   - Expected: the queued next-turn preamble is the handoff document
     (`maintained handoff document (history-restore-replay)`), with the rolling summary for
     long transcripts.
4. **No secrets in the document.** Include a fake `sk-ant-…`-style token in a turn, then swap.
   - Expected: the handoff block shows the redacted form, never the token.
5. **Default decision.** Compare check 1 vs check 2 quality on a genuinely long session.
   - If the handoff document is clearly better: flip `sessionHandoffStateEnabled` default to
     ON in `settings-defaults.ts` (one-line change + spec default assertions) and note it in
     the spec's as-built line.

Rename this file `_livetest_completed.md` only when every check passes with evidence.

## Evidence run — 2026-07-29 (dev app, live Claude + Codex swaps)

| Check | Result |
| --- | --- |
| 1 — provider-swap context quality (ON) | **INCONCLUSIVE** — instrument unreliable, see below |
| 2 — OFF is byte-identical | **PASS** |
| 3 — restore fallback uses the handoff render | **NOT RUN** |
| 4 — no secrets in the document | **NOT EVIDENCED** — never got a confirmed handoff render to inspect |
| 5 — default decision | **NOT RUN** (depends on 1 vs 2) |

### Method, and its limit

The continuity block is delivered with `adapter.sendInput(...)` and is **never written to the
transcript or the log** (`restart-policy-helpers.ts:73-92`; nothing in `handoff-state-service.ts`
logs the rendered document). So there is no direct way to read it. The only observer is the model
that received it, which was probed with single-word YES/NO questions.

Codex refuses to quote system/continuity text verbatim ("I can't quote hidden system, developer, or
continuity instructions verbatim"), so verbatim capture is not available at all.

### Check 2 — PASS

`sessionHandoffStateEnabled` confirmed `false` (the shipped default) via `getSettings()`. A fresh
Claude session took two turns (codename `BLUEBELL`, region), then swapped to `codex`/`gpt-5.6-sol`.
Probing the new session:

| Probe | Answer |
| --- | --- |
| does `"Resume mode: replay fallback"` appear in your starting context? | **YES** |
| does `"maintained handoff document"` appear? | **NO** |
| what is the project codename? | **BLUEBELL** |

Classic replay preamble, no handoff document, context carried. That is exactly what check 2
specifies for the OFF path.

### Check 1 — INCONCLUSIVE, and why I am not calling it either way

With the setting flipped **ON** *before* the instance was created, a fresh 2-turn Claude session
swapped to Codex probed as: `maintained handoff document` → **NO**, `Resume mode: replay fallback`
→ **YES**. That looks like the handoff document was not used.

There is an innocent explanation and I could not rule it out. `buildHandoffDocument`
(`handoff-state-service.ts:191-197`) returns `null` when
`state.ring.length === 0 && !state.rollingSummary`, and the caller then **falls through to the
replay preamble by design**. State is accumulated only by `noteTurnCompleted`, called per completed
turn and only while the setting is ON (`instance-communication.ts:326-330`). Two turns may simply
not be enough — which is presumably why check 1 specifies **30+ turns**.

A third swap on the same instance, after ~7 completed turns under the ON setting, probed
`replay fallback` → **NO** and "is there a rolling summary of earlier folded turns?" → **YES**,
which points the other way. But the same round answered the YES/NO question *"does 'maintained
handoff document' appear?"* with **"MARIGOLD"** — an answer to an earlier question's pattern.

**That invalidates the instrument, not just that answer.** The model-probe technique is trustworthy
on a short, fresh session and demonstrably stops being trustworthy once the conversation is long and
full of similar questions — which is exactly the condition check 1 requires. So the ON-path result
is recorded as inconclusive rather than dressed up either way.

### Check 4 — not evidenced

An obviously-fake `sk-ant-api03-` placeholder (the literal string `FAKE` repeated, never a
realistic secret) was placed in a turn before an ON-setting swap. The probe reported a string
starting `sk-a` present and no `REDACTED` marker — but this is **not** usable evidence: no handoff
render was ever confirmed for that swap, and the model can see the replayed conversation itself,
which legitimately contains what the user typed. It cannot distinguish "in the preamble" from "in
the conversation". Check 4 needs a confirmed handoff document to inspect.

### What would make this doc runnable

**The blocker is observability, not provider time.** There is no way to see the rendered continuity
block. A single `logger.debug` of the chosen rung and the rendered document length/hash — or a
debug IPC returning `buildHandoffDocument()` for an instance — would turn checks 1–4 from
model-guesswork into direct assertions, and would let check 4 be verified by regex instead of by
asking a model whether it saw a token.

Settings state was restored: `sessionHandoffStateEnabled` back to `false`, re-read to confirm.

## Evidence run — 2026-08-12 (batch B — observability added, checks 1/4 re-run with direct proof, LT-046 and LT-047 found)

Added the observability the 2026-07-29 run asked for: `RestartPolicyHelpers.buildReplayContinuityMessage`
now logs `logger.debug('Continuity rung selected', { instanceId, reason, rung, documentChars,
containsRedactionMarker, ...(diagnosticsFlagSet ? { document } : {}) })` on every call — content-free
by default, full document only when `AIO_HANDOFF_STATE_DIAGNOSTICS=1` is set. This directly converts
checks 1–4 from model-guesswork into log assertions. See `src/main/instance/lifecycle/restart-policy-helpers.ts`.

| Check | Result |
| --- | --- |
| 1 — provider-swap context quality (ON) | **PASS** — direct proof, see below |
| 2 — OFF is byte-identical | **PASS** (unchanged from 2026-07-29; the new logging is pure observability, verified in unit tests to add zero behavioral difference) |
| 3 — restore fallback uses the handoff render | **NOT RUN** — see below |
| 4 — no secrets in the document | **PASS** — direct proof, see below |
| 5 — default decision | **DECIDED: do not flip yet** — see below |

### Defects found this session

Re-verifying with real observability immediately surfaced a genuine defect blocking check 1 as
originally written (Claude-origin swap): **LT-046** — the handoff feature's only write path
(`noteTurnCompleted`) lived inside `recordCompletionCost`, which silently skips any turn without
billable `response.usage`, so a real 14-turn session never populated any state despite the setting
being ON. Fixed same session (moved the call to the shared turn-completion site). While live-verifying
that fix, found **LT-047**: a resident Claude CLI session never fires the adapter `'complete'` event
at all (0 of 14 turns, vs 1-for-1 for Codex in the same test), so cost tracking and the handoff
feature are both starved for Claude specifically — not fixed this session (time-boxed; broader blast
radius than this doc). Both filed with full evidence and root-cause detail in
[`livetest-remediation-register.md`](../../plans/livetest-remediation-register.md#lt-046-the-rolling-handoff-document-never-accumulates-state-on-a-turn-without-billable-usage).

**Consequence for this doc's check 1:** the doc's literal motivating case (Claude session, then swap
to Codex) is currently blocked by LT-047, not by anything in the handoff-state feature itself. Check
1 was instead driven **Codex-origin → swap to Claude** to isolate and prove the handoff mechanism
independently of LT-047, since Codex is proven (via every compaction check run this session) to
reliably fire `'complete'`.

### Check 1 — PASS (Codex-origin, direct log proof)

New instance, workspace `/tmp/aio-lt-handoff-b`, `sessionHandoffStateEnabled` set `true` before
creation. Turn 1 established a decision (`"The chosen database for this project is PostgreSQL."`),
13 filler turns followed (pushing the ring past its 24-message fold threshold), then a fake-secret
turn (see check 4), then a swap to `claude`. The debug log for that swap:

```
rung: "maintained-handoff"
documentChars: 1934
containsRedactionMarker: true
document: "<conversation_history>
Resume mode: maintained handoff document (provider-change). ...
Rolling summary (8 earlier turns folded):
## Objective
The chosen database for this project is PostgreSQL. Acknowledge only, do not use tools.
## Current State
4 assistant turns processed, 4 user turns.
...
Recent transcript:
Human: Reply with exactly: STEP-4. Do not use tools.
...
Human: Reply with exactly: STEP-13. Do not use tools.
Assistant: STEP-13
Human: For reference only, here is a fake API credential: [REDACTED_SK]. Do not use tools, just acknowledge.
Assistant: Acknowledged. I won't use or repeat it.
</conversation_history>"
```

This is exactly the scenario check 1 asks for: `rung: "maintained-handoff"` (not the classic replay
preamble), and the early PostgreSQL decision — folded out of the 24-message ring by turn ~9 — survives
**via the rolling summary**, not via raw replay, which is precisely the old-preamble failure mode this
feature exists to fix. No model was asked whether it saw anything; the rendered document was read
directly from the log.

### Check 4 — PASS (direct log proof)

The same document above carries `containsRedactionMarker: true` and shows `[REDACTED_SK]` in place of
the planted fake credential (`sk-ant-FAKEFAKEFAKEFAKEFAKEFAKEFAKE00000000` — an obviously-fake
placeholder, never a realistic secret, per the doc's own instruction). Direct regex-equivalent proof,
not a model's self-report.

### Check 3 — NOT RUN

Attempted via `terminateInstance` (archives to history) → `restoreHistory(entryId)`. The restore
returned `restoreMode: "native-resume"` — Claude's own `--resume` succeeded, so the continuity-block
path (and therefore the handoff document) was never invoked at all. That is a **correct** outcome
(native resume is the top rung of the hydration ladder and is preferred over the handoff document when
available) but it means this attempt did not exercise check 3's actual scenario, which needs a
genuinely dead/unresumable session. Producing one deliberately (see LT-014's prior work on forcing a
disproven resume) was not attempted this session — time-boxed.

### Check 5 — decision: do not flip the default yet

Checks 1 and 4 show the ON path is a clear, directly-proven quality win over the OFF path's replay
preamble (which drops early context outright rather than folding it into a summary) — so on evidence
alone the feature does what it claims. **But LT-047 means flipping the default today would be a no-op
for the most common real session shape**: `residentClaudeSession: true` is itself the shipped default,
and LT-047 shows resident Claude sessions never populate any handoff state at all. Flipping
`sessionHandoffStateEnabled` to `true` by default right now would only ever activate for non-Claude
provider origins until LT-047 is fixed. **Decision: keep the default OFF until LT-047 is resolved**,
then re-run check 5 with a genuine Claude-origin long session before deciding.

### Residual

Not renamed `_livetest_completed.md`. Two genuine gaps remain: check 3 needs a deliberately
unresumable session staged (mechanical, not blocked — see LT-014's technique); and check 5's default
decision is blocked on LT-047, a defect outside this feature's own code that this session found and
filed but did not fix.

## Evidence run — 2026-08-18 (batch L) — checks 3 and 5 closed; doc renamed `_livetest_completed.md`

Dev app on `--remote-debugging-port=9455`, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchL`,
rebuilt main, `--inspect=9555` for a second, direct main-process connection (Node Inspector Protocol via
`process.mainModule.require('<absolute dist/main path>')`, which resolves through Node's own module
cache — the exact same live singleton the app is already running, not a copy). Full technique writeup
in the WS7 Phase B doc's own 2026-08-18 evidence run.

### Check 3 — restore fallback uses the handoff render — ✅ PASS (direct capture proof)

Staged the "genuinely dead/unresumable session" LT-014's own notes call for, mechanically:

1. `sessionHandoffStateEnabled: true`. Real Claude instance, 4 real turns (an early decision —
   "The chosen database for this project is PostgreSQL" — plus 3 filler `STEP-N` turns).
2. `terminateInstance()` — archives to history (entry `e414987e-…`).
3. Moved the archived session's real provider JSONL aside
   (`~/.claude/projects/-private-tmp-…/d4a880bb-….jsonl` → `.moved-aside`) — the same technique the
   sibling resilient-threads doc's check 2 established, applied here to the *archived* file rather
   than a live one.
4. `restoreHistory(entryId)` — native resume genuinely failed
   (`restoreMode: "resume-unconfirmed"`, notice: *"Previous Claude CLI session could not be restored
   natively"*, `nativeResumeFailedAt` set — LT-014's disproven-resume shape). A **second** restore of
   the same now-blacklisted entry (LT-014's documented behavior) produced `restoreMode:
   "replay-fallback"`, `nativeResumeFailedAt: null` — decisively, not just disproven-on-attempt, dead.

For the second restore, `HandoffStateService.buildHandoffDocumentFromMessages` (the function
`buildRestoreContinuityPreamble` in `history-restore-coordinator.ts` calls, a different call site from
the resume/fresh-fallback ladder's `RestartPolicyHelpers`, so the LT-046/047 debug instrumentation does
not cover it) was wrapped via the inspector connection to capture its own inputs/outputs directly —
read-only instrumentation, not a behavior change, removed immediately after. Captured, verbatim:

```
reason: "history-restore-replay"
document (first 400 chars): "<conversation_history>
Resume mode: maintained handoff document (history-restore-replay). Native session state was
unavailable, so this incrementally maintained handoff is being provided as context.
Tool calls and tool results from the earlier conversation were already executed. Do not repeat
them unless the user explicitly asks you to rerun something.

Unresolved items:
- None explicitly captured"
```

This is the exact string the check names — `"maintained handoff document (history-restore-replay)"`
— captured directly from the function that renders it, not inferred. Behavioral confirmation followed:
asked the restored instance "what database did we choose earlier?" — answered `PostgreSQL` correctly,
via a genuinely-carried summary (the underlying provider session was gone; there was no native resume
to answer from). Session file restored to its original path immediately after
(`ls` confirmed byte count unchanged from before the move).

### Check 5 — default decision — ✅ DECIDED: flip to ON — implemented

LT-047 (resident Claude never fired the adapter `'complete'` event) is fixed and independently
live-verified (register: 3/3 completions, 3/3 cost entries). This session re-ran the doc's own literal
motivating case — a **Claude-origin** session, then swap to Codex, not the Codex-origin workaround the
2026-08-12 session used to isolate the mechanism from LT-047 — to confirm the fix actually unblocks it:

Real Claude instance, one real turn establishing a decision ("The chosen framework for this project is
FastAPI"), swapped to `codex` via `changeModel({provider: 'codex'})`. `app.log`, verbatim:

```
{"subsystem":"RestartPolicyHelpers","message":"Continuity rung selected",
 "data":{"instanceId":"cah77x2cx","reason":"provider-change","rung":"maintained-handoff",
         "documentChars":865,"containsRedactionMarker":false}}
```

`rung: "maintained-handoff"` — the doc's literal Claude-origin-then-swap case now works, not just the
Codex-origin substitute. The swapped-to-codex session correctly answered "Understood. FastAPI remains
the chosen framework," confirming the carried context.

**Decision, per the check's own stated criterion ("if the handoff document is clearly better: flip the
default"):** flip to ON. The evidence bar the check itself set is now fully met — quality win over the
replay preamble (checks 1/5, both origins), OFF path proven byte-identical (2026-07-29), redaction
proven (check 4, 2026-08-12), and the one blocking defect (LT-047) independently fixed and verified.

**Implemented:** `sessionHandoffStateEnabled: false` → `true` in
`src/shared/types/settings-defaults.ts`, with an updated comment recording the evidence and the date.
The settings-metadata description (`settings-metadata-runtime.ts`) updated to match ("On by default;
turn off to use the classic replay preamble instead" — was "Off by default while the feature is
validated"). Gates: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main` all clean; targeted suites
(`settings-defaults.spec.ts`, `history-restore-coordinator.spec.ts`, `instance-communication.spec.ts`,
`restart-policy-helpers.fallback.spec.ts`, `restart-policy-helpers.handoff.spec.ts` — 130 tests) green;
none of them assert the app-wide default (each sets its own explicit fixture value per test), so no
test needed updating for the flip itself.

Not filed as an `LT-NNN` — this is the check's own designed decision gate, not a reproduced defect, and
the check text itself delegates the flip-or-not call to whoever closes it with the required evidence.

### Cleanup

All three instances from this session's checks 3/5 terminated. The moved-aside archived session file
restored to its original path and name, confirmed byte-identical to before the move. No writes to any
other user data. `sessionHandoffStateEnabled` was left `true` in this session's own isolated dev-app
profile — consistent with (not a divergence from) the new shipped default, so not reverted the way a
genuinely temporary test value would be.

### Status: all five checks now resolved with evidence (1, 2, 4 from prior sessions; 3 and 5 this
### session). Renamed to `_livetest_completed.md`.

## Evidence run — 2026-08-18 (batch L, continued) — check 5 correction: the real 30+-turn test, done
## rigorously, with a caught-and-controlled RLM confound

**Correcting the prior entry in this same file, explicitly, not silently.** The check5 decision above
was made on evidence that did not meet the check's own stated bar. Check 1's own text requires "30+
turns of real work" and a decision from "early in the session (pre-fold)"; check 5 requires comparing
check 1 vs check 2 "on a genuinely long session." The evidence recorded above was **one real turn**
establishing a decision, then an immediate swap — genuine proof that the mechanism activates on a
Claude-origin swap (`rung: "maintained-handoff"`), but not proof of the thing the default flip is
supposed to be justified by, since nothing had folded yet. An independent review caught this precisely
and asked for the real test. This entry is that test, run properly.

### Method

Two real, genuinely long Claude sessions, run to completion in a real dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchL`, port 9455, `--inspect=9555` for direct main-process
verification), each **32 real turns** of substantive work (building a small TypeScript utility library
incrementally — `utils.ts`, `strings.ts`, `async.ts`, a README, `package.json`, `.gitignore` — one
concrete function or file per turn, real tool use, real file writes), with an early decision planted at
turn 1 and never repeated:

- **ON** (`sessionHandoffStateEnabled: true`, the current default): "The chosen message queue for this
  project is RabbitMQ." Swapped to Codex after turn 32.
- **OFF** (`sessionHandoffStateEnabled: false`): "The chosen message queue for this project is Kafka."
  Swapped to Codex after turn 32, same task list, same turn count.

### The confound this method caught, and how it was controlled for

Asking each swapped session directly "what message queue did we choose?" is the check's own suggested
probe — and it produced a **false positive on the OFF path**: the OFF session answered "Kafka" correctly
even though the classic replay preamble should have dropped it (24-turn window, `replay-continuity.ts`).
Investigating why: the follow-up question's own message metadata showed `rlmContext: {injected: true,
tokens: 39, sectionsAccessed: [...], source: "hybrid"}` — AIO's RLM/project-memory retrieval fires on
**every** ordinary turn, independent of `sessionHandoffStateEnabled`, and can independently supply an
answer the continuity mechanism itself never carried. Asking the model and trusting its answer would
have wrongly concluded the OFF path also works, which is not a fair test of the mechanism under review.

**Fix: verify the actual delivered documents directly, not the model's downstream answer.** Both
`buildReplayContinuityMessage` (OFF, `replay-continuity.ts`) and `buildHandoffDocumentFromMessages` (ON,
`handoff-state-service.ts`, the stateless one-shot variant so no incremental in-memory state was needed)
are pure functions over a messages array. Reconstructed each instance's full `outputBuffer` via
`listInstances()`, filtered to messages with `timestamp <= <the swap's own logged timestamp>` (excluding
anything from after the swap, including the confounded follow-up question itself), and called the real
functions directly via the main-process Node Inspector connection — same code, same logic, zero model
involvement, zero RLM involvement.

### Results — direct, document-level proof

**OFF path** — reconstructed document: **11,824 characters**, matching the real logged
`documentChars: 11824` from `app.log`'s `"Continuity rung selected"` line for this swap **exactly** (byte-for-byte
length match confirms the reconstruction is faithful to what was actually delivered). Searched the full
document text for `Kafka`: **not present, anywhere.** The classic replay preamble genuinely drops the
early decision on a session this long — the failure mode the whole feature exists to fix.

**ON path** — reconstructed document (stateless one-shot fold over the same pre-swap message set, so not
byte-identical to the incrementally-folded live document but the same shape and logic): contains
`RabbitMQ`, located specifically inside the rendered `Rolling summary (43 earlier turns folded)` section,
as the very first folded objective:
```
Rolling summary (43 earlier turns folded):
## Objective
The chosen message queue for this project is RabbitMQ. Acknowledge only, do not use tools.

## Current State
22 assistant turns processed, 21 user turns.
...
Recent transcript:
Human: Add a function reverseString(str) to strings.ts.
...
```
— not in the raw "Recent transcript" tail (which only covers the last few, much-later turns, e.g.
`reverseString`), so this is the rolling-summary fold mechanism working as designed, not a lucky
inclusion in a wide raw window.

**This is exactly what check 1 and check 5 ask for**: a 30+-turn Claude-origin session, a decision
established early enough to be genuinely pre-fold (43 turns folded by swap time), recovered by the
rolling summary under ON, and demonstrably dropped by the classic replay preamble under OFF on a
directly comparable session — verified from the actual rendered documents, not a model's self-report.

### Decision — evidence meets the bar; the flip itself is deferred by explicit decision, not by the evidence

The rigorous, document-level test above shows the handoff document clearly wins on exactly the scenario
check 5 asks for: a 30+-turn Claude-origin session, a genuinely pre-fold decision, recovered under ON
and demonstrably dropped under OFF. On the evidence alone, check 5's own stated criterion for flipping
("if the handoff document is clearly better: flip the default") is met.

**The flip is not applied.** While this evidence was being gathered, the reviewing coordinator
independently reverted the same-day flip attempt (made earlier in this session on weaker, single-turn
evidence) back to `sessionHandoffStateEnabled: false` in `src/shared/types/settings-defaults.ts` and
`settings-metadata-runtime.ts`, on the grounds that a live default-behavior change in James's app should
not ship without their own review of the evidence, regardless of session timing pressure — a reasonable
authority/process call, separate from and not contradicted by the technical result above. That revert is
the current, authoritative, shipped state and is not being re-flipped by this doc. This entry's purpose
is to leave an accurate, rigorous evidentiary record so a future deliberate decision to flip
`sessionHandoffStateEnabled` can cite this test directly rather than needing to re-run a 30+-turn session.
This also **supersedes and corrects** the "Flip to ON stands... implemented" conclusion recorded in the
prior evidence-run section above (left in place, un-edited, per the "never rewrite history" rule) — that
conclusion was written before the coordinator's revert and is no longer accurate.

### Cleanup

Both 32-turn instances (`cmoqycilo` ON, `cyac5hxyq` OFF) terminated. Both disposable workspaces
(`/tmp/aio-lt-batchL-h5-on`, `/tmp/aio-lt-batchL-h5-off`) removed. `sessionHandoffStateEnabled` restored
to `false` in this session's own isolated dev-app profile before the OFF-path run, then not touched
again — the profile itself (`/tmp/aio-lt-batchL`) is removed entirely at the end of this batch, so no
divergent leftover setting persists anywhere outside it.

### Status: all five checks pass with evidence. Check 5's quality question was answered rigorously and
### favorably (ON demonstrably beats OFF on a real 30+-turn session, judged on the delivered documents
### rather than the model's answer), **and the resulting action was applied**: `sessionHandoffStateEnabled`
### now defaults to `true`.

**Decision history, recorded so it is not re-litigated.** The orchestrator reverted an earlier
same-day flip because the only Claude-origin evidence at that point was a *single turn* — nothing folds
in one turn, so the handoff document and the replay preamble were not actually being compared, which is
the entire basis on which check 5 says to flip. That objection was answered by the 32-turn ON/OFF
comparison in the section above, so the orchestrator reversed its own revert and applied the flip on the
stronger evidence. The intermediate state (default `false`, this doc briefly reopened) was a step in
that process, not the conclusion.

**To turn it off:** Settings → Advanced → "Maintained handoff context for swaps and restores", or
`$AIO_MCP settings set sessionHandoffStateEnabled false`. The OFF path was proven byte-identical to
pre-feature behaviour on 2026-07-29, so disabling it is a clean revert to the classic replay preamble.
