# Cursor tool telemetry + coordinator verify fan-out

Status: completed 2026-09-05 (fresh-eyes gate pass 2: PASS). Origin: loop `loop-1788631546543-593083f8` (Cursor session
`c90c1037-1cd9-421c-a592-7c1231741ec9`) parked after 9 iterations on a false "no progress"
verdict, and its coordinator verify timed out twice at 600s. Diagnosis is in the
chat transcript; the two code causes are fixed here.

## Cause 1 — ACP adapter records Cursor tool calls with no arguments and no result

Live probe of `cursor-agent acp` (2026-09-05, `/tmp/acp-probe/frames.ndjson`):

- `tool_call` for grep / Read File arrives with `rawInput: {}`; only `execute` carries
  `rawInput: { command }`.
- Results arrive on `tool_call_update` in `rawOutput`, never in `content`:
  grep → `{ totalMatches, truncated }`, Read File → `{ content }`,
  execute → `{ exitCode, stdout, stderr }`.

`AcpCliAdapter` ignores `rawOutput`, so every result was `""` (sha256 prefix
`e3b0c44298fc1c14`), and every grep/read hashed to the same args key. Progress signals
G and I, and the instance `DoomLoopDetector`, then fired CRITICAL on every iteration.

### Changes

1. `acp-cli-adapter.ts`: render `rawOutput` when `content` is empty; only attach
   `rawInput` to the emitted arguments when it has keys; only attach `result` when
   there is text.
2. New `src/main/providers/tool-call-argument-material.ts`:
   `readCapturedToolArguments()` returns `undefined` for an ACP `kind`-only argument
   object (optionally with an empty `rawInput`). Used by the runtime-event bridge
   (`argsHash` undefined → `DoomLoopDetector` fails open, as already documented) and by
   `loop-invoker-capture.ts`.
3. `loop-invoker-capture.ts`: uncaptured arguments get a per-call `argsHash` and
   `argsCaptured: false`; a tool_result with no result string no longer hashes the
   constant "Tool result: X" message.
4. `LoopToolCallRecord.argsCaptured?: boolean` (shared type; persisted JSON is additive).
5. Signal I abstains for calls with `argsCaptured === false`: without arguments it cannot
   tell two different reads apart, and Cursor's grep `rawOutput` is only a match count.

## Cause 2 — coordinator verify ran the suite on one worker

`vitest.pool.ts` sized forks from the 1-minute load average. The loop agent runs the full
suite inside its iteration, which leaves load1 at 25–57 on 18 cores when the coordinator
starts its own verify seconds later → `floor(18 - 25) - 1` → 1 fork → 822 of 1977 files in
9 minutes → 600s timeout → orphaned vitest tree. Per-file timings matched the agent's runs
exactly; only parallelism differed. Confirmed by the agent's `ps` snapshot showing a single
`node (vitest 1)` worker.

### Changes

6. `vitest.pool.ts`: measure busy cores from `os.cpus()` over a short window at config load
   (`sampleBusyCores()`), and size forks from that. Load average remains the fallback when a
   sample is unavailable. `AIO_TEST_MAX_FORKS` override unchanged. `docs/testing.md` updated.

## Not changed (recorded for James)

- Login-shell verify (`zsh -lc`) resolves Homebrew Node 26 while agents run nvm Node 24,
  because nvm is sourced from `.zshrc` which a non-interactive login shell skips. Shell
  config, not app code.
- The loop's prompt/config mismatch (research task under review-driven completion with a
  full-suite verify gate).

## Verification

- Targeted specs: acp-cli-adapter, adapter-runtime-event-bridge, loop-invoker-capture,
  loop-progress-detector, vitest-pool, tool-call-argument-material.
- Gates: `tsc --noEmit` (both), `npm run lint`, `check:ts-max-loc`, `build:main`, `test:quiet`.
- Fresh-eyes review by an independent agent.

## As-built (2026-09-05)

- Helpers live in `src/main/cli/adapters/acp-tool-call-material.ts` (adapter side) and
  `src/main/providers/tool-call-argument-material.ts` (hash consumers), each with a spec.
  They were split out of `acp-cli-adapter.ts` to keep it under its LOC ceiling (2366 lines,
  ceiling 2326 + 50 slack); `loop-state.types.ts` comments were compressed to stay at 699/700.
- `sampleBusyCores()` is wrapped in try/catch and returns `null` (load-average fallback) if
  `Atomics.wait`/`SharedArrayBuffer` or CPU info is unavailable — added after fresh-eyes pass 1.
- One existing test needed a fixture change: the LT-062 "ACP echo not double-counted" case in
  `instance-manager.normalized-event.spec.ts` used `input: { kind: 'edit' }`, which is now the
  uncaptured shape; it now sends `rawInput: { path }` so it still proves no double counting.
- Gates: targeted specs (8 files) green; `tsc --noEmit` and `tsc -p tsconfig.spec.json` green;
  `npm run lint` green; `check:ts-max-loc` green; `build:main` green; full `test:quiet`
  21749 passed / 0 failed / 1 skipped in 188s (run seconds after another full suite — the
  fork sizing it exercises is the one this plan fixed).
- Not code-verified: a live Cursor loop. The adapter change is covered by a spec built from the
  recorded `cursor-agent acp` frames; the running app needs a rebuild to pick it up.
