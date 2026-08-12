# Codex Runtime Resilience Live-Test Plan

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Status:** Pending rebuilt-app validation  
**Parent:** `docs/superpowers/plans/2026-07-14-codex-runtime-resilience-plan.md`  
**Prerequisite:** Build and launch a fresh AI Orchestrator instance from the working tree containing the runtime-resilience changes. Do not reuse a pre-change Electron process.

## 1. Native-thread continuity after an early interrupt

1. Start a new Codex instance in app-server mode in a disposable workspace.
2. Send: `Remember this exact continuity marker: amber-lantern-742. Acknowledge only.`
3. Send a second task that begins a real turn, then press Stop immediately while the turn is still starting.
4. Wait for the instance to return to idle, then send: `What exact continuity marker did I give you?`

Expected:

- Stop is accepted without the message `Codex context-cost recovery paused because the active turn did not confirm interruption`.
- The instance remains usable and answers `amber-lantern-742` from the same native thread.
- No fresh-thread/context-reset notice appears.

## 2. Compaction preserves conversational context (title/expected updated 2026-08-12 — see decision below)

1. In the same instance, send `/compact` and wait for completion.
2. Send: `Repeat the continuity marker and state whether you still have the preceding conversation.`

Expected:

- One compaction completion/system event appears, not duplicate events.
- The same Codex instance remains idle/usable after compaction.
- The response retains `amber-lantern-742`; no empty-thread fallback occurs.
- **Decided 2026-08-12 ([LT-017](../../plans/livetest-remediation-register.md#lt-017)):** the native
  provider *thread id* is allowed to change — restart-with-summary is the app's intentional
  compaction policy whenever the provider does not confirm native compaction within 30s, since every
  Codex build observed in this campaign never confirms it at all. The section's original title
  ("native compaction preserves the thread") described a stricter promise the app never made and, per
  the decision, should not make. What must hold is conversational continuity, not thread-id
  stability: the result must honestly report `nativeAttemptFailed: true` when the fallback fired
  (never a plain, indistinguishable success), and the marker must survive.

## 3. Restart resume uses one persisted runtime identity

1. Record the provider session/native thread ID shown by the instance diagnostics.
2. Quit AI Orchestrator cleanly and launch the rebuilt app again.
3. Resume the same Harness session.
4. Ask for `amber-lantern-742` again and re-check the provider session/native thread ID.

Expected:

- Resume proof is confirmed for the recorded native thread.
- The persisted cursor and provider session ID agree.
- The marker is retained and no replay/fresh-fallback warning is shown.

## 4. Protocol-drift failure is explicit

No destructive setup is required. During checks 1–3, inspect the instance error output if any app-server call fails.

Expected:

- There are no `protocol-invalid` failures with Codex CLI `0.144.4`.
- Any future incompatible response names the exact JSON-RPC method and invalid/missing field instead of presenting as lost context.

## Completion evidence

Record the app build/commit, Codex CLI version, native thread ID before/after restart, and pass/fail for each numbered section. Rename this file to `_livetest_completed.md` only after all four sections pass.

---

## Evidence run — 2026-07-26

**Environment.** Packaged app `/Applications/Harness.app` (asar packaged 2026-07-25 15:07, main
process started 15:22 — i.e. *not* a pre-change process). Codex CLI **0.145.0**
(`@openai/codex` 0.145.0), newer than the 0.144.4 this doc names. Real Codex app-server sessions
were live throughout the window.

### Section 4 — protocol-drift failure is explicit — ✅ PASS

- **No `protocol-invalid` failures.** `protocol-invalid` appears **0 times** across every file in
  `~/Library/Application Support/harness/logs/`, over a window containing 55
  `Codex adapter using app-server mode` selections, 0 `falling back to exec mode`, and real
  app-server traffic on CLI 0.145.0.
- **A future incompatible response names the method and field.** Verified in code rather than
  inferred: `protocolFailure(method, detail)` builds the message
  `` `Codex app-server response for ${method} is invalid: ${detail}` ``
  (`src/main/cli/adapters/codex/app-server-client-protocol.ts:77-84`), and all six call sites supply
  a field-level detail — `missing required parameter: <key>`, `unsupported parameter: <key>`,
  `missing required key: <key>`, `expected object params`, `expected an object result`
  (same file, lines 28-43). The failure is `terminal`, so it cannot present as lost context.

### Sections 1, 2, 3 — NOT RUN

All three need UI actions this session cannot perform against the packaged app (no remote-debugging
port, and no send/Stop/`/compact` path through the orchestrator MCP or `aio-mcp` CLI):

- **1** needs the Stop button pressed mid-turn-start.
- **2** needs `/compact` sent into a live instance.
- **3** needs a clean **quit and relaunch** of the app. Deliberately not attempted: the live app was
  hosting James's real sessions and in-flight loop agents throughout.

**Status: 1 of 4 sections passes. NOT renamed.**

## Evidence run — 2026-07-29 (dev app, `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, Codex CLI 0.146.0)

Environment: dev app rebuilt from the working tree (`npm run build:main` exit 0), relaunched twice
during this run. `@openai/codex@0.146.0` (newer again than the 0.145.0 of the previous run and the
0.144.4 this doc names). Instance `xk16ekq40`, workspace `/tmp/aio-lt-crr`.

| Section | Result |
| --- | --- |
| 1 — native-thread continuity after an early interrupt | **PASS** |
| 2 — native compaction preserves the thread | **FAIL** — the thread is replaced (**LT-017**) |
| 3 — restart resume uses one persisted runtime identity | **PASS** |
| 4 — protocol-drift failure is explicit | PASS (2026-07-26, unchanged) |

### Section 1 — PASS

The first attempt was invalid and is recorded so it is not repeated: waiting on a `busy` gate before
interrupting meant the interrupt landed ~31 s after the send, by which time the turn had finished.
That tests nothing.

Re-run without awaiting the send: the essay turn was fired, status sampled at **900 ms** read
`busy`, and the interrupt was issued at that point — genuinely "while the turn is still starting".

- `interruptInstance` returned `{interrupted: true}`; the instance was back to `idle` within 1.5 s.
- **Same native thread throughout**: `019fae6d-b79b-7512-bd8e-4cb2486fe536`, `adapterGeneration`
  **1** before and after — no respawn.
- Asked for the marker afterwards, it answered **`amber-lantern-742`**.
- `Codex context-cost recovery paused because the active turn did not confirm interruption`,
  fresh-thread and context-reset notices: **0 occurrences**.

### Section 2 — FAIL

Compaction on this instance did **not** take the native path, and the native thread was not
preserved:

| | Before | After |
| --- | --- | --- |
| provider session | `019fae6d-b79b-7512-…` | `019fae75-0235-7ca3-…` |
| `adapterGeneration` | 1 | 2 |
| context used | 31 539 | 0 |

`compactInstance` returned `{success: true, method: "restart-with-summary"}` after **37.8 s**, of
which 30 s was the native `thread/compacted` wait timing out. This is the **third independent
reproduction** of LT-017 today (the other two are in
`2026-07-14-context-cost-governor-plan_livetest.md`), on a different instance and workspace.

The section's other three sub-assertions do hold, and that matters for triage:

- **One** compaction system event (`— Context compacted —`), not duplicates.
- The instance remained `idle`/usable.
- The marker survived: *"amber-lantern-742. I retain a compacted summary of the preceding
  conversation, not the full verbatim conversation."*

So context is not lost — but the section is titled *native compaction preserves the thread*, and the
thread is destroyed and replaced on every compaction. Recorded as FAIL against its own wording.

### Section 3 — PASS

The dev app was fully quit (`pkill`) and relaunched, which is the section's actual prerequisite.
The instance did **not** auto-resume — `listInstances()` returned 0 — so the session was restored
from history via `restoreHistory(entryId)`:

- `restoreMode: **native-resume**` — resume proof confirmed, not a replay fallback.
- Restored provider session **`019fae6d-b79b-7512-bd8e-4cb2486fe536`**, exactly the id recorded on
  the history entry: persisted cursor and provider session id agree.
- `adapterGeneration` 1, status `idle`.
- Marker retained: **`amber-lantern-742`**. No replay/fresh-fallback warning.

### Observation worth triaging (not filed as a defect)

The history entry recorded provider session **`019fae6d`** — the **pre-compaction** thread. At quit
time the live thread was `019fae75` (section 2). Both rollout files exist on disk:

```
~/.ai-orchestrator/codex/sessions/…/rollout-2026-07-29T16-10-53-019fae6d-….jsonl
~/.ai-orchestrator/codex/sessions/…/rollout-2026-07-29T16-18-51-019fae75-….jsonl
```

So a restore resumes the thread as it was *before* the last compaction; anything the provider saw
only after that compaction is not in the resumed native thread. It looked like a clean pass here
only because the marker predates the compaction.

This is the same family as LT-013 (an archive recording a provider session that is not the live
one), but the harm is **not demonstrated**: `restoreHistory` also returns `restoredMessages`, so the
AIO-side transcript is replayed regardless, and this run did not test recall of a fact introduced
only after the compaction. Left as an observation for a run that stages exactly that.

**To close this doc:** section 2 needs LT-017 resolved (or its wording changed to match a deliberate
restart-with-summary policy). Sections 1, 3, 4 are green.

## Evidence run — 2026-08-12 (batch B — LT-017 decided, section 2 reclassified)

LT-017's open contract question is now decided (recorded in
`2026-07-14-context-cost-governor-plan_livetest.md` and the
[register](../../plans/livetest-remediation-register.md#lt-017)): restart-with-summary is the
app's intentional manual-compaction policy, and this section's title/expected wording above was
updated to match rather than the app being changed. Re-reading the 2026-07-29 evidence (this file,
above) against the **updated** wording:

- One compaction system event (`— Context compacted —`), not duplicates. ✅
- Instance remained idle/usable. ✅
- Marker survived (*"amber-lantern-742. I retain a compacted summary..."*). ✅
- `nativeAttemptFailed: true` was not asserted in the 2026-07-29 run specifically (that field was
  added by LT-017's 2026-07-30 partial fix, after this section's run), but the same code path was
  re-verified with the field present in the context-cost-governor doc's 2026-08-12 evidence run
  (three consecutive manual compactions, all `nativeAttemptFailed: true`) — same
  `compaction-coordinator.ts` `executeCompaction`, same fallback strategy, no section-2-specific
  behavior to re-drive.

**Section 2 verdict against the reclassification above: PASS** — and then freshly re-driven live in
this same session rather than left as a paper reclassification (see immediately below).

### Section 2 — freshly re-run live, 2026-08-12

New instance `xhgzh9w4z`, marker `violet-tundra-819` (a fresh marker, not reused). Sequence, read
directly from `outputBuffer` after the run (verbatim, not paraphrased):

1. `user`: "Remember this exact continuity marker: violet-tundra-819. Acknowledge only."
2. `assistant`: "violet-tundra-819"
3. `system`: "— Previous session archived —"
4. `user`: "[Context Compaction Continuity Package]\nCompaction method: restart-with-summary\n\nObjective:\nRemember this exact continuity marker: violet-tundra-819. Acknowledge only.\n\n…"
5. `assistant`: "violet-tundra-819"
6. `system`: "— Context compacted —"
7. `user`: "Repeat the continuity marker and state whether you still have the preceding conversation."
8. `assistant`: "violet-tundra-819. Yes, I retain the preceding conversation via the continuity summary."

`compactInstance` returned `{success: true, method: "restart-with-summary", nativeAttemptFailed:
true}` in 34.5s (a fresh instance, so this is correctly the first — timed-out — attempt, consistent
with LT-045's fix only changing the 2nd-and-later-call cost). Exactly **one** `— Context compacted —`
event (step 6), no duplicates. Instance stayed `idle`/usable throughout (`listInstances` polled
before and after). Marker retained and correctly repeated (step 8).

**Section 2 verdict: PASS**, freshly verified live, current build.

**Status: all four sections pass — 1, 3, 4 per the 2026-07-29 evidence above (unaffected by the
LT-017/LT-045 work: interrupt handling and restart/resume are separate code paths from
compaction); 2 per the fresh 2026-08-12 run immediately above. Renamed to
`_livetest_completed.md`.**
