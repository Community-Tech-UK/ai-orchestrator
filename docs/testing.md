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

## Cache and CI

- The local cache is enabled by default. After mass deletes or renames, use `AIO_TEST_NO_CACHE=1` or `--no-cache`.
- CI can shard with `npm run test -- --shard=N/4`; local full runs are normally unsharded.
- Vitest projects are `renderer` (jsdom + Angular TestBed) and `main` (jsdom + zone, without Angular). Both remain `singleFork`; CI sharding supplies parallelism.
- On failure, the quiet runner may add a summary from a local Ollama/LM Studio endpoint. Configure `AIO_AUX_LLM_URL` or disable summaries with `AIO_TEST_SUMMARY=0`.
