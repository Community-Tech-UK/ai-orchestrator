# Test Runner Guide

Use `npm run test:quiet` for local Vitest runs. It prints failures verbatim plus a one-line pass summary and stores the full output in `_scratch/test-run.log`.

## Normal Workflow

Run a focused spec while investigating:

```bash
npm run test:quiet -- path/to/file.spec.ts
```

Run the unsharded full suite once at the final gate:

```bash
npm run test:quiet
```

The default suite excludes `*.e2e.spec.ts` and `**/soak.spec.ts`. Run those with `npm run test:slow`. Load and benchmark suites use `npm run test:load` and `npm run bench`.

### Retrieval evaluation (WS16)

`npm run bench:retrieval` runs the labeled retrieval eval harness against the REAL codemem BM25 + lesson-digest engines over the committed fixture dataset (`benchmarks/retrieval/fixtures/*.jsonl`), reporting Recall@1/5/10 + NDCG@10 with a per-type breakdown and a deterministic dev/held-out split. It compares against the committed baseline (`benchmarks/retrieval/baseline.json`) and **exits non-zero on a regression**, so a ranking change shows a measurable delta before it lands.

- Uses the in-memory wasm sqlite driver, so it runs under plain Node (no native rebuild) and never touches real stores.
- `--update-baseline` locks in an improvement (regenerate the snapshot deliberately) and only ever touches the committed synthetic suite/baseline — it never runs the local suite, even combined with `--local`.
- The synthetic suite also runs in the unit tier (`src/main/memory/retrieval-eval/synthetic-suite.spec.ts`) as a baseline-reproduction guard.

`npm run bench:retrieval -- --local` additionally runs the local-personal suite against the operator's real RLM (`rlm.db`) and codemem (`codemem.sqlite`) stores, discovered at runtime under the current Harness user-data layout (packaged `harness`, falling back to dev `harness-dev`; see `src/main/memory/retrieval-eval/local-suite.ts`). Both stores are opened READ-ONLY — a real SQLite-engine read-only connection that structurally cannot write back to the source file — and the run never touches fixtures, the baseline, or any tracked file:

- A missing store prints an explicit `skipped` line (distinct from a crash or silent no-op).
- An opened-but-unqueryable store (missing expected tables, or a query throws) prints an explicit `failed` line.
- If a healthy codemem store is found and `benchmarks/retrieval/local-queries.jsonl` exists, the suite runs those `code`-type queries against the real BM25 path (`searchHydratedChunks`) for the workspace passed via `--local-workspace=<path>` (default: this repo checkout) and prints R@1/5/10 + NDCG@10 with the same `metrics.ts` machinery as the synthetic suite.
- `local-queries.jsonl` is **gitignored and never created by the tool** — it is the operator's own personally-labeled query set, one JSON object per line, same shape as the committed synthetic queries: `{"id": "...", "type": "code", "query": "...", "relevant": ["relative/path/from/workspace.ts"]}`. Without this file, the store-health lines still print but query metrics are `skipped`.
- Read-only driver selection (`src/main/memory/retrieval-eval/local-suite-driver.ts`): by default `--local` re-runs the local suite inside a short-lived `ELECTRON_RUN_AS_NODE=1` child so the native `better-sqlite3` addon (ABI-matched to the installed Electron, opens the file in place with `SQLITE_OPEN_READONLY`, **no size ceiling**) can read a multi-gigabyte daily-driver store. The child prints its result as JSON on a `__WS16_LOCAL_SUITE_JSON__` sentinel line; the parent driver line reports `native-child`. If no Electron binary is found under `node_modules/electron`, or `--local-force-wasm` is passed, it falls back to the in-process WASM reader (`openSqliteWasmFileReadOnly`, `sqlite3_deserialize` with `SQLITE_DESERIALIZE_READONLY`), which loads the whole store into a 32-bit WASM heap and therefore reports `failed` ("greater than 2 GiB") for stores at/over that size — a real, surfaced failure, not silent data loss. Use `--local-force-wasm` to exercise that path deliberately.
- `--local-user-data=<path>` overrides discovery entirely (points at any user-data root, e.g. a specific instance or a throwaway fixture) — useful for testing this command itself without touching a real store.
- See the WS16 livetest for the manual store-mtime verification procedure.

## Cache and CI

- The local cache is enabled by default. After mass deletes or renames, use `AIO_TEST_NO_CACHE=1` or `--no-cache`.
- CI can shard with `npm run test -- --shard=N/4`; local full runs are normally unsharded.
- Vitest projects are `renderer` (jsdom + Angular TestBed) and `main` (jsdom + zone, without Angular). Both remain `singleFork`; CI sharding supplies parallelism.
- On failure, the quiet runner may add a summary from a local Ollama/LM Studio endpoint. Configure `AIO_AUX_LLM_URL` or disable summaries with `AIO_TEST_SUMMARY=0`.
