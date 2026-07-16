# Codex Context-Pressure Discovery Findings

**Status:** Offline investigation complete. Controlled live reproduction remains pending in [the live-test procedure](../plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md).

**Scope:** Discovery and passive, default-off diagnostics only. No context threshold, provider setting, renderer behavior, retry, steering, interruption, or compaction behavior was changed.

## Executive answer

The approximately 94% figure is arithmetically consistent with the final Codex rollout current-window value: `242,865 / 258,400 × 100 = 93.9880030960%`. It is not consistent with the lifetime total, which reached 18,910,442 tokens. The executing adapter path maps the provider's current `last.totalTokens` field to renderer occupancy and maps lifetime `total.totalTokens` only to cumulative processing; camel-case and snake-case characterization tests lock that behavior. This strongly weakens the lifetime-as-current hypothesis, but raw-transport-to-renderer equality for this historical incident is not proven. `[R:449]` `[C-map]`

The incident was not one sudden jump. The rollout contains 103 ordered token-count observations over 16 minutes 46.947 seconds (1,006,947 ms). Current-window usage rose monotonically from 22,380 to 242,865 tokens, while cumulative processing rose from 22,380 to 18,910,442. The largest single current-window increase was 16,935 tokens at request boundary `[B:22]`; the final boundary added only 533 tokens at `[B:103]`. `[R-summary]` `[R:16]` `[R:449]`

The evidence also shows a long period of repeated processing with little additional occupancy. From `[B:75]` through `[B:100]`, current-window usage rose by 4,204 tokens while cumulative processing rose by 5,870,394 and cumulative cached input rose by 5,837,568. Repeated model requests therefore drove lifetime cost much faster than current-window occupancy during that phase. `[B:75]` `[B:100]`

Two questions cannot be proven from the historical incident. First, the supplied application log has no raw app-server diagnostic usage record and the supplied ledger has no normalized provider-capture table, so equality between the app-server payload, normalized AIO values, and renderer input is not incident-proven. Second, the rollout has no root/subagent markers or complete compaction lifecycle records. The bounded live test is required to collect those missing fields safely; it has not been run. `[R-summary]` `[L-live]`

## Evidence index

This document cites sanitized record classes and derived boundaries, never raw record bodies:

- `[R:n]` is sanitized rollout sequence `n` emitted by the metadata-only analyzer.
- `[B:n]` is request boundary `n`, derived from the records after the previous rollout token-count observation through the cited observation.
- `[R-summary]` is the analyzer-generated sanitized incident summary and its source-coverage flags.
- `[C-map]` is the current executing adapter mapping in [`codex-cli-adapter.ts`](../../../src/main/cli/adapters/codex-cli-adapter.ts) plus the camel-case and snake-case characterization tests in [`codex-cli-adapter.app-server.spec.ts`](../../../src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts).
- `[L-live]` is [the pending bounded live-test procedure](../plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md).
- `[D:*]` denotes the new diagnostic record classes available only in a future telemetry-enabled reproduction: `transport-usage`, `token-usage`, `item-completed`, `compaction-rpc`, `transport-compaction`, `compaction-observed`, `turn-start`, and `turn-complete`.

`[R-summary]` accepted 450 rollout records with zero malformed records: 1 session-metadata, 321 response-item, 126 event-message, 1 turn-context, 1 other, and 0 compaction records. The supplied application log contained zero context-diagnostic records, and the supplied ledger did not contain the provider-capture table. `[R-summary]`

## What the 94% figure does and does not mean

At `[R:16]`, the first available rollout token-count observation was 22,380 current tokens in a 258,400-token window, or 8.6609907121%. At `[R:449]`, the final observation was 242,865 current tokens in the same window, or 93.9880030960%. Current occupancy increased by 220,485 tokens, or 85.3270123839 percentage points. `[R:16]` `[R:449]`

The accounting fields must remain separate. `[R:16]` `[R:449]`

| Measurement | First `[R:16]` | Final `[R:449]` | Change |
| --- | ---: | ---: | ---: |
| Current-window total | 22,380 | 242,865 | 220,485 |
| Current input | 22,057 | 242,356 | 220,299 |
| Current cached input | 9,984 | 241,408 | 231,424 |
| Current output | 323 | 509 | 186 |
| Current reasoning output | 46 | 301 | 255 |
| Cumulative total processed | 22,380 | 18,910,442 | 18,888,062 |
| Cumulative cached input processed | 9,984 | 18,555,136 | 18,545,152 |

The 94% figure means the final rollout accounting event reported current-window usage near the context-window limit. It does not mean the thread had processed only 242,865 tokens over its lifetime, that cached input was absent, that measured output bytes equal retained tokens, or that compaction had or had not been requested. `[R:449]` `[R-summary]`

The arithmetic is verified against the rollout fields. It is not verified against the raw historical app-server notification because `[D:transport-usage]` did not exist at the time. Likewise, no historical normalized `context` capture proves what AIO sent to the renderer. Those are explicit coverage gaps, not inferred failures. `[R-summary]` `[C-map]`

## Incident timeline

All 103 current-window observations were non-decreasing. The phase table preserves the exact boundary ranges where growth occurred; the complete boundary-by-boundary table was derived from all 450 sanitized `timeline.jsonl` records in the Task 4 reconciliation. The analyzer's human report is only a 100-observation sample and explicitly records three omissions. `[R-summary]` `[B:1]`–`[B:103]`

| Boundary range | Current start | Current end | Current change | Cumulative change | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| `[B:1]` | 22,380 | 22,380 | baseline | baseline | First observable state; earlier system/user contributions cannot be decomposed. |
| `[B:2]`–`[B:11]` | 22,380 | 88,682 | 66,302 | 554,513 | Rapid current growth across repeated requests. |
| `[B:12]`–`[B:22]` | 88,682 | 141,352 | 52,670 | 1,224,849 | Includes the largest single increase, +16,935 at `[B:22]`. |
| `[B:23]`–`[B:35]` | 141,352 | 183,281 | 41,929 | 2,219,281 | Continued multi-request growth. |
| `[B:36]`–`[B:52]` | 183,281 | 188,702 | 5,421 | 3,162,226 | Current usage begins to plateau while processing continues. |
| `[B:53]`–`[B:58]` | 188,702 | 222,409 | 33,707 | 1,255,151 | A second concentrated current-growth phase. |
| `[B:59]`–`[B:75]` | 222,409 | 232,066 | 9,657 | 3,876,393 | Slower current growth with substantial repeated processing. |
| `[B:76]`–`[B:100]` | 232,066 | 236,270 | 4,204 | 5,870,394 | Long late plateau; cumulative cached input rose 5,837,568. |
| `[B:101]`–`[B:103]` | 236,270 | 242,865 | 6,595 | 725,255 | Final rise; `[B:103]` itself added only 533. |

The final 94% therefore reflects accumulated request-boundary growth, not a last-response conversion of lifetime totals into occupancy. `[B:1]`–`[B:103]` `[C-map]`

## Tool/output observations

The rollout analyzer found 342 item-bearing structural observations, 1,526,661 content-bearing bytes, and 1,795,165 serialized bytes across the intervals ending at the 103 usage observations. `[R-summary]` `[B:1]`–`[B:103]`

| Item class | Observations | Content-bearing bytes | Serialized bytes |
| --- | ---: | ---: | ---: |
| Other | 6 | 500,012 | 501,435 |
| Reasoning | 99 | 0 | 185,829 |
| Agent message | 26 | 11,960 | 17,864 |
| Dynamic | 204 | 1,008,767 | 1,071,832 |
| MCP | 1 | 5,922 | 6,216 |
| File change | 6 | 0 | 11,989 |
| Command | 0 | 0 | 0 |
| Web | 0 | 0 | 0 |
| Collaboration | 0 | 0 | 0 |

These counts are structural observations, not unique completed tools. Generic calls that cannot be classified without retaining names are intentionally recorded as `dynamic`. The historical rollout does not contain the diagnostic `rootThread` field, so root and subagent counts are unavailable rather than guessed. `[R-summary]`

Measured bytes also cannot be relabelled as model-visible retained tokens. The evidence does not show a simple same-boundary relationship: `[B:56]` contains 186,024 content-bearing bytes but only a +546 current-token change, whereas the largest +16,935 change at `[B:22]` follows 3,467 measured content-bearing bytes. Delayed retention and provider serialization cannot be distinguished without `[D:item-completed]` followed by the next `[D:transport-usage]`/`[D:token-usage]` pair. `[B:22]` `[B:56]` `[L-live]`

## Compaction observations

The incident rollout has zero compaction records across all 103 boundaries. That weakens the claim that a visible provider compaction occurred while AIO silently missed it. `[R-summary]` `[B:1]`–`[B:103]`

It does not establish the complete lifecycle. The historical evidence lacks:

- `[D:compaction-rpc]` requested, accepted, or failed stages;
- `[D:transport-compaction]` receipt at the app-server boundary;
- `[D:compaction-observed]` after adapter routing;
- a provider threshold/eligibility observation.

RPC acceptance would not itself prove that provider compaction occurred. Conversely, absence of a rollout marker cannot prove that no request was attempted. The bounded live test must keep those states separate. `[C-map]` `[L-live]`

## Hypothesis table

Verdicts use only the plan's fixed vocabulary.

| Hypothesis | Verdict | Evidence and boundary |
| --- | --- | --- |
| AIO used lifetime tokens as current occupancy | **weakened** | The executing mapping uses `last.totalTokens` for occupancy and `total.totalTokens` for cumulative processing; both casing variants are characterized. The incident's displayed value also matches rollout current rather than its 18,910,442 lifetime total. Raw transport-to-renderer equality is unavailable for this incident. `[C-map]` `[R:449]` |
| AIO's percentage arithmetic was wrong | **weakened** | For the observed rollout numerator and denominator, `242,865 / 258,400 × 100` is 93.9880030960%, which correctly rounds to approximately 94%. The raw transport numerator and normalized renderer input are unavailable, so the historical end-to-end calculation is not incident-proven. `[R:449]` `[R-summary]` |
| Prior context made the ticket appear larger than it was | **weakened** | The first observable state was 22,380 tokens (8.66%) at `[R:16]`, while 220,485 additional current tokens accumulated across later boundaries. The baseline cannot be decomposed into system, user, and prior-thread portions. `[R:16]` `[R:449]` |
| Large tool results drove the next request's occupancy | **inconclusive** | Structural bytes and next-boundary deltas do not show a simple relationship (`[B:22]`, `[B:56]`), but the rollout cannot prove model-visible retention or root/subagent attribution. `[B:22]` `[B:56]` |
| Repeated model requests drove lifetime cost but not occupancy | **supported** | `[B:75]`–`[B:100]` added 5,870,394 cumulative tokens and 5,837,568 cumulative cached input while current usage rose only 4,204. `[B:75]` `[B:100]` |
| Provider compaction occurred but AIO missed it | **weakened** | No rollout compaction marker exists in 450 accepted records, but transport and normalized compaction observations were not available historically. `[R-summary]` |
| Provider compaction never ran during the active turn | **inconclusive** | All 103 rollout boundaries lack a marker, but provider eligibility and RPC/transport/adapter lifecycle records are missing. `[R-summary]` `[L-live]` |

## Limitations and missing evidence

`[R-summary]` records these machine-readable limitations:

- `provider-capture-table-unavailable`
- `raw-diagnostic-usage-unavailable`
- `normalized-context-events-unavailable`
- `compaction-markers-unavailable`

Consequently, the historical incident cannot establish:

1. exact equality between raw app-server `last`/`total`, normalized AIO `used`/`total`, and renderer input;
2. the pre-turn `baselineUsedTokens` before the controlled request;
3. root versus subagent completions and adapter-observed payload bytes;
4. model-visible retention of any structural rollout body;
5. compaction requested, accepted, failed, transported, and observed states;
6. provider compaction threshold eligibility.

The new diagnostics collect these fields as content-free numeric/classification records, but they are default-off and did not exist during the incident. Their existence on disk is not evidence that the old incident emitted them. `[C-map]` `[R-summary]`

## Recommended next action

Run the pending bounded live-test procedure against a rebuilt, quiet development instance with diagnostics explicitly enabled. The required baseline and small synthetic TypeScript cases should establish fixed overhead, raw-to-normalized equality, root/subagent item accounting, and the compaction lifecycle while staying below 35% occupancy, 10 root tool items, and three post-baseline usage updates. `[L-live]`

Because output retention remains inconclusive offline, run the two optional bounded-output cases only if the baseline and small-ticket evidence still cannot distinguish retention. Do not increase output sizes, tool counts, or occupancy if those cases remain inconclusive. `[B:22]` `[B:56]` `[L-live]`

Do not choose a tool-output limit, auto-compaction threshold, steering rule, or renderer change from the current evidence. A later mitigation plan should be driven by the first raw usage delta after a classified root item and by explicit compaction lifecycle records. `[R-summary]` `[L-live]`

## Reproduction/evidence commands

The offline evidence was generated with the repository's read-only context-pressure analyzer, one incident/thread per sanitized output set. The reproducible command shape uses placeholders rather than historical input locations or identifiers: `[R-summary]`

```bash
rtk npx tsx scripts/analyze-codex-context-pressure.ts \
  --log <diagnostic-log> \
  --db <read-only-ledger> \
  --instance <redacted-instance-id> \
  --rollout <rollout-jsonl> \
  --out _scratch/codex-context-pressure/<run-id>
```

Omit unavailable source pairs exactly as documented by the analyzer; at least one evidence source and `--out` remain required. Generated output must pass the structural privacy validator in `[L-live]` and must never be hand-edited to repair a failed check.

The exact safe execution sequence, fixed case instructions, stop rules, expected diagnostic records, structural privacy validator, and cleanup steps are in [the pending live-test document](../plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md). No controlled provider case has been run or verified. `[L-live]`

## Review artifact status

The `doc-review-artifact` workflow was not available in this execution session. This Markdown file is the canonical review document. No substitute HTML was hand-built or committed.
