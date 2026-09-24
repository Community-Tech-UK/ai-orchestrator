# Live tests — Interrupt stuck watchdog and streaming rewind

## Status — 2026-09-24 (runtime)

Open: 0 · Closed: 2 · Failed: 0
Both LT-599 and LT-600 re-run live against HEAD `f04f6748` (fix commit `9efc4871`, "Fixing codex")
with a real Cursor ACP session (`cursor-agent` 2026.09.10, signed in as
`james@shutupandshave.com`, model `grok-4.7`). Both **CONFIRMED FIXED LIVE**. See
[Evidence run — 2026-09-24 (runtime)](#evidence-run--2026-09-24-runtime). This document is now a
candidate for `_livetest_completed` (both checks pass with current evidence); rename is the
orchestrator's call, not this batch's.

## Status — 2026-09-21

Open: 2 · Closed: 0 · Failed: 2

Both checks were run against a freshly rebuilt, isolated dev app on 2026-09-21
(see [Evidence run — 2026-09-21](#evidence-run--2026-09-21)) and both failed, so
the prerequisite below is now satisfied and is no longer what blocks them.

- **Check 1 — partial.** The stuck-banner half passes: no banner and no
  `Process may be stuck` / `Stream idle timeout exceeded` over 163 s of silence
  after a Stop. The transcript half fails: no `Interrupted — waiting for input`
  is ever recorded, only a dangling `interrupt requested / unresolved`.
  Filed as **LT-600**.
- **Check 2 — fails.** The monotonic merge keeps `OutputMessage.content`, but the
  transcript renders `metadata.accumulatedContent`, which still carries the
  rewound snapshot, so the bubble collapses to `I'll` anyway. Filed as **LT-599**.

Neither residual needs James. Re-run this document once LT-599 and LT-600 land.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_plan_completed.md](./2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_plan_completed.md)

## Why these are deferred

ACP cancel→idle, interrupt-completion stuck-idle, and monotonic streaming merge
are covered by unit tests. A Stop during a live Cursor turn and a streaming
rewind in the real bubble cannot be proven without the rebuilt app.

## Prerequisites

- Rebuild main + renderer, then relaunch Electron. An already-running instance
  still has the old watchdog/streaming merge.
- A Cursor (ACP) instance that can take a user prompt and start tools.

## Checks

### 1. Stop during a Cursor tool turn does not raise a stuck banner

1. Start a Cursor Grok (or other Cursor ACP) chat in this repo.
2. Send a prompt that starts tools (e.g. "list leftover todo files in the repo root").
3. After the first tool result, press Stop / Escape.
4. Wait at least 90 seconds without sending another message.

Expected: transcript shows `Interrupted — waiting for input`. No
`Instance may be stuck — no output for …s` banner. `app.log` has no
`Process may be stuck` / `Stream idle timeout exceeded` for that instance
after the interrupt.

Run 2026-09-21 against a rebuilt app on a live Cursor turn: **partial pass**.
Stuck-banner half passes, transcript half fails (LT-600). See
[Evidence run — 2026-09-21](#evidence-run--2026-09-21).

### 2. Cursor streaming does not rewind the first assistant sentence to `I'll`

1. Start a fresh Cursor ACP chat.
2. Send any prompt that streams a full opening sentence.
3. Watch the first assistant bubble while it streams.

Expected: the visible sentence does not collapse from a full line back to
`I'll`. `app.log` may still record `[STREAMING_DROP]` (detect-and-keep), but
the bubble must keep the longer committed text.

Run 2026-09-21 against a rebuilt renderer on live Cursor streams: **fails**
(LT-599). See [Evidence run — 2026-09-21](#evidence-run--2026-09-21).

## Evidence run — 2026-09-21

Run as a Plan Queue item from worktree
`.worktrees/queue/2026-09-08-interrupt-stuck-wat-880ccb`.

**Environment.** `npm run build:main` (exit 0) and
`npx ng build --configuration development --output-path dist/renderer-dev`
(exit 0) on that worktree; the built renderer served on `:4567` with an SPA
fallback; dev app launched isolated as
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-1a880ccb npx electron . --remote-debugging-port=9796`.
`Emulation.setFocusEmulationEnabled` was sent before any DOM assertion and
verified each run: `document.hidden: false`, `visibilityState: 'visible'`,
`requestAnimationFrame` firing. Both prerequisites are therefore met — this is a
freshly rebuilt main and renderer, not the old watchdog/merge.

Provider: real Cursor ACP (`cursor-agent` 2026.09.10), model
`cursor-grok-4.6-medium`. Instances `ud1nrgbfc`, `u0a7h3bwz`, `udd2jkql0`.
Host load stayed ~6 throughout.

Verified before driving anything: the plan's as-built symbols are present on this
tree — `nextMonotonicStreamingContent`
(`src/shared/utils/streaming-content.ts:8`, used at
`instance-communication.ts:2339` and `instance-output.store.ts:104`),
`clearStreamIdleWatchdog()` first thing in `AcpCliAdapter.interrupt()`
(`acp-cli-adapter.ts:879`), the client-cancel `emit('status','idle')` branch
(`acp-cli-adapter.ts:580-583`), and the three
`onToolStateChange(id, 'idle')` calls in `interrupt-respawn-handler.ts`
(`:594`, `:684`, `:953`).

### Check 1 — Stop during a Cursor tool turn — **PARTIAL PASS**

Procedure: a Cursor ACP instance was given a multi-tool prompt, and
`interruptInstance` was called from the renderer the moment the first
`tool_result` landed, with the instance confirmed `busy` at that instant. Nothing
further was sent.

**The stuck-banner requirement passes.** On `udd2jkql0`, interrupt at
`04:00:03.689` while `busy`; status went to `idle` immediately and was sampled
every 250 ms for **163 s** with zero further transitions:

- no `Instance may be stuck — no output for …s` message in the output buffer,
- no such text anywhere in `document.body.innerText`,
- `app.log` contains **zero** `Process may be stuck` and **zero**
  `Stream idle timeout exceeded` lines for `udd2jkql0` or `ud1nrgbfc`.

The intended path is visible in the log:

```
04:00:03 info InterruptRespawn  Interrupt settled in place via adapter status; disarming force-abort net
  instanceId: udd2jkql0  status: idle
04:05:14 info InterruptRespawn  (same line)  instanceId: ud1nrgbfc  status: idle
```

**The transcript requirement fails.** No `Interrupted — waiting for input`
message was ever produced. The only interrupt record on either instance was:

```json
{ "type": "system", "content": "Interrupt requested: unresolved",
  "metadata": { "kind": "interrupt-boundary", "phase": "requested",
                "outcome": "unresolved", "turnId": "4" } }
```

Reproduced identically on a second instance (`ud1nrgbfc`), so this is
deterministic for ACP rather than a race — the pending-request rejection that
triggers the `idle` status is queued before the completion `.then`.

Filed as **LT-600**. Note recorded there: the exact string this check asks to
see has been suppressed from the rendered transcript since 2026-04-30
(`QUIET_INTERRUPT_SYSTEM_MESSAGES` plus
`shouldSuppressInterruptNoise`), so the check is read as an assertion about the
recorded output buffer. It is not present there either.

### Check 2 — Cursor streaming does not rewind to `I'll` — **FAIL**

Five live Cursor turns were instrumented with a `MutationObserver` on
`app-output-stream` plus a 15 ms poll of the renderer store, recording every
distinct content length for each assistant message.

**One genuine provider rewind occurred** and the main-process guard held it:

```
03:41:57.539 InstanceCommunication warn [STREAMING_DROP] streaming update shrank content
  instanceId: ud1nrgbfc  messageId: cursor-acp-1789958509513-pwpney
  previousLength: 343  newLength: 1  hasAccumulatedContentMeta: true
  previousTail: "...arrive as a sequence of deltas, retries, and late packets"
  newTail: "A"
```

Across all five turns neither the store nor the rendered transcript shrank —
store `358 → 1313` in 25 monotonic steps, DOM `37 → 1515` in 27, zero shrinks.
But on that turn the drop was absorbed inside main *before the renderer's first
paint of that bubble*, so the renderer-side behaviour was never exercised by it.

Driving the production renderer entry point directly
(`InstanceOutputStore.queueOutput`, whose only caller is the IPC output
subscriber at `instance/instance.store.ts:201`) with the exact message shape main emits
after its own guard — guarded long `content`, rewound
`metadata.accumulatedContent` — **the bubble collapses**:

```
store  outputBuffer[].content : "ZX9MARK I'll trace the cancel path and then summarise what the watchdog did."
store  metadata               : { streaming: true, accumulatedContent: "I'll" }
DOM    div.markdown-content   : "I'll"
```

`.markdown-content`, `.message-content`, `.message.message-assistant` and the
enclosing `.transcript-item` all read exactly `I'll`; no element in the
transcript still held the committed sentence. A subsequent genuinely longer
update was still applied correctly, and an empty snapshot was also held — so the
merge function itself is correct.

The cause is that the guard protects `content` while
`DisplayItemProcessorService.convertToItems` renders
`metadata.accumulatedContent` (`display-item-processor.service.ts:235-243`,
`255-262`), and both merge sites copy the incoming metadata verbatim
(`instance-communication.ts:2343`, `instance-output.store.ts:108`). Real Cursor
chunks always carry that metadata (`acp-cli-adapter.ts:1392-1398`), confirmed by
`hasAccumulatedContentMeta: true` on the live drop above.

Filed as **LT-599**.

### Residual

Both checks stay open. Neither needs James — both are code defects with
reproductions and acceptance criteria recorded in the register. Re-run this
document after LT-599 and LT-600 land.

Dev app, both Cursor instances and the `/tmp/aio-lt-queue-1a880ccb` profile were
stood down at the end of the run.

> Plan Queue parked work: `queue/2026-09-08-interrupt-stuck-wat-880ccb` — 1 commit(s), reason: land-blocked.

## Evidence run — 2026-09-24 (runtime)

Batch `runtime` of the 2026-09-24 live-test campaign. Repo HEAD `f04f6748`, fix commit `9efc4871`
("Fixing codex", 2026-09-23). Dev app isolated at `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-runtime`,
`--remote-debugging-port=9714`, renderer on `:4567`, focus emulation enabled before every DOM read.
`cursor-agent status` confirmed signed in as `james@shutupandshave.com`. One Cursor instance
(`uqxvzdmbu`, model `grok-4.7`), working directory `/tmp/aio-lt-0924-runtime-work`,
`yoloMode: true`.

### Check 1 / LT-600 — Stop during a Cursor tool turn: **CONFIRMED FIXED LIVE, full pass**

Sent a 3-tool-call prompt, polled the output buffer every 200 ms, and called `interruptInstance`
the instant the first `tool_result` landed with the instance still `busy` (fired at poll 55,
~11 s in). Immediately after:

- `lastTurnOutcome: "interrupted"` (previously the drill left this unset/stale).
- Transcript tail now reads, in order: `"Interrupt requested: unresolved"` →
  **`"Interrupt completed: cancelled"`** → **`"Interrupted — waiting for input"`**. The 2026-09-21
  run's failure was exactly the missing middle+final record (`only a dangling "interrupt
  requested/unresolved"` was ever produced); both are now present.
- Stuck-banner half re-confirmed: instance status was polled once per second for 95 s of total
  silence after the interrupt (0 transitions, stayed `idle` throughout);
  `document.body.innerText` contained no `may be stuck` / `no output for` text; a targeted grep of
  `~/Library/Application Support/harness/logs/app.log` for instance id `uqxvzdmbu` found zero
  `stuck`/`idle timeout` lines.

Fix confirmed at `src/main/instance/lifecycle/interrupt-respawn-handler.ts:591-620`
(`noteInterruptSettled()`): it now emits the `interrupt-boundary` `phase: 'completed'` event and the
`"Interrupted — waiting for input"` recovery-safe system message, and pushes a `queueUpdate` with
`lastTurnOutcome`, in the same place that previously only set `instance.lastTurnOutcome` in memory
without emitting either.

### Check 2 / LT-599 — Cursor streaming does not rewind to `I'll`: **CONFIRMED FIXED LIVE**

A live 40+ word streaming generation was also watched (`maxLen` grew monotonically to 1835 chars
across the whole page's `innerText`, zero shrink events) — but per the 2026-09-21 run's own finding,
a genuine provider-side rewind is rare in the wild and the store already guards `content`, so a
passive watch is not a reliable reproduction. Reproduced the exact precondition instead, directly on
the real `InstanceOutputStore` of the real Cursor instance (`window.__store.outputStore`, found via
`ng.getComponent` on `app-composer-banners`, matching the `renderer-ui-verify-via-ng-store-seeding`
pattern): queued one message with long `content`/`accumulatedContent`, then the same message id with
short, rewound `content: "I'll"` / `metadata.accumulatedContent: "I'll"`, then flushed.

Store state (verified via `store.instances()`, not IPC — this is a renderer-local injection):
`content: "ZX9MARK I'll trace the cancel path and then summarise what the watchdog did."`,
`metadata.accumulatedContent: "I'll"` — the exact guarded-content/rewound-metadata split the
original defect required. After selecting the instance in the real UI
(`setSelectedInstance` + `pushState`/`popstate`), both matching `.markdown-content` elements read
the full guarded sentence:

```
"ZX9MARK I'll trace the cancel path and then summarise what the watchdog did."
```

Not `"I'll"`. Previously this exact injection collapsed the bubble to `"I'll"`. Fix confirmed at
`src/renderer/app/features/instance-detail/display-item-processor.service.ts` — the new
`getStreamingDisplayContent()` now runs the incoming message through
`nextMonotonicStreamingContent()` (`src/shared/utils/streaming-content.ts`) against the *previous
rendered content*, not just against the incoming metadata, before the display item is built. The
two call sites that previously read `metadata.accumulatedContent` directly
(`display-item-processor.service.ts:233-243`, `:249-262` in the pre-fix version) both now go through
this guarded path.

### Residual

None. Both checks pass with current, code-verified evidence. Instance `uqxvzdmbu` terminated, dev
app and profile stood down per this batch's cleanup.
