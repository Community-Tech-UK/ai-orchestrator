# Codex Context Pressure Logging and Discovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit or push unless James explicitly asks.

**Goal:** Produce a content-safe, evidence-backed explanation of why one apparently small Codex ticket drove a session from 22,380 to 242,865 tokens, without changing context-management behavior.

**Architecture:** Add an opt-in, numeric-only diagnostic collector at the Codex app-server notification boundary, then correlate its records with the already-captured normalized provider events and a read-only structural analysis of the Codex rollout. Start with offline forensics. Run a bounded live reproduction only when the offline evidence cannot distinguish the remaining hypotheses. Finish with a findings document that separates observed facts, inferences, unknowns, and recommendations for a later implementation plan.

**Tech Stack:** TypeScript, Node/Electron structured logging, Codex app-server JSON-RPC, conversation-ledger provider captures, Codex rollout JSONL, Vitest.

## Global Constraints

- This is a logging and discovery phase. It must not add tool-output caps, provider config overrides, steering, interrupts, automatic compaction, retry/resume behavior, new context thresholds, capability migrations, or renderer policy changes.
- Preserve the current calculation and event flow while measuring them. Characterization tests may lock current behavior, but must not silently redefine it.
- Diagnostics are off by default and enabled only with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1` in a development/rebuilt process.
- Diagnostic records contain only numbers, booleans, bounded enums, timestamps, sequence numbers, one-way correlation hashes, and `null` for unavailable numeric fields. Never log prompts, assistant text, reasoning, commands, tool inputs or outputs, file paths, URLs, queries, raw provider payloads, thread IDs, turn IDs, item IDs, environment values, or credentials.
- Measure payload sizes without retaining measured strings. A diagnostic object must not hold a reference to a raw `ThreadItem`, notification, command, output, or prompt after the recording call returns.
- Treat `last.totalTokens`, `total.totalTokens`, cached input, tool payload bytes, and serialized rollout bytes as different measurements. Correlation is not proof that one measurement caused another.
- Reuse the existing structured logger and centralized redaction. Do not create a second unrotated log sink.
- Reuse the existing provider-event capture service as a read-only evidence source. The current dirty-tree changes in `provider-event-capture-service.ts` and its spec are unrelated work and must not be modified by this plan.
- Analyze existing rollouts and SQLite captures read-only. Generated evidence goes under `_scratch/codex-context-pressure/` until the final sanitized Markdown findings document is written.
- Do not reproduce a 94% context session. Any live reproduction stops at 35% current-window occupancy, 10 completed root tool items, or three post-baseline token-usage updates, whichever comes first.
- Do not copy the original ticket, rollout content, provider capture bodies, or user messages into tests, fixtures, logs, reports, or review artifacts.
- Preserve unrelated dirty-tree work. No commit or push without explicit instruction.

---

## What is known before this plan

These are code-level observations, not the final incident diagnosis:

1. `CodexCliAdapter` currently derives app-server occupancy from `tokenUsage.last.totalTokens` and lifetime processing from `tokenUsage.total.totalTokens`.
2. The incident values `242,865 / 258,400` calculate to approximately 94%, so the displayed percentage is arithmetically consistent if those were the raw provider fields received for the final model request.
3. `turn/completed.usage.input_tokens` is deliberately not used as app-server occupancy because it aggregates internal model calls.
4. `thread/compacted` currently resets AIO's cached occupancy to an estimated zero; `compactContext()` currently reports success after the start RPC is accepted rather than after the notification is observed.
5. The normalized provider-event stream is already durably captured in the conversation ledger, but it does not preserve every raw app-server notification or enough per-item size/timing data to reconstruct the incident conclusively.
6. AIO-visible transcript output and Codex's model-visible stored history are different surfaces. Measuring AIO output bytes alone cannot prove what Codex retained.

## Questions this plan must answer

1. Did the raw final `thread/tokenUsage/updated` notification actually contain `last.totalTokens = 242,865` and `modelContextWindow = 258,400`, or did the value change during parsing, bridging, persistence, or rendering?
2. What was the ordered sequence of per-request `last` usage values during the turn, and at which request boundary did the large increase occur?
3. How much root-tool payload was structurally observable between usage updates, broken down by command, MCP, dynamic, web, file-change, collaboration, and other item classes?
4. Did the rollout structurally retain large tool-result bodies, or did lifetime/cached processing grow while current-window occupancy stayed stable?
5. Was native compaction requested, reported, missed by AIO, or never eligible at a provider request boundary during the turn?
6. How much context existed before the ticket began, including system instructions and prior turns?
7. Which conclusions are proven by captured fields, which are correlations, and which still require a controlled live reproduction?

---

### Task 1: Lock the Current Math and Define a Content-Free Diagnostic Contract

**Files:**

- Create: `src/main/cli/adapters/codex/context-pressure-diagnostics.ts`
- Create: `src/main/cli/adapters/codex/context-pressure-diagnostics.spec.ts`
- Test: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`

**Interfaces:**

```ts
export type CodexObservedItemClass =
  | 'command'
  | 'mcp'
  | 'dynamic'
  | 'web'
  | 'file-change'
  | 'collaboration'
  | 'agent-message'
  | 'reasoning'
  | 'other';

export interface CodexTokenUsageSnapshot {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export type CodexContextDiagnosticRecord =
  | { kind: 'transport-usage'; schemaVersion: 1; at: number; transportSequence: number; threadCorrelation: string; contextWindow: number | null; last: CodexTokenUsageSnapshot; cumulative: CodexTokenUsageSnapshot }
  | { kind: 'transport-compaction'; schemaVersion: 1; at: number; transportSequence: number; threadCorrelation: string }
  | { kind: 'turn-start'; schemaVersion: 1; at: number; turnSequence: number; baselineUsedTokens: number | null }
  | { kind: 'item-completed'; schemaVersion: 1; at: number; turnSequence: number; itemSequence: number; itemClass: CodexObservedItemClass; rootThread: boolean; observedPayloadBytes: number; serializedItemBytes: number }
  | { kind: 'token-usage'; schemaVersion: 1; at: number; turnSequence: number; requestSequence: number; contextWindow: number | null; last: CodexTokenUsageSnapshot; cumulative: CodexTokenUsageSnapshot; previousLastTotalTokens: number | null; lastTotalDelta: number | null; cumulativeTotalDelta: number | null; occupancyPercentage: number | null; rootItemsSincePreviousUsage: number; observedPayloadBytesSincePreviousUsage: number }
  | { kind: 'compaction-rpc'; schemaVersion: 1; at: number; turnSequence: number | null; stage: 'requested' | 'accepted' | 'failed'; lastKnownUsedTokens: number | null }
  | { kind: 'compaction-observed'; schemaVersion: 1; at: number; turnSequence: number | null; requestSequence: number | null; lastKnownUsedTokens: number | null }
  | { kind: 'turn-complete'; schemaVersion: 1; at: number; turnSequence: number; requestSequence: number; rootItems: number; subagentItems: number; observedPayloadBytes: number; peakUsedTokens: number | null; peakPercentage: number | null; compactionsObserved: number; completionStatus: 'completed' | 'interrupted' | 'failed' | 'unknown' };

export interface CodexContextDiagnosticSink {
  write(record: CodexContextDiagnosticRecord): void;
}
```

The production sink writes one structured `info` entry to the existing `CodexContextDiagnostics` logger subsystem. Because the entire collector is gated by the opt-in environment flag, this remains silent during ordinary runs while reliably reaching the default log level during an investigation. The pure collector receives a sink and clock in its constructor so tests never touch Electron or disk.

- [ ] **Step 1: Add characterization tests for the incident arithmetic**

Feed the current parser a synthetic notification containing:

```ts
last: {
  totalTokens: 242_865,
  inputTokens: 242_356,
  cachedInputTokens: 241_408,
  outputTokens: 509,
  reasoningOutputTokens: 301,
},
total: {
  totalTokens: 18_910_442,
  inputTokens: 18_885_729,
  cachedInputTokens: 18_555_136,
  outputTokens: 24_713,
  reasoningOutputTokens: 10_153,
},
modelContextWindow: 258_400,
```

Assert that the emitted context event uses `242_865` as `used`, `258_400` as `total`, approximately `93.9880` as the unclamped percentage, and `18_910_442` only as cumulative processing. Add the snake_case equivalent. These tests characterize the current mapping; do not add new renderer fields in this plan.

- [ ] **Step 2: Write failing collector tests**

Cover sequential request numbering and exact deltas; absent or malformed numeric fields preserved as `null` rather than fabricated as zero; root/subagent separation; payload counters resetting after each usage record; compaction RPC stages kept separate from provider-observed compaction; transport-level usage and compaction records emitted before adapter routing; fresh-turn state reset; and collector failure isolation.

- [ ] **Step 3: Prove the diagnostic schema cannot carry content**

Create a recursive test helper that walks every emitted record. Fail if any key contains `prompt`, `message`, `command`, `query`, `path`, `url`, `input`, `output`, `content`, `payload`, `threadId`, `turnId`, `itemId`, `sessionId`, `secret`, or `token` unless the exact key is one of the numeric token-count fields defined above. Serialize records and assert that synthetic secret-like strings and home paths supplied inside measured inputs are absent.

- [ ] **Step 4: Implement the pure collector and size-only item classifier**

The size helper may call `Buffer.byteLength()` and bounded `JSON.stringify()` only to calculate a number. It returns numbers immediately and discards the source value. It must not return previews, hashes of content, keys from tool input, or nested structures.

For an item, measure only known output-bearing fields and the full serialized item size:

```ts
const observedPayloadBytes = byteLengthOf(
  item.aggregatedOutput
  ?? item.aggregated_output
  ?? item.output
  ?? item.content
  ?? item.text
  ?? item.description,
);
```

Record the item class, not the tool name or command.

- [ ] **Step 5: Run Task 1 tests**

```bash
npm run test:quiet -- \
  src/main/cli/adapters/codex/context-pressure-diagnostics.spec.ts \
  src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
```

Expected: the current field mapping is explicit and diagnostic records contain no content-bearing fields or values.

---

### Task 2: Instrument the Existing App-Server Path Without Changing Decisions

**Files:**

- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify: `src/main/cli/adapters/codex/app-server-client.ts`
- Modify: `src/main/cli/adapters/codex/app-server-client.spec.ts`
- Use without modifying: `src/main/logging/logger.ts`
- Use without modifying: `src/main/diagnostics/redaction.ts`

**Interface:**

```ts
export function isCodexContextDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean;
```

Only the exact value `1` enables collection. The adapter constructs no collector when disabled.

- [ ] **Step 1: Add a disabled-by-default test**

Instantiate the adapter with no environment flag, run a complete synthetic app-server turn, and assert no diagnostic sink calls. Existing output, context, complete, interrupt, compaction, and retry assertions remain unchanged.

- [ ] **Step 2: Add an enabled lifecycle test**

Feed `turn/started`, a root command completion, a usage update, a subagent dynamic-tool completion, a root MCP completion, another usage update, and `turn/completed`. Assert an ordered numeric record sequence. The second usage record reports only the root MCP item in `rootItemsSincePreviousUsage`; the subagent item remains visible only in the turn summary's subagent count.

Add transport tests proving that `thread/tokenUsage/updated` and `thread/compacted` are recorded before the primary notification handler runs. The transport record uses a 12-character SHA-256 correlation of the thread ID, never the raw ID. All other notification methods produce no transport diagnostic record.

- [ ] **Step 3: Wire recording beside, not inside, existing decisions**

Record notifications at the start of `handleTurnNotification()` before the existing switch mutates adapter state. The collector observes the notification and current turn state; it must not return actions or values consumed by production logic.

Start a diagnostic turn when the root `turn/started` notification arrives. Record item completion after root/subagent identity is known. Record the complete raw numeric token breakdown before the existing code emits its normalized `context` event. Record `thread/compacted` before the existing estimated-zero reset. Finish the diagnostic turn before ordinary capture state is discarded.

Record `compaction-rpc: requested` immediately before the existing `thread/compact/start` request, then `accepted` or `failed` on the existing branches. These are observations of the current manual/recovery path only; do not add a call, wait for a new event, change a return value, or infer completion from `accepted`.

At the app-server client's existing notification dispatch point, invoke a separate transport collector before the primary handler. It extracts only the two allowed methods, numeric usage fields, and the correlation hash, then immediately discards the notification reference. It cannot subscribe, replace the handler, settle a gate, mutate params, or return a routing decision. This transport record is the evidence needed to distinguish “provider emitted it but AIO missed it” from “provider never emitted it.”

- [ ] **Step 4: Add a failure-isolation test**

Use a sink whose `write()` throws. Assert the ordinary turn still emits its assistant response, context event, and single completion. Log one bounded warning without the failing record or raw notification.

- [ ] **Step 5: Verify no behavior changes escaped the seam**

Run the app-server spec, then review `git diff -- src/main/cli/adapters/codex-cli-adapter.ts`. Confirm there are no changes to thresholds, configuration parameters, RPC calls, notification routing, context values, compaction state, retry ladders, emitted UI copy, or capability flags.

---

### Task 3: Build a Read-Only Evidence Analyzer

**Files:**

- Create: `scripts/analyze-codex-context-pressure.ts`
- Create: `scripts/__tests__/analyze-codex-context-pressure.spec.ts`
- Read only: `src/main/conversation-ledger/provider-event-capture.types.ts`
- Read only: `src/main/cli/adapters/codex/session-scanner.ts`

**Command:**

```bash
npx tsx scripts/analyze-codex-context-pressure.ts \
  --log <app.log> \
  --db <conversation-ledger.db> \
  --instance <instance-id> \
  --rollout <rollout.jsonl> \
  --out _scratch/codex-context-pressure/<run-id>
```

Every source flag except `--out` is optional, but at least one evidence source is required. Open SQLite with `{ readonly: true }`. Never write beside an input file.

**Outputs:**

- `summary.json` — machine-readable numeric facts and source coverage.
- `timeline.jsonl` — diagnostic events ordered by timestamp/sequence.
- `report.md` — sanitized human-readable tables plus explicit limitations.

The output schema must not include input paths, raw IDs, prompt text, assistant text, reasoning, command text, tool names, tool arguments/results, filenames, URLs, queries, or arbitrary source strings.

- [ ] **Step 1: Write failing parser and safety tests**

Use synthetic app-log JSONL, provider-capture rows, and rollout JSONL containing obvious fake prompts, commands, paths, URLs, and secret-shaped values. Assert the analyzer extracts counts, byte lengths, item classes, usage fields, compaction markers, and timestamps while none of the source strings appear in any output.

- [ ] **Step 2: Parse diagnostic logger records**

Accept only entries where `subsystem === 'CodexContextDiagnostics'`, `message === 'context-pressure-observation'`, and `data.schemaVersion === 1`. Reject malformed records with a counted warning; do not abort the entire report.

- [ ] **Step 3: Summarize existing provider captures without exporting bodies**

Query the selected instance in chronological order. Retain only event kind, timestamp/sequence, numeric context fields, output/tool-result byte length, status transitions, and whether raw provenance was present. Do not call the existing fixture exporter: it intentionally preserves replayable bodies after redaction, while this investigation needs metadata only.

- [ ] **Step 4: Structurally summarize the rollout**

Stream the rollout line-by-line. Retain only entry type/subtype, timestamp, serialized line byte count, numeric token-usage fields, bounded item class, and whether a compaction marker exists. For content-bearing fields, record byte length only. Malformed lines increment a counter and are otherwise discarded.

- [ ] **Step 5: Generate explicit source coverage and limitations**

The report says which of these were present: raw diagnostic usage notifications, normalized context events, rollout token-count events, item-size observations, compaction markers, and turn boundaries. It never substitutes one source for another silently.

- [ ] **Step 6: Run analyzer tests**

```bash
npm run test:quiet -- scripts/__tests__/analyze-codex-context-pressure.spec.ts
```

Expected: deterministic output, read-only inputs, and zero source-content leakage.

---

### Task 4: Perform Offline Forensics Before Any Live Reproduction

**Files:**

- Create as disposable output: `_scratch/codex-context-pressure/<incident-run>/summary.json`
- Create as disposable output: `_scratch/codex-context-pressure/<incident-run>/timeline.jsonl`
- Create as disposable output: `_scratch/codex-context-pressure/<incident-run>/report.md`

- [ ] **Step 1: Identify evidence sources without printing their contents**

Locate the relevant AIO `app.log`, conversation-ledger database, instance identifier, and Codex rollout by timestamps and metadata. Print filenames, sizes, modification times, and redacted/correlation identifiers only. Do not use `cat`, `head`, or broad SQL selects against content-bearing columns.

- [ ] **Step 2: Run the analyzer against the original incident**

Prefer all available sources. If a source predates the new diagnostics, mark that source absent rather than reconstructing fictional per-notification values.

- [ ] **Step 3: Independently verify the displayed arithmetic**

Record the exact provider numerator and denominator, the calculated percentage, and the normalized AIO values. Decision rule:

- raw provider `last.totalTokens` equals normalized `used` and the arithmetic matches: UI calculation is supported;
- raw provider and normalized values differ: parsing/bridge defect remains a live hypothesis;
- raw provider notification is unavailable: the calculation is arithmetically plausible but not incident-proven.

- [ ] **Step 4: Build a request-boundary timeline**

For every observed usage update, list request sequence, `last.totalTokens` and delta, `total.totalTokens` and delta, cached-input fields, root/subagent item counts and observed output bytes since the prior update, and compaction markers. Do not label observed byte correlation as retained token count.

- [ ] **Step 5: Decide whether offline evidence is sufficient**

Offline evidence is sufficient only if it answers Questions 1–6 with a cited source and states the remaining limitations. If one or more questions cannot be distinguished, list the exact missing field/event and proceed to Task 5. Do not jump to a mitigation design.

---

### Task 5: Run a Bounded Controlled Reproduction Only If Required

**Files:**

- Create as disposable workspace: `_scratch/codex-context-pressure/reproduction-workspace/`
- Create as disposable evidence: `_scratch/codex-context-pressure/reproduction-<run-id>/`

**Prerequisites:** rebuilt/restarted development app with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, a fresh Codex app-server thread for every case, the same model/reasoning setting across cases, and no reuse of the incident thread.

- [ ] **Step 1: Record fixed stop conditions before starting**

Stop and interrupt the case at the first of 35% occupancy, 10 completed root tool items, three post-baseline usage updates, unexpected access outside the disposable workspace, or any diagnostic failure/missing usage notification.

- [ ] **Step 2: Run the baseline case**

In a fresh thread, ask for one short response requiring no tools. Capture the starting and ending raw usage records. This measures fixed thread/system overhead for the chosen model and settings.

- [ ] **Step 3: Run the small-ticket case**

In a fresh copy of the disposable workspace, ask Codex to inspect one small synthetic TypeScript file, identify one deliberately planted type error, and report it without editing. Limit the prompt to five tool calls and targeted reads. Record the request-boundary timeline.

- [ ] **Step 4: Run the bounded-output comparison only when output retention remains unresolved**

Use fresh threads and identical prompts that ask Codex to run one deterministic, non-sensitive command producing either 4 KiB or 32 KiB of repeated `x` characters, then answer with `done`. The command runs only in the disposable workspace. Compare the next raw usage update across cases; do not infer exact tokenization from byte counts.

- [ ] **Step 5: Analyze each case separately**

Generate one evidence directory per case. Compare baseline overhead, last-token deltas, cumulative/cached deltas, item counts, and observed bytes. Do not combine threads into a pseudo-timeline.

- [ ] **Step 6: Stop without escalating the experiment**

If the bounded cases do not reproduce the behavior, record that result. Do not increase output sizes, tool counts, or occupancy in this plan.

---

### Task 6: Write the Findings and Triage Each Hypothesis

**Files:**

- Create: `docs/superpowers/verifications/2026-07-13-codex-context-pressure-discovery.md`
- Generate for review only: `.aio-review/2026-07-13-codex-context-pressure-discovery.html`

The Markdown file is canonical. The HTML file is disposable and must not be committed.

- [ ] **Step 1: Write a source-indexed findings document**

Use these sections: Executive answer; What the 94% figure does and does not mean; Incident timeline; Tool/output observations; Compaction observations; Hypothesis table; Limitations and missing evidence; Recommended next action; Reproduction/evidence commands.

Each material claim points to a diagnostic sequence, normalized provider-event sequence, or rollout record class. Do not include raw record bodies.

- [ ] **Step 2: Triage hypotheses with fixed verdicts**

Use only `supported`, `weakened`, `ruled out`, or `inconclusive`:

| Hypothesis | Evidence required |
|---|---|
| AIO used lifetime tokens as current occupancy | Compare raw `last`, raw `total`, normalized `used`, and renderer input |
| AIO's percentage arithmetic was wrong | Recalculate from the raw numerator/denominator and compare |
| Prior context made the ticket appear larger than it was | Establish the pre-turn baseline from the first usage record/rollout boundary |
| Large tool results drove the next request's occupancy | Correlate item-size observations with the next raw `last` delta and rollout structural retention |
| Repeated model requests drove lifetime cost but not occupancy | Compare cumulative/cached deltas with stable or changing `last` values |
| Provider compaction occurred but AIO missed it | Find a compaction marker without the corresponding normalized/system event |
| Provider compaction never ran during the active turn | Establish request boundaries, threshold eligibility, and absence of every compaction marker |

- [ ] **Step 3: Keep recommendations proportional to the evidence**

The findings may recommend a later mitigation plan, but must not prescribe fixed thresholds or implementation details unless measurements directly support them. If several mitigations remain plausible, name the decision-driving measurement still needed.

- [ ] **Step 4: Render the findings for James's review**

Use the repo's `doc-review-artifact` workflow when available. If that skill is unavailable in the execution session, keep the Markdown canonical, report the missing renderer explicitly, and do not hand-build or commit HTML as a substitute.

---

### Task 7: Verify the Diagnostic Change and Complete the Document Lifecycle

**Files:**

- Modify after execution only: this plan's filename
- Create only if a required external check remains: `docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md`

- [ ] **Step 1: Run focused tests together**

```bash
npm run test:quiet -- \
  src/main/cli/adapters/codex/context-pressure-diagnostics.spec.ts \
  src/main/cli/adapters/codex/app-server-client.spec.ts \
  src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts \
  scripts/__tests__/analyze-codex-context-pressure.spec.ts
```

- [ ] **Step 2: Prove runtime behavior is unchanged when diagnostics are disabled**

```bash
npm run test:quiet -- \
  src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts \
  src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts \
  src/main/cli/adapters/codex/app-server-client.spec.ts \
  src/main/cli/adapters/codex/compaction-gate.spec.ts \
  src/main/providers/adapter-runtime-event-bridge.spec.ts \
  src/main/conversation-ledger/provider-event-capture-service.spec.ts
```

Expected: existing event order, context values, retry behavior, and capture behavior remain unchanged.

- [ ] **Step 3: Run the canonical project gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Expected: every command exits 0.

- [ ] **Step 4: Run repository safety scans**

Scan the new diagnostic source and analyzer for mitigation controls (`tool_output_token_limit`, `model_auto_compact_token_limit`, `turn/steer`, recovery thresholds). Scan generated JSON/JSONL for content-bearing keys and source values. Review every match manually rather than weakening the scan.

- [ ] **Step 5: Record genuinely external checks if they could not run**

If authenticated provider access or a rebuilt Electron process prevented Task 5, create the `_livetest.md` file with the exact prerequisite, fixed prompts, stop conditions, commands, expected diagnostic records, and reason the check could not run. Do not describe the missing reproduction as verified.

- [ ] **Step 6: Complete the plan only when the outcome is honest**

Rename this plan `2026-07-13-codex-context-pressure-observability-discovery-plan_completed.md` only after every agent-runnable gate passes, the offline findings report exists, each hypothesis has a verdict and cited evidence, any external-only reproduction is moved into the livetest document, and no mitigation behavior was introduced. Rename the plan last and do not edit it afterward.

---

## Acceptance Checklist

- [ ] The incident percentage is verified against raw provider fields when available; otherwise the report says it is not incident-proven.
- [ ] The report distinguishes current-window occupancy, lifetime processing, cached input, output bytes, and rollout bytes.
- [ ] The request-boundary timeline shows exactly when context growth occurred.
- [ ] Root and subagent work are counted separately.
- [ ] Compaction requested/observed/missing states are distinguished without inference from an RPC acceptance alone.
- [ ] Diagnostic logging is default-off, content-free, failure-isolated, and covered by leakage tests.
- [ ] Existing provider captures and rollouts are analyzed read-only.
- [ ] No prompt, command, tool body, output body, path, URL, raw identifier, or secret appears in generated evidence.
- [ ] No provider config, context threshold, steering, interrupt, compaction, retry, capability, or renderer behavior changes in this phase.
- [ ] Any live reproduction remains below the fixed stop conditions.
- [ ] Every hypothesis is marked supported, weakened, ruled out, or inconclusive with source-indexed evidence.
- [ ] The recommendation is deferred to a later implementation plan and is proportional to the findings.
- [ ] Targeted tests, both TypeScript checks, lint, max-LOC, and the full quiet suite pass before completion.

## Explicit Non-Goals

- Choosing or implementing a tool-output token limit.
- Adding provider auto-compaction overrides.
- Steering or interrupting a running Codex turn.
- Automatically compacting or resuming a thread.
- Replacing `selfManagedAutoCompaction` or changing capability ownership.
- Changing context-warning thresholds or renderer copy.
- Fixing the existing compaction RPC/event-settlement semantics.
- Generalizing diagnostics to other providers.
- Reproducing the incident at high occupancy.
- Treating cached-token savings as proof of reduced context occupancy.

## Implementation Handoff

Execute Tasks 1–3 first to create trustworthy evidence tooling. Run Task 4 against the original incident before deciding whether Task 5 is necessary. Task 6 is the actual deliverable; Task 7 proves that the diagnostic work did not become an unreviewed mitigation change.
