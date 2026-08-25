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
- Vitest projects are `renderer` (jsdom + Angular TestBed) and `main` (jsdom + zone, without Angular). Both run parallel isolated forks — see Worker Fan-Out below. CI shards on top of that.
- On failure, the quiet runner may add a summary from a local Ollama/LM Studio endpoint. Configure `AIO_AUX_LLM_URL` or disable summaries with `AIO_TEST_SUMMARY=0`.

## Worker Heap

Both projects were `singleFork` until 2026-08-20, so one Node process ran a project's whole spec list and its heap grew across the run. A run that day died after 771 files with `FATAL ERROR: Ineffective mark-compacts near heap limit` (its reporter had collected 848 — it was not the unsharded full suite), followed by `ERR_IPC_CHANNEL_CLOSED` in the parent as it tried to talk to the dead worker — a worker OOM at V8's default ~4 GB ceiling, not a test failure. Parallel forks removed the accumulation; the raised ceiling stays for the still-serial slow tier and for any single heavy spec file.

`vitest.heap.ts` now raises that ceiling to a quarter of host RAM, capped at 8 GB, and leaves Node's default alone on hosts under 24 GB (on a small CI runner a ceiling above physical memory swaps a clean V8 OOM for an OS OOM-kill). `scripts/__tests__/vitest-heap-budget.spec.ts` asserts from inside the worker that the ceiling arrived.

The ceiling only reaches the workers from the **root** `test.poolOptions.forks.execArgv`: Tinypool is built once per run from the root config, so a per-project `execArgv` is silently ignored. The same is true of `maxForks`. Per-project `singleFork` is honoured through a different path (spec grouping), which is why it used to live under each project.

## Worker Fan-Out

`singleFork: true` dated to 2026-01-20 with the rationale "avoid re-initializing TestBed for each file" — true only of the renderer project, which the `main` project then inherited in the multi-project split. It made every spec file of a project share one process, which is what let the heap grow and what put the wall clock at the sum of ~1.5k files.

Both projects now run parallel isolated forks (`isolate` defaults to true, so each file gets a fresh worker environment and no worker carries another file's state). The distinction is sharper than "one fork instead of many": under `singleFork` Vitest hands its **entire file list to a single pool task**, and worker recycling only happens between tasks — so one process really did run 771 files before it died. The parallel branch submits one file per task. Measured on an 18-core host, 2026-08-20:

| project | files | serial | 8 forks | 16 forks |
| --- | --- | --- | --- | --- |
| `main` | 1467 | ~550s | 153s | 125s |
| `renderer` | 288 | 35s | 25s | — |

`vitest.pool.ts` sizes concurrency from the cores the host has **spare** — `min(8, floor(cores - load1) - 1)` — not from its core count. Past 8 the returns are small, and a fixed fan-out multiplies badly here: several agent sessions share this checkout and each may start its own suite. A run launched at load average 467 on 18 cores took 1907s and failed four timing-sensitive specs. A saturated host now degrades to a single fork, which is no worse than the `singleFork` behaviour this replaced, and `AIO_TEST_MAX_FORKS=N` pins the count for benchmarking or CI (clamped to 64, so a typo cannot fork-bomb the host).

CPU starvation is not a neutral slowdown for specs that shell out under a timeout. Unlocking parallelism surfaced three such cases, all pre-existing:

- Both rtk spec files build a stub binary and then execute it, and the first execution of a freshly written file on macOS costs a ~290ms median with a >1s tail (Gatekeeper/code-signing evaluation, plus whatever endpoint protection is installed) against ~3ms once warm. They hit it through two different paths:
  - `rtk-runtime.ts` probes `rtk --version` under a 1s timeout and caches the result for the process, so one cold-start stall disabled rtk for a whole app session. `probeVersion()` now retries, with a more patient 4s budget on the second attempt: the binary is warm by then, so only a busy host explains the wait. A genuine non-zero exit still fails on the first attempt.
  - `rtk-defer-hook.mjs` never probes a version — it calls `rtk rewrite <command>` under a 2s timeout and degrades to "no rewrite, normal flow" when that times out. The test factory now warms the stub after writing it, so those specs stop measuring exec cold-start. The hook's own 2s budget is unchanged.
- `history-manager-advanced-options.spec.ts` never awaited `HistoryManager.startupTasks`, so teardown deleted the temp dir under a running backfill (ENOENT on write, ENOTEMPTY on `rmSync`). It now tracks each manager and waits, as the other history specs already did.
- `local-review-tool-runner`'s FIFO spec exceeded the global 5s `testTimeout` purely under host load; it passes on a calm box and needs no change beyond the load-aware fan-out above.

`scripts/__tests__/vitest-pool.spec.ts` guards the fan-out policy and asserts `singleFork: true` has not returned to the default config.
