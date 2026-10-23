# Read-only research measurements

These commands read an explicit normalized JSONL export, never a live database.
They write only JSONL to stdout. No dependencies or copied checkout are needed.

```sh
node scripts/audit/context-ceiling-replay.mjs export.jsonl --ceiling 272000
node scripts/audit/composition-scan.mjs export.jsonl
node scripts/audit/polling-scan.mjs export.jsonl --repeats 3
node --test scripts/audit/measurement-kit.test.mjs
```

Each line needs `messageId` (globally unique), `sessionId`, `sessionKind`
(`human`, `queue`, `loop`, `scheduled`, `research-sweep`), `timestamp` (epoch ms),
`readTokens` (cached input), `writeTokens` (all other input, including cache writes),
and `outputTokens`. Counts are nonnegative finite numbers. Optional `contextTokens`
is the measured request context; `component` labels a measured composition category;
`toolName` enables polling classification. Export one usage event per message; do not
mix cumulative session totals with per-message totals. Classify research sessions
before exporting. Unknown session kinds or missing IDs are rejected, not guessed.

Coverage is printed before each result, including rejected rows, duplicates,
excluded research and the rows carrying context/tool measurements. Message IDs
are deduplicated globally. Every ratio includes the read/write/output mix. At least
three source scans must agree; changed input fails the run. Timing repeats are
stability checks, not three independent samples. ±3% is noise.

The ceiling replay is a **modelled per-request bound**, scaling processed input by
`min(1, ceiling/contextTokens)` on measured requests. It excludes compaction calls,
retries and quality effects; it cannot establish actual savings. Missing context
requests are excluded from the model and counted in coverage. Composition and
tool-name polling counts are observed. A frequent poll is not proof of waste.

Keep raw exports private and outside tracked files. Reports contain counts and
component labels, never message bodies. The scripts do not gather or upload data.
