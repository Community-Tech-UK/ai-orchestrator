# Bounded Session Recovery Specification

Status: Completed and independently verified on 2026-07-17

Implementation plan: [2026-07-17-bounded-session-recovery_plan_completed.md](../plans/2026-07-17-bounded-session-recovery_plan_completed.md)

## Problem

A preserved transcript can contain arbitrarily large tool results. The restart
fallback currently serializes the complete content of the 40 most recent
messages into a structured recovery packet, then places that packet in an
unshrinkable prompt header. A single 1,046,524-character tool result therefore
produced a 1,285,743-character replay prompt, above Codex app-server's
1,048,576-character per-turn limit. The retry ladder reopened a fresh thread and
resent the same generated prompt, so recovery could not succeed.

The restart planner also derives resume capability from the live adapter object.
When cleanup has already disposed that object, a resumable provider can be
misclassified as non-resumable and forced onto the riskier replay path.

## Design Decision

Full transcript bytes remain preserved in history and evidence storage. Recovery
prompts are a separate, bounded projection and must never be treated as a lossless
transcript export.

The implementation will enforce these invariants:

1. Structured recovery packets include bounded previews and original-length
   metadata, never unbounded message content.
2. Tool uses and tool results are always summarized in replay prose, regardless
   of recency.
3. The complete recovery message, including packet, headers, notices, and recent
   transcript, has a hard 200,000-character ceiling in addition to its existing
   token budget.
4. If ordinary candidate reduction cannot satisfy both limits, recovery emits a
   syntactically complete minimal prompt rather than returning an oversized
   fallback.
5. Provider runtime capabilities can be recovered from the runtime registry when
   the previous adapter has already been disposed. Missing or unproven registry
   data remains conservative.
6. Per-turn overflow errors refer to the assembled turn, not necessarily the
   user's visible message.

## Components

### Recovery packet projection

`src/main/session/fallback-history.ts` will retain the existing packet shape for
callers but bound every `recentMessages[].content` value. Tool messages receive a
short execution/result marker; user and assistant messages receive bounded
previews. Each packet message records its original character count and whether it
was truncated so the model does not confuse a preview with complete evidence.

### Recovery envelope budget

`buildFallbackHistoryMessage()` will evaluate the complete candidate against both
the token budget and the hard character ceiling. Its final fallback will be built
from bounded components and rechecked; it will not preserve the old behavior of
returning the minimum three turns even when that violates the declared budget.

The 200,000-character ceiling leaves substantial headroom beneath Codex's current
1 MiB assembled-turn cap for system instructions, tool schemas, and attachment
descriptors. It also matches the repository's existing design direction for
aggregate tool-output spill thresholds.

### Capability recovery

`ProviderRuntimeService.getCapabilities()` will accept an optional provider key.
It will prefer the live adapter, then the last registry snapshot for that provider,
then the conservative all-false default. Restart planning and native-resume setup
will supply the resolved CLI provider so disposal of the old adapter does not erase
known static capabilities.

### Error attribution

The terminal input-cap error will say the assembled turn still exceeds Codex's
limit after a fresh-thread retry. It will recommend reducing the input or starting
fresh without replay context without asserting that the user's message caused the
overflow.

## Verification

- Reconstruct the exact archived failing transcript and prove the generated
  recovery prompt is at most 200,000 characters and below its token budget.
- Add regression coverage for a recent tool result larger than 1 MiB.
- Add coverage that packet previews retain original-length/truncation metadata.
- Add provider-runtime coverage for registry-backed capability lookup after
  adapter disposal and conservative behavior without a snapshot.
- Add lifecycle coverage that restart planning receives resumable capabilities
  when the adapter is absent but the provider registry is populated.
- Run targeted tests, both TypeScript typechecks, lint, max-LOC, and the full quiet
  suite.

## Non-goals

- Truncating or deleting stored transcripts.
- Changing provider-native context compaction.
- Changing normal live tool-result delivery to the provider.
- Raising Codex's upstream per-turn limit.

## As-Built Result

The implementation matches the design decision:

1. Recovery packets contain bounded previews plus `contentChars` and `contentTruncated` metadata.
2. Tool messages are summarized in replay prose, and full transcript bytes remain unchanged in durable history.
3. The whole recovery envelope, including notices, is bounded by both token and 200,000-character limits, with a bounded minimal fallback for tight budgets.
4. Provider capability lookup prefers the live adapter, falls back to the provider registry after disposal, and remains conservative without evidence.
5. Restart and native-resume paths pass the resolved provider into capability lookup.
6. Terminal overflow messaging refers to the assembled turn rather than blaming the visible user message.

The exact archived failure now produces a 12,013-character / 3,004-token recovery message from 1,167,610 raw transcript characters, including the original 1,046,524-character tool result. Independent verification passed 77 focused tests, both TypeScript checks, lint, the max-LOC ratchet, and the decisive 1,501-file / 14,848-test full suite. Diff forensics found no task-specific integrity, dependency, security, async, or performance issue.
