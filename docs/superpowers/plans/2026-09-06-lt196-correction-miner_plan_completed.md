# LT-196 correction-miner outcome signal — implementation plan

**Date:** 2026-09-06
**Spec:** [`2026-09-06-lt196-correction-miner_spec_completed.md`](../specs/2026-09-06-lt196-correction-miner_spec_completed.md)
**Register:** `docs/plans/livetest-remediation-register.md` — LT-196
**Status:** Completed 2026-09-13. Implemented and verified in-loop; round-7 independent review
returned PASS. Live end-to-end checks are deferred to
[`2026-09-06-lt196-correction-miner_livetest.md`](./2026-09-06-lt196-correction-miner_livetest.md).
The Decision section below is kept as originally written. The as-built rounds that follow it
supersede its architecture.

Implements option (a) from the spec: capture the tool outcome at each adapter's true
`is_error` site as a transcript-invisible `OutputMessage`, and teach the miner to read it.

## The open question the spec left to planning, resolved

The spec deferred the choice between a **new `OutputMessage.type`** and the **existing
`tool_result` type plus a `metadata.hiddenFromTranscript` flag**, and asked planning to
decide by counting how many exhaustive switches over `OutputMessage.type` exist.

Counted. The apparent "45 switches on `.type`" is misleading — almost all are worker IPC
message unions (`cli-spawn-worker-main.ts`, `context-worker-main.ts`,
`conversation-ledger-worker-main.ts`, `codemem/index-worker-main.ts`,
`main-process-watchdog-worker.ts`, `provider-runtime-trace-worker.ts`,
`browser-extension-native-host.ts`), not `OutputMessage`. The genuine `OutputMessage`
consumers are far fewer, and the surfaces that render a `tool_result` are four:
`session-replay-page.component.ts`, `chat-output-message.mapper.ts`,
`tool-group.component.ts`, and the mobile gateway's type mirror.

**Decision: add a new union member `'tool_outcome'`.**

Reasoning:

1. **The compiler enforces it.** Adding a union member turns every exhaustive switch into a
   compile error, so `tsc` finds the places that must handle it. A metadata flag is invisible
   to the type system and relies on four-plus rendering surfaces each remembering to check —
   exactly the failure mode that produced LT-062 in the first place.
2. **Non-exhaustive consumers ignore it for free.** Anything matching `=== 'tool_result'`
   simply will not match, so the four rendering surfaces need no change and cannot regress
   LT-062's transcript hygiene.
3. **The one fallthrough renderer has a central hook.**
   `DisplayItemProcessorService.getVisibleMessageEntries()` already drops messages centrally
   (it suppresses transient health warnings there). One suppression added there covers the
   main transcript, rather than scattering checks.

## Steps

1. **Shared type.** Add `'tool_outcome'` to `OutputMessage['type']` in
   `src/shared/types/instance.types.ts:237` and to the renderer mirror in
   `src/renderer/app/core/state/instance/instance.types.ts:79`. Add a small shared helper
   module exposing `buildToolOutcomeMessage()` and `isToolOutcomeMessage()` so adapters and
   the miner share one definition of the record's shape rather than duplicating metadata keys.
2. **Claude adapter.** In the `case 'user':` tool-result content-block loop
   (`claude-cli-adapter.ts` ~1285-1300), alongside the existing internal raw emit, emit one
   `tool_outcome` message carrying `{ tool_use_id, command, is_error }`. `is_error` comes from
   the `block.is_error === true` value already computed two lines above. Do **not** change the
   existing raw emit or reintroduce a visible `tool_result`.
3. **ACP adapter.** In `AcpCliAdapter.handleToolCallDelta()` (~1469-1519), emit the same
   record, deriving `is_error` from `status === 'failed'`. Emit only on a terminal status
   (`completed` / `failed` / `cancelled`), matching where the raw `tool_result` event already
   fires, so a single tool call yields exactly one outcome record.
4. **Miner.** Teach `correction-miner.ts`'s `extractToolInvocations()` to read a
   `tool_outcome` record as a source of `isError` and command text, correlating by
   `tool_use_id`. Leave the existing `tool_use`/`tool_result` pairing intact so Codex — the
   one provider that already works — keeps working unchanged. Pairing, exploration-command
   exclusion, TDD red/green exclusion and confidence scoring are untouched.
5. **Renderer suppression.** Add the `tool_outcome` check to
   `DisplayItemProcessorService.getVisibleMessageEntries()` so the record never becomes a
   display item.
6. **Fix the stale comment.** `correction-miner.ts:5-11` claims `is_error` is carried "on
   Claude, ACP, Codex-exec, Cursor, and Copilot adapters". False for four of five. Rewrite it
   to describe what the code now actually does.

## Tests

- Adapter-level, Claude: an ordinary failing tool result produces a `tool_outcome` with
  `is_error: true`; a successful one produces `is_error: false`.
- Adapter-level, ACP: `status: 'failed'` produces `is_error: true`; `completed` produces
  `false`; exactly one record per tool call.
- **LT-062 hygiene regression:** the existing assertion that an ordinary tool result produces
  no visible `tool_result`-typed message still passes, and the new record does not become a
  display item.
- Miner: a transcript containing `tool_use` + `tool_outcome` (no `tool_result`) yields a
  correction pair; the existing Codex-shaped `tool_use`/`tool_result` transcript still does.
- Existing `correction-miner.spec.ts` cases pass unchanged.
- Mutation check: revert each new emit and confirm the matching test fails.

## Verification

Canonical checklist: both `tsc --noEmit` invocations, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and the focused
suites, then `npm run test:quiet` as the final gate. Then an independent
`task-completion-gate` review.

## Out of scope

As the spec: Antigravity, Gemini, the doom-loop detector's hardcoded `success: true`, the
Memory Review inbox behaviour, the miner's false-positive filters, and backfilling sessions
archived before this ships. Codex's already-working path is deliberately left alone.

## Acceptance

Spec criteria 1–7. Criteria 1 and 2 (a real end-to-end scan on a live Claude and a live ACP
session) require a rebuilt app and real provider traffic; if they cannot be run in-loop they
go to a `_livetest.md` rather than being claimed.

## As-built

Implemented 2026-09-06, following the plan above with one addition found during the work.

**Files changed**

- `src/shared/types/tool-outcome.ts` (new) — the record's shape, `buildToolOutcomeMessage()`,
  `isToolOutcomeMessage()`, and `isVisibleOutputMessage()` for boundary filtering.
- `src/shared/types/instance.types.ts:237` and
  `src/renderer/app/core/state/instance/instance.types.ts:79` — `'tool_outcome'` added to the
  union.
- `src/main/cli/adapters/claude-cli-adapter.ts` — emit in the `case 'user':` tool-result block,
  beside the existing raw emit, using the `block.is_error === true` already computed there.
- `src/main/cli/adapters/acp-cli-adapter.ts` — emit in the terminal-status block of
  `handleToolCallDelta()`.
- `src/main/learning/correction-miner.ts` — `extractToolInvocations()` accepts `tool_outcome`
  as closing an open `tool_use`; the stale header comment rewritten to match reality.
- `src/renderer/app/features/instance-detail/display-item-processor.service.ts` — central
  suppression in `getVisibleMessageEntries()`.
- Boundary filtering the compiler demanded (see below): `mobile-gateway-serializers.ts`,
  `mobile-gateway-server.ts`, `mobile-gateway-history-handlers.ts`,
  `src/main/app/orchestrator-tools-step.ts`.

**The type choice paid off exactly as predicted.** Adding the union member produced compile
errors at precisely two boundaries that expose the transcript to consumers with no
`tool_outcome` representation — the mobile DTO and the agent-facing node-output read. Both now
filter the record rather than widening their types. A metadata flag would have found neither.

**One defect found and fixed during implementation, not in the plan.** The first ACP version
derived `isError` from `status === 'failed'`, which recorded a **cancelled** tool call as a
success. That is not cosmetic: `scoreConfidence()` (`correction-miner.ts:271`) credits **+0.15**
for `fixIsError === false` and **−0.05** for `null`, so a cancelled command would have been
scored as a confirmed fix and inflated a proposal's confidence by 0.20 on a premise that never
happened. `cancelled` is now skipped entirely, which correctly leaves the miner with no signal.

**Deliberately not done:** Codex's already-working `tool_result` path is untouched, and the
visible ACP `tool_result` metadata was left alone rather than also gaining an `is_error`, to
avoid two sources of truth for the same fact.

**Verification**

- Full suite: **1,990 files, 21,867 tests, exit 0** (`_scratch/test-run.lt196.log`).
- `npx tsc --noEmit -p tsconfig.spec.json`, `npm run check:ts-max-loc`, `npm run build:main`,
  `npm run build:renderer` all exit 0.
- Mutation-checked: removing the Claude emit fails 2 of its tests; removing the ACP emit fails
  its test. Both restored and green.
- `npx tsc --noEmit` reports errors **only** in
  `src/renderer/app/features/title-bar/notification-center.component.ts`, a file this work never
  touched, modified by a concurrent session at 22:49 while mid-edit (missing imports). Same for
  the one `npm run lint` error, in the untracked
  `src/renderer/app/shared/terminate-confirm/terminate-confirm-dialog.component.ts` created by
  another session at 22:43. Neither is attributable to this change and neither was edited.

**Acceptance criteria 1 and 2** — an end-to-end "Scan for corrections" against a real Claude
session and a real ACP session — require a rebuilt app and real provider traffic. They are
deferred to
[`2026-09-06-lt196-correction-miner_livetest.md`](./2026-09-06-lt196-correction-miner_livetest.md)
rather than claimed.

## Independent review — round 1 returned FAIL, and it was right

A fresh reviewer that had not written the code found two defects. Both were confirmed against
source before acting, and both are now fixed.

**1. The ACP fix could not have worked at all (critical).** `handleToolCallCreated`
(`acp-cli-adapter.ts`) emits its `tool_use` with metadata
`{ toolCallId, kind, name, title, status, transport }` — **no command**. The miner opens an
invocation only when `extractCommandText()` finds one (`correction-miner.ts:136`,
`if (!command) return;`), so no entry was ever opened for an ACP call and every closing
message was then dropped as uncorrelated. The outcome record was landing in a transcript that
had nothing to attach it to. Acceptance criterion 2 would have failed on a real session while
every unit test passed.

The reviewer also caught why my own test missed it: the miner test built its `tool_use` side
with the **Claude** metadata shape while its comment claimed it covered ACP too. That comment
was false and is corrected.

*Fix:* the ACP `tool_use` now carries `input: rawInput`, so `metadata.input.command` resolves.
A new test builds the genuine ACP shape — `toolCallId` correlation, `input.command`, ACP
`tool_result` metadata — and mines a correction pair end to end from it.

**2. A second correlated message raced the record and won.** For any ACP call with rendered
output the visible `tool_result` (no `is_error`) was emitted *before* the `tool_outcome`, both
carrying the same correlation id. `extractToolInvocations` closes on the first match and
deletes the open entry, so the correct record would have been discarded as an orphan even
after fix 1.

*Fix:* the outcome now rides the message that already exists. `is_error` is set on the visible
ACP `tool_result` metadata, and the separate `tool_outcome` emit is removed from the ACP
adapter entirely. One correlated closing message, no race, fewer moving parts. Claude still
needs its invisible record because it deliberately emits no visible `tool_result` (LT-062).
`cancelled` sets no `is_error` at all, so the miner reads it as unobserved rather than as a
confirmed fix.

**3. LT-062 regression on the Replay & Share page (high).** `session-share-service.ts` builds
a bundle straight from `outputBuffer`/`conversation.messages` with no type filtering —
`sanitizeMessage` only redacts text — and `session-replay-page.component.ts:189` renders every
message in the bundle unconditionally, with the type as a badge and the content in a `<pre>`.
A Claude `tool_outcome` would have shown its raw error text on a routed, user-facing surface.

This directly falsified the reasoning in this plan's Decision section: "the four rendering
surfaces need no change and cannot regress LT-062". That holds only for surfaces that
allow-list message types. The replay page allow-lists nothing, and `tsc` could not catch it
because the page has no exhaustive switch.

*Fix:* `buildBundle()` filters with `isVisibleOutputMessage` — one central point covering both
entry points — with a regression test asserting a bundle never contains the record.

**4. Found while acting on the review, not reported by it.** `instance-context.ts`'s switch
over `message.type` has a `default:` arm that files unknown types as an `external` context
section. The record would have been fed into the model's own context, costing tokens and
adding noise. `tool_outcome` now returns early alongside `system`.

**Lesson recorded for the next change of this shape:** the compiler-enforcement argument only
covers consumers that switch exhaustively. Transcript *exporters* and fallthrough renderers
have to be found by reading, and the reviewer's advice — grep `OutputMessage\[\]` project-wide
rather than trusting a count of "rendering surfaces" — is the right method.

### Follow-on work after the round-1 fixes

Three further changes, two of them pre-empting questions the round-2 brief asks.

**Only the command is persisted, not all of `rawInput`.** The first version of the ACP
`tool_use` fix attached the whole `update.rawInput` to the message metadata. That is arbitrary
provider input — on a write or edit call it can be an entire file body — and it would have been
persisted into every archived transcript and exported in every share bundle. It now carries
`{ command }` alone, and only when that is a non-empty string.

**The logic moved to `acp-tool-call-material.ts`** as `buildAcpMinableInput()`, beside its
sibling `buildAcpToolCallArguments()`. That is its natural home, and it also settled a fight
with the LOC ratchet: `acp-cli-adapter.ts` had been sitting a handful of lines under its
ceiling, so each pass at this feature pushed it over and I was shaving comments to fit. The
file is now 2,372 lines and comfortably under, with the explanation living in the helper's
doc comment where there is room for it.

**The context exclusion is now tested.** `instance-context-tool-outcome.spec.ts` proves
`ingestToRLM` never files a `tool_outcome` as an RLM section, and — so the exclusion is not
over-broad — that an ordinary `tool_result` still is. Mutation-checked: removing the
`case 'tool_outcome': return;` arm fails the first test. Worth noting why this mattered:
`ingestToRLM` bails early on content under 20 characters, so a *successful* record (empty
content) was never at risk. Only a *failure* record, carrying up to 2,000 characters of error
text, would have reached the `default:` arm and been filed as an `external` context section.

## Independent review — round 2 also returned FAIL

A second fresh reviewer, not the round-1 one, found a worse defect than round 1 did. All three
findings were confirmed against source before acting.

**1. The live event-normalization layer relabelled the record as `assistant` (critical).**
Two functions normalize a provider event's message type:

- `toOutputMessageType()` — `src/main/providers/provider-output-event.ts`
- `normalizeOutputMessageType()` — `src/main/providers/adapter-runtime-event-bridge.ts`

Both switch over a loose `string`/`unknown` with `default: return 'assistant'`. Because the
parameter is not typed against `OutputMessage['type']`, **adding the union member produced no
compile error in either** — the exact enforcement this plan's Decision section relied on does
not reach them.

Every Claude `tool_outcome` travelling the live `provider:normalized-event` stream therefore
arrived downstream typed `assistant`, carrying up to 2,000 characters of raw tool-failure text:

- **Mobile, live.** `mobile-gateway-server.ts` derives the message via the mangling converter
  and only then calls `serializeMessage`, whose `tool_outcome` guard could never fire. Every
  connected device received an `instance-output` broadcast typed `assistant` containing the raw
  error. The *archived* mobile path was protected because it serializes the untouched archived
  message — that asymmetry between the live and archived paths is what exposed the bug.
- **Session continuity, persisted.** `instance-event-forwarding.ts` projected the mangled
  message into a continuity entry with `role: 'assistant'`, which the admission gate accepts and
  `SessionContinuityManager.addConversationEntry()` writes to disk. Durable corruption, not just
  a display glitch.

*Fix:* both switches now preserve `tool_outcome` explicitly, and
`instance-event-forwarding.ts` returns early for it so it never reaches continuity projection at
all. `provider-output-event-tool-outcome.spec.ts` covers preservation, that a genuinely unknown
type still defaults to `assistant`, and that the ordinary types are untouched. Mutation-checked.

**2. An exit-code-only ACP failure produced zero closing messages.** The visible `tool_result`
that round 1 moved `is_error` onto is wrapped in `if (renderedOutput)`. A terminal call with no
content and no `rawOutput` — a silent nonzero exit — emitted nothing, so the miner's open
invocation was never closed and the call was dropped rather than mined. This contradicted the
round-1 fix's own stated "exactly one correlated closing message" invariant, which held only
when there was output.

*Fix:* `buildAcpToolOutcomeFallback()` in `acp-tool-call-material.ts` supplies the invisible
record in exactly that case and returns null otherwise, so there is one closing message in every
combination and still no race. Tested across output/no-output and completed/failed/cancelled.

**3. Stale prose — the very failure mode this ticket exists to fix.** After round 1 moved
`is_error` onto ACP's visible `tool_result`, the miner's module header and inline comment still
said ACP emits a `tool_outcome`. Corrected in `correction-miner.ts` and its spec.

### What these two rounds actually taught

The Decision section's compiler-enforcement argument was over-claimed. Adding a union member
does force every switch that is *typed against the union* to handle it — but it says nothing
about:

- switches taking `string`/`unknown` with a `default` arm (findings round 2.1),
- fallthrough renderers that display anything not explicitly suppressed (round 1.3),
- transcript exporters that copy the array wholesale (round 1.3).

Each round found a boundary the previous had missed, and the misses were all of that same
shape. The reliable method is the one the round-1 reviewer recommended: grep for every consumer
of the message array and every normalization of a message type, and read them — do not infer
coverage from the type system.

### Verification after round 2

- Full suite: **1,994 files, 21,913 tests, exit 0**, confirmed by grep to include the new specs
  (an earlier run had globbed its file list before one was created, and passing without covering
  the change is not the same claim).
- `tsc --noEmit`, `tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run build:main`, `npm run build:renderer` all exit 0.
- Mutation checks: Claude emit, ACP emit, RLM ingestion exclusion, and normalization
  preservation each fail their tests when reverted.

## Independent review — round 3 also returned FAIL, and changed the approach

A third reviewer found two more live subscribers of `provider:normalized-event` copying the
record's content onward. Both confirmed against source.

**1. `ObservationIngestor` (high).** `observation-ingestor.ts` subscribes to the bus, converts
every envelope, and passes the result to `summarizeOutputMessage()` with **no type check at
all** — formatting up to 600 raw characters of content. That is captured to a ring buffer,
persisted to the RLM SQLite store, **embedded into the shared vector store** as a semantic-search
document, and rendered on the Observations page. It is on by default: `initialize()` runs
unconditionally at startup and `DEFAULT_OBSERVATION_CONFIG.enabled` is `true`.

**2. `PluginManager` (high).** `plugin-manager.ts` calls `toInstanceOutputPayloadFromEnvelope()`
— which filters nothing — and emits `instance.output` to every installed hook plugin *before*
any type-specific branching. Third-party plugin code received the complete, **untruncated**
content of every tool failure. Worse than the mobile leak in two ways: no truncation, and the
consumer is arbitrary user-installed code.

The reviewer confirmed `channel-message-router.ts` and `chat-transcript-bridge.ts` are safe,
both by allow-listing rather than by luck.

### The approach was wrong, and this is the fix

Three rounds found three different subscribers leaking the same record. Patching each one was
losing a race against the next. The record is now stopped at
`ProviderRuntimeEventBus.enqueue()` — the single point every subscriber is fed — so no current
or future subscriber can see it.

This is safe because the two paths are independent: the record reaches the correction miner
through `instance.outputBuffer`, populated in `instance-communication.ts`, which does not go
through this bus. Verified by the miner and adapter suites continuing to pass (245 tests), and
by a mutation check on the new guard.

The downstream guards added in rounds 1 and 2 — the mobile serializer, the share-bundle filter,
the continuity early-return, the RLM ingestion exclusion, the renderer suppression — are all
kept as defence in depth. They are cheap, tested, and each documents a real boundary.

**A false start worth recording.** The guard first went into `InstanceManager.publishOutput()`,
which is the natural-looking single publish point. That file sits *exactly* at its LOC ratchet
tolerance at HEAD (2,719 lines against a 2,669 ceiling and +50 tolerance), so any addition
breaks the gate. It was reverted to byte-identical with HEAD and the guard moved to the bus —
which is the better home regardless, since deciding what to broadcast is the bus's job.

**Correction to the review's third finding.** It reported the plan as missing a round-2 section.
The section existed; it was appended after that reviewer had already read the file. A timing
artifact, not a gap.

### The real lesson

The Decision section justified a new union member on the grounds that "the compiler enforces
it." That was true only for consumers typed against the union, and every one of the seven
defects across three rounds lived somewhere the compiler was silent: untyped switches with a
`default` arm, fallthrough renderers, wholesale array copies, and unfiltered event subscribers.

For a new message type on a shared bus, the reliable move is a single upstream guard at the
broadcast point from the outset, with per-consumer filters as defence in depth — not the other
way round.

### Verification after round 3

- Full suite: **1,995 files, 21,915 tests, exit 0**, grep-confirmed to include the new bus spec.
- `tsc --noEmit`, `tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run build:main`, `npm run build:renderer` — all exit 0.
- Mutation checks now cover five points: the Claude emit, the ACP fallback, the RLM ingestion
  exclusion, the normalization preservation, and the bus guard.

## Independent review — round 4 returned FAIL on a regression this work introduced

A fourth reviewer confirmed the round-3 approach change is correct and found one real defect,
caused by an earlier fix rather than by the original design.

**1. `maxSeq` under-reported on mobile resume (medium).** Making `serializeMessage()` return
`null` was the first time that function could ever return null. The line immediately below the
filter added for it, in `mobile-gateway-server.ts`, was pre-existing:

```js
const maxSeq = messages.length > 0 ? (firstIdx + messages.length - 1) : fromSeq;
```

That assumed `messages.length === sliced.length`, which held until a hidden record could be
dropped from the middle of a window. `MobileMessagesResumeDto.meta.maxSeq` is documented as "the
highest `seq` in this response", and each surviving DTO already carries its correct pre-filter
`seq` — only this aggregate was computed from a count.

Reproduced: a buffer of `[tool_use, tool_outcome, tool_use, tool_result]` resumed from seq 0
returns two visible messages with `seq` 2 and 3, but reported `maxSeq: 2`. A client honouring
that cursor re-requests from seq 2 and is redelivered the message at seq 3. Not a content leak —
the record's text still never reaches the device — but a genuine resume-cursor regression.

*Fix:* derive it from the last survivor's own `seq` (`messages.at(-1)?.seq ?? fromSeq`).
Mutation-checked: restoring the count-based form fails the new test.

**2. The sixth ACP combination was untested (low).** `cancelled` with no rendered output — the
one case that deliberately produces zero closing messages — had no test. Now covered, so all six
combinations of status × output are asserted.

### The question that mattered most, answered

Round 4 was asked specifically to check whether the round-3 bus guard had silently killed the
feature — because if `outputBuffer` were populated *from* the bus rather than independently of
it, the miner would receive nothing and every unit test would still pass.

It traced the path and confirmed the guard is not on it: `adapter.on('output', ...)` calls
`addToOutputBuffer()` (`instance-communication.ts`) **before** emitting to the bus, and
`acceptForBuffer()` (`instance-tool-result-processor.ts`) passes any non-`tool_result` type
through untouched. The record always reaches `instance.outputBuffer`, hence the archive, hence
`LearningScanService` and the miner. Verified by reading the code, not by trusting this document.

It also confirmed no bypass of the bus guard exists — `captureRawBackedEvent()`, the one direct
entry that skips `enqueue()`, is only ever reached for echoed `user` messages — and that
`context-attribution-service.ts`, `transcript-snippet-service.ts`, `compaction-preview.ts` and
`output-storage.ts` all exclude the record by allow-listing.

### Two notes from the fixes

TypeScript rejected one of the new assertions as provably impossible: `MobileMessageDto['type']`
does not include `tool_outcome`, so the DTO cannot carry one. The runtime check was removed — the
type is the stronger guarantee, and asserting something the compiler already forbids is noise.

`mobile-gateway-server.ts` is the third file in this change found sitting at its LOC ratchet
tolerance. A comment was trimmed rather than the ceiling raised.

### Verification after round 4

- Full suite: **1,995 files, 21,916 tests, exit 0**.
- `tsc --noEmit`, `tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run build:main`, `npm run build:renderer` — all exit 0.
- Mutation checks now cover six points: the Claude emit, the ACP fallback, the RLM ingestion
  exclusion, the normalization preservation, the bus guard, and the `maxSeq` derivation.

## Round 5 returned FAIL, and the architecture was replaced (James chose this)

Round 5 found `get_child_output` — a tool the codebase actively instructs models to use — reading
a child's `outputBuffer` unfiltered and injecting `[tool_outcome] <raw error text>` into the
**requesting parent agent's live conversation**. Also the child diagnostic bundle, which goes to
third-party plugin code and renders verbatim in a modal.

Those were fixed, and an audit of every `outputBuffer` reader found three more genuinely risky
ones (child transcript storage, automation output chunks, parent→child buffer seeding) plus six
already safe by allow-listing.

But that was the fifth leak of the same shape in five rounds, and roughly twenty direct readers
exist. The conclusion put to James was that patching consumers would not converge, with a
recommendation to redesign. He chose the redesign.

### The new design

**The record never enters `outputBuffer`.** It is intercepted in the adapter `output` handler
(`instance-communication.ts`) and returned early, so it reaches neither the buffer, nor disk
output storage (fed only by buffer overflow), nor the provider event bus.

It is held in `src/main/learning/tool-outcome-store.ts` — a module-level map keyed by instance —
and merged into the transcript at exactly one place: `HistoryManager.getCompleteArchiveMessages()`,
the assembly the miner later reads back through `loadConversation()`.

Two deliberate choices:

- **Not a field on `Instance`.** A field there would flow into DTOs, serializers and persistence
  snapshots, recreating the same accidental-exposure class this exists to end. A module-level
  store cannot be serialised by accident.
- **The per-consumer guards from rounds 1–5 are kept**, though most are now unreachable. The
  *archive* still contains the record, and several of those functions are called with archived
  messages on some paths. Deciding which are genuinely dead needs per-site analysis that would
  likely be partly wrong, and being wrong reintroduces a leak.

Every `outputBuffer` consumer is now safe by construction rather than by vigilance, and no future
consumer can regress it.

### A lifecycle defect found while building it, before review

`clearToolOutcomes` was wired into `cleanupCircuitBreaker`, which turns out to be reachable only
from the **continuity-recovery** path — not ordinary teardown. Archiving was unaffected (the
records were still present when needed), but the store leaked one entry per instance for the
application's lifetime.

Fixed twice over, deliberately:

- `archiveInstance()` clears the instance's records immediately after folding them in — the
  natural end of their purpose.
- The store caps tracked instances (`MAX_TRACKED_INSTANCES`, oldest evicted first) as a backstop
  that does not depend on any call site remembering. That matters: the call site *did* forget.

### Verification

- Focused suites across `learning/`, `history/` and `instance/`: **149 files, 1,887 tests, exit 0**.
- `tsc --noEmit`, `npm run lint`, `npm run build:main`, `npm run build:renderer` clean.
- `npm run check:ts-max-loc` reports one breach, `mobile-gateway-server.ts`, caused jointly by a
  concurrent session's device-revocation feature and ~6 lines from this change. This work's
  footprint there was minimised; the rest is not ours to trim.
- Remaining `tsc -p tsconfig.spec.json` errors are all in another session's in-progress
  `settings-tiering` work.

### The ratchet as a signal

This change hit the LOC ratchet on five separate files. That is not five coincidences — it is the
gate correctly observing that a "P2 correction-miner fix" was touching a great many large, central
files. It was a useful signal even where it was inconvenient, and it is part of why the original
design deserved more scepticism than it got.

## Round 6 returned FAIL: the round-5 redesign had never been reviewed (2026-09-13)

Picked up on 2026-09-13. The round-5 code was already in HEAD, but no reviewer had seen it. An
implementer self-review came first and found two defects before any fresh review ran:

- **Restore reopened every buffer leak.** `getMessagesForRestoreTranscript()` passed archived
  records straight into a restored instance's `initialOutputBuffer` (both native-resume and
  replay-fallback rungs) and into the continuity preamble's unresolved-items scan. The store
  architecture only protects a buffer the adapter fills. It does nothing for a buffer seeded from
  the archive. *Fix:* the helper excludes the record, and `reseedToolOutcomes()` in
  `history-restore-coordinator.ts` puts the archived records into the restored instance's side
  store. That second step is required because re-archiving a restored thread overwrites the same
  history entry, so dropping the records would have erased the signal on the next archive.
- **Children churned the instance cap.** `archiveRootConversation` skips child instances, so their
  records were never cleared. A loop spawning more than `MAX_TRACKED_INSTANCES` (50) tool-using
  children evicted the long-running root session's records before it archived. *Fix:*
  `instance-communication.ts` does not record for an instance with a `parentId`, and
  `instance-termination.ts` clears the store at the end of every terminate. That also covers
  archives skipped as already-archived or already-covered.

The fresh round-6 reviewer confirmed both fixes and returned FAIL on two more:

1. **History view leak (critical).** `HISTORY_LOAD` returned the raw archive, and
   `history-item.component.ts` renders every message verbatim with its type as the role label.
   Expanding any history entry showed `tool_outcome` plus raw failure text. *Fix:* the IPC handler
   strips the record, which covers every renderer consumer of that channel.
2. **Restart snapshot lost its records (high).** `archiveRestartSnapshot` archives under a
   synthetic id, and archive assembly looks records up by instance id, so it found none. *Fix:* the
   live instance's records are carried into the snapshot's buffer. That buffer is never live, and
   the live instance keeps its records for its own final archive.

## Round 7 fixes, and two defects found while making them

Tracing the other archive→live copy paths while fixing round 6 turned up the worst defect of the
whole ticket:

- **Crash recovery could not recover any archive holding the record.** `continuity-revival.ts`
  validates every archived message against `OUTPUT_MESSAGE_TYPES`, an untyped `Set` that lacked
  `tool_outcome`. From round 5 onward, recovering an archived Claude session with a single tool
  call threw a validation error. The same function also seeded archived records into the
  replacement's live buffer. *Fix:* the allow-list is now exhaustive via
  `satisfies Record<OutputMessage['type'], true>`, so the next new union member fails to compile
  instead of failing silently. The buffer is filtered, and the replacement's side store is
  re-seeded.
- **History coverage never counted such an archive.** `history-recovery-coverage.ts` had the same
  untyped allow-list, so an archive holding a record was treated as unverified. That affects the
  archive dedupe and recovery-candidate discovery. Same exhaustive fix.
- The stale header in `src/shared/types/tool-outcome.ts` ("rides the existing archive pipeline
  unchanged") now describes the store and the archive→live filters.

A fresh round-7 reviewer (not the round-6 one) re-hunted every archived-conversation reader and
every hard-coded message-type list, and returned **VERDICT: PASS** with no blocking findings. It
also traced native Claude transcript repair (`native-claude-archive-repair.ts`). That path
rebuilds tool results as visible `tool_result` messages carrying `is_error`, so repair loses no
signal. Whether those rebuilt visible messages sit uneasily with LT-062 is a pre-existing question
outside this ticket.

### Mutation checks added in rounds 6–7

Each guard was reverted on its own and its test watched to fail, then restored: restore-transcript
filter (3 tests), restore re-seed (2), child-recording guard, terminate-time clear, `HISTORY_LOAD`
filter, restart-snapshot carry, crash-recovery allow-list, crash-recovery buffer filter,
crash-recovery re-seed, and coverage allow-list.

### Verification after round 7

- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main` and `npm run build:renderer` all exit 0.
- Full suite: **24,450 of 24,452 passed** (`_scratch/test-run.lt196p.log`). Both failures are in
  another session's in-progress work that this change never touched:
  `wake-buffer-restore.spec.ts`, whose source and spec were being edited during the run, and
  `acp-cli-adapter.spec.ts`, whose source has another session's uncommitted edits and which passes
  75/75 on an immediate rerun. The previous full run hit one timing flake,
  `hyde-service-fallback.spec.ts` at 84 ms against a 75 ms budget, which passes in isolation.
- New specs: `history/__tests__/history-restore-tool-outcome.spec.ts` and
  `instance/lifecycle/continuity-revival-tool-outcome.spec.ts`, plus new cases in
  `history-restore-helpers.spec.ts`, `instance-communication.spec.ts`,
  `lifecycle/__tests__/instance-termination.spec.ts`,
  `lifecycle/__tests__/restart-policy-helpers.spec.ts`, `history-recovery-coverage.spec.ts` and
  `ipc/handlers/__tests__/session-handlers.spec.ts`.
- Added at close-out: a `learning-scan-service.spec.ts` test that runs `runScan()` over a
  Claude-shaped `tool_outcome` transcript (mines 1 pattern) and a clean session (reports 0, no
  error). It fails when the miner's `tool_outcome` branch is removed. Before this, spec criterion
  6 had only miner-level coverage, not service-level.

### Deferred live checks

Spec acceptance criteria 1 and 2, plus a new check 3 for the history view, restore→re-archive and
crash-recovery paths, need a rebuilt app and real provider traffic. They are recorded in
[`2026-09-06-lt196-correction-miner_livetest.md`](./2026-09-06-lt196-correction-miner_livetest.md)
and are **not** claimed as verified.

### Known limitation, accepted

Records live in memory until archive. If the app crashes before a session archives, orphan
recovery archives that session without its records, so a scan misses that session's corrections.
More than 50 concurrent root sessions with tool activity would also evict the oldest one's
records. Neither leaks anything, and the miner falls back to exactly its pre-LT-196 behaviour.
