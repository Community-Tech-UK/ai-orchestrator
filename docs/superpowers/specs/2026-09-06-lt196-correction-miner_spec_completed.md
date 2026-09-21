# LT-196: Correction-miner outcome-signal specification

**Date:** 2026-09-06
**Status:** Completed 2026-09-13. Implementation plan:
[`2026-09-06-lt196-correction-miner_plan_completed.md`](../plans/2026-09-06-lt196-correction-miner_plan_completed.md).
The plan resolved this spec's one deferred implementation choice in favour of a new
`OutputMessage.type` member. Criteria 1–2 await live checks in
[`2026-09-06-lt196-correction-miner_livetest.md`](../plans/2026-09-06-lt196-correction-miner_livetest.md).
**Register entry:** [`docs/plans/livetest-remediation-register.md` — LT-196](../../plans/livetest-remediation-register.md#lt-196-scan-for-corrections-learning-scan-is-structurally-non-functional-for-claude-sessions)

## Problem

"Scan for corrections" (the Memory Review page's manual-trigger button,
`memory-review-page.component.ts:39-41`, backed by `LearningScanService.runScan()`,
`learning-scan-service.ts:166`) is supposed to read a user's past terminated sessions, find
command-failed-then-corrected patterns, and raise a reviewable "rule" proposal so the lesson can be
reused. Run against a real workspace with a genuine failure-then-fix pattern in its history, it
always reports `patternsFound: 0, proposalsCreated: 0` with no error — silence, not a visible defect.

### Root cause, verified by reading the executing code, not by trusting prior write-ups

`LearningScanService.runScan()` only ever calls `this.history.loadConversation(entry.id)`
(`learning-scan-service.ts:192`) and mines the returned, already-archived `OutputMessage[]`
transcript (`learning-scan-service.ts:194`, `mineCorrections(data.messages.map(toMinableMessage))`).
It never touches a live event stream. `correction-miner.ts`'s `extractToolInvocations()` pairs
`type: 'tool_use'`/`type: 'tool_result'` messages by correlation id and reads
`metadata['is_error']` as a strict boolean (`correction-miner.ts:107-110`, `extractIsError()`).
`findCorrectionPairs()`'s very first gate then discards anything whose `isError` came back anything
other than `true` (`correction-miner.ts:297`, `if (failInv.isError !== true) continue;`). So the
miner is entirely dependent on the archived transcript containing a `tool_result` message with a real
`is_error` boolean for every tool call.

**Claude never writes that message for an ordinary call.** The real Claude CLI's NDJSON stream
carries tool activity nested inside `assistant`/`user` envelopes as content blocks
(`claude-cli-adapter.types.ts:14-40`, `RawCliPayload`/`RawContentBlock`, whose own comment says "the
typed `CliStreamMessage` union is minimal — the actual CLI emits richer payloads"). The adapter's
`case 'user':` branch (`claude-cli-adapter.ts:1270-1300`) is what actually parses a tool result out
of that envelope, and its own LT-062 comment (`claude-cli-adapter.ts:1281-1284`) states plainly that
an ordinary tool success or failure is now raw-emitted only on the internal `'tool_result'`
`EventEmitter` channel (`claude-cli-adapter.ts:1294-1299`) — never as a visible `'output'`
`OutputMessage` — except on the permission-denial branch, which itself only ever emits a `'system'`
message (`claude-cli-adapter.ts:1373-1379`), never a `tool_result`-typed one. The adapter's own test
suite asserts this directly: `claude-cli-adapter.spec.ts:843-869` feeds an ordinary successful
tool_result through `processCliMessage` and asserts
`expect(outputs.some((o) => o.type === 'tool_result')).toBe(false)`. This independently confirms the
register's own live reproduction (a Node-inspector read of `HistoryManager.loadConversation()` for a
real session found zero `tool_result` entries, only `tool_use`/`assistant`/`user`).

There is a `case 'tool_use':`/`case 'tool_result':` switch branch later in the same file
(`claude-cli-adapter.ts:1539-1583`) that *would* construct a fully populated, `is_error`-bearing
`OutputMessage` — but it matches the shape of the old, minimal `CliToolResultMessage` type
(`shared/types/cli.types.ts:59-64`: `tool_use_id`/`content`/`is_error` directly on the message), not
the real CLI's nested-content-block envelope the `case 'user':` branch actually parses. It is
exercised only by hand-constructed unit tests that synthesize that flat legacy shape directly
(`claude-cli-adapter.spec.ts:242-252`) — nothing in the real NDJSON parsing path (`ndjson-parser.ts`,
which passes the CLI's own `type` field straight through) produces it from genuine CLI output today.

### Correction to the register: this is not Claude-only

The register's LT-196 entry states the miner's own survey ("`is_error` … on Claude, ACP, Codex-exec,
Cursor, and Copilot adapters") "was true when written" and was invalidated "for Claude specifically."
That is not accurate for the live instance-spawn path today. Real instance creation goes through
`ProviderRuntimeService.createAdapter()` (`provider-runtime-service.ts:61-79`, `75`, importing
`createAdapter` from `adapter-factory.ts`), reached from `InstanceSpawner`
(`instance-spawner.ts:61`, `this.deps.createAdapter(config)`). For `cliType === 'copilot'`/`'cursor'`/
`'grok'`, `adapter-factory.ts`'s dispatch (`adapter-factory.ts:715-722`) always constructs
`new AcpCliAdapter(...)` (`adapter-factory.ts:399`, `481`, `564`). `AcpCliAdapter`'s own
`handleToolCallDelta()` (`acp-cli-adapter.ts:1469-1519`) emits the `tool_result` `OutputMessage` that
actually reaches the archived transcript for these providers, and its metadata is
`{ sessionUpdate, toolCallId, title, status, transport: 'acp' }` (`acp-cli-adapter.ts:1500-1506`) —
**no `is_error` key at all**, only a `status` string (`'completed' | 'failed' | 'cancelled'`).
`extractIsError()` reads only `metadata['is_error']`, so it returns `null` for every ACP tool_result
too, and the miner discards them identically to Claude's.

Separate `CopilotCliAdapter`/`CursorCliAdapter` classes do correctly emit `is_error`
(`copilot-cli-adapter.ts:503`, `cursor-cli-adapter.ts:787`), which is presumably what the original
survey inspected — but those classes are wired only into model-listing/discovery/probing call sites
(`mobile-gateway-model-handlers.ts:220,224`; `cursor-copilot-cli-discovery-service.ts:31,33`;
`create-validation-helpers.ts:36,49`; `cli-verification-ipc-handler.ts:346,382,396`;
`copilot-cli-provider.ts:102,160`; `cursor-cli-provider.ts:99,135`), never the live conversation-spawn
path traced above. No test in `correction-miner.spec.ts` exercises an ACP-shaped (`status`-only,
no `is_error`) tool_result — confirmed by reading the whole file.

**Net effect: the miner is structurally non-functional for Claude, Copilot, Cursor, and Grok — every
provider except Codex.** Codex's real app-server path (`codex-notification-item-events.ts:230, 273,
304, 318, 331`) does set `is_error` correctly for Bash/Edit/mcpToolCall/dynamicToolCall/webSearch
results, so Codex sessions are minable today. Antigravity (the live target when a user picks
"Gemini" — `adapter-factory.ts`'s own comment notes `resolveCliType` maps gemini→antigravity) never
emits a `tool_result` message at all; that is a separate, already-documented, deliberately-accepted
gap (`antigravity-cli-adapter.ts:1-31`) unrelated to this fix and out of scope here.

### What the feature is supposed to do, in plain language

When a user (or an agent working on their behalf) runs a command that fails and then runs a
corrected version of the same command, AIO should be able to notice that pattern across past
sessions and propose a reusable "if you see this error with this command, try this fix" rule. The
user reviews and approves or rejects each proposal from the Memory Review page; nothing is
auto-applied. Today this never finds anything, for every real provider except Codex, with no
indication to the user that anything is wrong — "0 sessions had a minable signal" and "0 corrections
in an otherwise-normal history" are indistinguishable in the UI.

## Architectural options

The register already named the shape of the fork correctly; this section resolves it with evidence
that was not available when it was filed.

**(a) Persist a lightweight, transcript-invisible outcome record at capture time, at the point in
each adapter where the real `is_error`/`status` value is already known**, tagged so the renderer
never turns it into a chat bubble. Concretely: alongside its narrower existing emit, each adapter's
true tool-result-parsing site (Claude's `case 'user':` content-block loop; `AcpCliAdapter`'s
`handleToolCallDelta`) also writes one more `OutputMessage` — of a new type (e.g. `tool_outcome`) or
the existing `tool_result` type carrying an explicit `metadata.hiddenFromTranscript: true` flag —
with `{ tool_use_id/toolCallId, command/input, is_error }` populated from data the adapter already
has in hand. The renderer's message-rendering switch is taught to skip it, exactly as it already
skips other internal-only message shapes. `HistoryManager.archiveInstance()`/`loadConversation()`
need no changes at all — they already persist and return the full `OutputMessage[]` verbatim
(`history-manager.ts:133,139`, `getCompleteArchiveMessages`/`createArchiveInstanceSummary`, no
per-type filtering). `LearningScanService` needs no changes either. Only `correction-miner.ts`'s
`extractToolInvocations()` needs to recognize the new type/flag, and each affected adapter needs the
one new emit at its already-existing is_error/status computation site.

**(b) Feed the miner from the raw `'tool_result'` `EventEmitter` events the adapters already emit
live** (the channel the register describes as an existing asset for this purpose). Verified this is
not actually usable as-is: `CliToolCall`, the type every raw `tool_use`/`tool_result` event carries
(`base-cli-adapter.types.ts:171-176`), has no error/success field of any kind — just
`{ id, name, arguments, result? }`. The one place that turns this raw event into a
`ProviderRuntimeEvent` for the (unrelated) doom-loop detector, `bindRawAdapterProviderEvents()`
(`instance-communication-provider-events.ts:45-58`), **hardcodes `success: true` unconditionally**
(line 53) regardless of whether the tool actually failed. That lane's own module doc
(`instance-tool-loop-wiring.ts:19-35`) also notes several adapters' raw tool events "carry no
correlation id at all." So this channel does not currently carry the signal the miner needs for any
provider, has no persistence of its own (it is consumed live and discarded), and would need
essentially the same per-adapter plumbing work as option (a) just to add the missing signal — with
none of option (a)'s reuse of the existing, already-tested archive/read pipeline.

### Recommendation: (a)

Pick (a). The reasoning:

1. **The signal already exists at the right place for free.** Claude's `case 'user':` loop already
   computes `block.is_error === true` two lines above the existing raw emit
   (`claude-cli-adapter.ts:1291`, `1304-1305`); `AcpCliAdapter.handleToolCallDelta` already computes
   `status` per call. Capturing it is a one-line addition at an already-correct source of truth, not
   new business logic.
2. **(b) is not "already emitted" for this purpose** — it is provably a doom-loop-only signal today
   (`success: true` hardcoded, no error field on the type), so choosing it would mean building the
   same missing plumbing (a) needs anyway, on top of a channel this codebase's own comments describe
   as narrower and less complete (missing correlation ids on some providers) than the archived
   transcript path.
3. **(a) reuses tested, working infrastructure.** `HistoryManager`'s archive/load round-trip and
   `LearningScanService`'s orchestration are both already correct and already covered by tests; only
   the two narrow points (adapter emit, miner extraction) change.
4. **(a) closes the newly-found ACP gap in the same motion**, because the fix shape (capture
   `is_error` at each adapter's true source, write an invisible record) is identical for Claude and
   for `AcpCliAdapter` — it is not two separate fixes.
5. **(a) keeps LT-062's transcript-hygiene guarantee mechanically enforced**, not just documented:
   the new record is a distinct type/flag the renderer explicitly ignores, so there is no risk of
   silently reintroducing the tool-noise LT-062 removed, the way a broader "just always emit
   `tool_result`" revert would.

## What would need to change, by area

- **Main process — CLI adapters.** `claude-cli-adapter.ts`'s `case 'user':` tool_result branch
  (`claude-cli-adapter.ts:1285-1300`) gains one additional emit of the new invisible outcome record.
  `acp-cli-adapter.ts`'s `handleToolCallDelta()` (`acp-cli-adapter.ts:1469-1519`) gains the same,
  deriving `is_error` from `status === 'failed'`. Whether Codex's already-working path
  (`codex-notification-item-events.ts`) also gets migrated to the new shape, or is left as-is since
  it already works, is an implementation-time call — leaving it alone is lower-risk and sufficient to
  meet the acceptance criteria below.
- **Main process — correction miner.** `correction-miner.ts`'s `extractToolInvocations()` needs to
  recognize the new outcome-record type/flag as a source of `isError`/`command`, either instead of or
  in addition to the current `tool_use`/`tool_result` pairing. The existing pairing, exploration-
  command exclusion, TDD red-green exclusion, and confidence-scoring logic should not need to change
  — this is purely a change to how one input (`isError`) gets populated per invocation.
- **Persistence.** No new database, table, or file format is required under the recommended design —
  the new record rides the existing `OutputMessage[]`/`HistoryManager` archive pipeline
  unchanged. This is a load-bearing reason to prefer (a); confirm during planning that no consumer of
  the archived transcript other than the renderer needs to be taught to ignore the new type (e.g. any
  transcript exporter or context-evidence reader that iterates all `OutputMessage`s unconditionally).
- **Renderer.** The chat-transcript rendering path needs the new outcome-record type/flag added to
  whatever list of "don't render as a chat bubble" message shapes it already maintains. No other
  renderer change is required — the Memory Review page, its scan button, and the governed-proposal
  approve/edit/reject flow are already independently verified working per the register's own scope
  note and need no changes here.

### Open question this spec deliberately does not resolve

Whether the new outcome record should be a brand-new `OutputMessage.type` (cleanest, but touches the
`OutputMessage` type union and every exhaustive switch over it) or the existing `'tool_result'` type
with a new `metadata.hiddenFromTranscript`-style flag (smaller diff, but relies on every renderer
switch remembering to check the flag) is an implementation choice, not a product one. Both satisfy
this spec's acceptance criteria; the planning step should pick based on how many existing switches
over `OutputMessage.type` would need touching either way, which this spec has not exhaustively
counted.

## Out of scope

- Antigravity's total absence of `tool_result` emission (a separate, already-documented, deliberately
  accepted gap — see `antigravity-cli-adapter.ts`'s own header comment).
- Gemini (retired; `resolveCliType` no longer routes real traffic to it).
- Broadening or fixing the live raw `'tool_result'` event's hardcoded `success: true`
  (`instance-communication-provider-events.ts:53`) for the doom-loop detector's own purposes — that
  detector already works correctly for what it currently measures (call repetition, not outcome), and
  changing it is a different feature with its own risk surface.
- Any change to the Memory Review inbox's approve/edit-approve/reject/persistence behaviour, which is
  already independently verified working.
- Redesigning the miner's false-positive filters (exploration commands, TDD red-green, error
  classification patterns, confidence scoring) — none of that logic is implicated by this defect.
- Backfilling historical sessions archived before this fix ships. Those transcripts genuinely lack
  the signal; a scan over them will correctly continue to find nothing, exactly as today, which is
  not a regression.

## Acceptance criteria

1. Running "Scan for corrections" against a real Claude session containing a genuine
   command-failure-then-correction pattern (the `grep --bogus-flag` → corrected `grep` shape already
   used in the register's live reproduction) reports `patternsFound >= 1` and creates a governed rule
   proposal.
2. The same scenario, reproduced on a real Copilot, Cursor, or Grok session, also reports
   `patternsFound >= 1` — closing the ACP gap found in this spec, not just the originally-filed
   Claude one.
3. `correction-miner.spec.ts`'s existing tests (pairing, exploration exclusion, TDD red-green
   exclusion, confidence scoring, error classification) pass unchanged — the fix does not alter mining
   logic, only what feeds it.
4. A regression test proves LT-062's transcript-hygiene guarantee still holds: an ordinary successful
   or failing tool call still produces no *visible* `tool_result`-typed chat message for Claude (the
   existing `claude-cli-adapter.spec.ts:843-869` assertion, or its direct equivalent, still passes).
5. New adapter-level tests prove the invisible outcome record is written with the correct `is_error`
   for both a Claude `case 'user':` tool_result and an ACP `handleToolCallDelta` completion/failure,
   mutation-checked by reverting the new emit and watching the corresponding test fail.
6. `runScan()` on a workspace/session with no genuine correction pattern still reports
   `patternsFound: 0` with no error — the happy-path/no-signal behaviour is unchanged.
7. Canonical project verification checklist passes: both `tsc --noEmit` invocations, `npm run lint`,
   `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and `npm run
   test:quiet`.

## As-built and verification

Implemented as direction (a), with one departure from this spec's Persistence section: the record
does **not** ride `outputBuffer`. Five review rounds found the record leaking wherever a buffer
reader forgot to filter, so it is held in `src/main/learning/tool-outcome-store.ts` and folded into
the archive only at `HistoryManager.getCompleteArchiveMessages()`. Paths that copy an archive back
into a live instance (history restore, crash recovery) filter it out and re-seed the store, and
`HISTORY_LOAD` strips it before the renderer. ACP carries `is_error` on its own visible
`tool_result`, and uses the record only for a terminal call with no output. Codex is unchanged. The
full history, including all seven review rounds, is in the plan.

Against the acceptance criteria:

1. Real Claude scan — **deferred** to the livetest doc (needs a rebuilt app and provider traffic).
2. Real ACP scan — **deferred** to the livetest doc.
3. Existing `correction-miner.spec.ts` cases pass unchanged — verified.
4. LT-062 hygiene — verified: no visible Claude `tool_result`, and the record is excluded from
   every rendered, exported, broadcast and model-context path found across the review rounds.
5. Adapter-level tests for Claude and ACP, mutation-checked — verified.
6. No-signal scan still reports `patternsFound: 0` with no error — verified by a `runScan()` test
   in `learning-scan-service.spec.ts`. The same test mines a Claude-shaped `tool_outcome`
   transcript to `patternsFound: 1`, mutation-checked against the miner's `tool_outcome` branch.
7. Canonical checklist — typecheck (both configs), lint, LOC ratchet, `build:main` and
   `build:renderer` all exit 0. The full suite passed apart from two failures in another session's
   concurrent, unrelated work, recorded in the plan.
