# ACP exit observability + exit-rejection respawn race

**Status:** completed 2026-09-26 (gate: PASS, round 1)
**Created:** 2026-09-26
**Spec:** none (bugfix plan; root cause established by forensic investigation of sessions `p97n4jzps` / `ph5ztisob`, 2026-09-25)

**As-built.** All items implemented and verified. Full suite 2241 files /
26782 tests / exit 0; `tsc` (both configs), `lint`, `check:ts-max-loc`,
`build:main`, `build:renderer` all green, each confirmed by exit code. Both
guards mutation-verified (guard disabled → exactly the new tests fail). One
fresh completion-gate round returned PASS with no actionable findings.

**Not verified:** that a repro now names the CLI's shutdown trigger. That is
the *purpose* of Task 1 — the trigger needs a live recurrence of the
mid-turn self-exit, which cannot be staged. When it next happens, the exit
line in app.log ("ACP process exited — stderr tail") plus the profile's
`logs/process-*.log` (`--log-level info`) name it definitively.

Two defects found while root-causing session `p97n4jzps` ("ACP agent exited (0)."):

1. **Observability gap.** The Copilot CLI is spawned with `--log-level none`
   (`adapter-factory.ts:467`), so its per-process logs are 0 bytes, and the ACP
   adapter logs child stderr only at `debug` (not persisted). The CLI's three
   clean-shutdown triggers — stdin EOF (`x.info("Received EOF on stdin, shutting
   down ACP server")`), stdin error (`x.error(...)`), and SIGTERM/INT/HUP/QUIT
   (raw stderr `" Exiting… "` via `shutdownService`) — are therefore invisible.
   Both mid-turn deaths (`c3abec31` 22:42, `50699e9f` 02:21 — byte-identical
   `session.shutdown {shutdownType:"routine"}` 21-23ms after a post-tool
   `turn_start`) cannot be attributed further from disk.

2. **Auto-respawn race.** On child exit with a prompt in flight, the adapter
   rejects the pending `session/prompt` with `ACP agent exited (…).`
   (`acp-cli-adapter.ts:999`). `sendInputImpl`'s catch then
   `emit('status','error')` + `emit('error')` (`acp-cli-adapter.ts:637-638`).
   The status handler (`instance-communication.ts:1373`) has no recovery guard
   and transitions `respawning → error` **before** `respawnAfterUnexpectedExit`
   passes `shouldAbortRespawn` (`interrupt-respawn-handler.ts:195`), which
   treats `error` as terminal → *"Skipping auto-respawn because instance is no
   longer recoverable"*. Verified in logs: exit 2553193 → respawn start
   2553195 → `respawning→error` 2553197 → abort check 2553201. The codebase
   documents this exact race class for EPIPE only
   (`instance-communication.ts` ~1838: "would race with the exit handler …
   which kills the session"); the exit-rejection falls through the gap.

## Work

### Task 1 — ACP exit observability

- [x] 1.1 `src/main/cli/adapters/adapter-factory.ts:467`: `--log-level none` →
      `--log-level info`, with a comment naming the three trigger lines.
      **Deviation from the "→ error" recommendation:** the most likely trigger
      (stdin EOF) logs at `x.info`, so `error` would still be blind to it. The
      CLI's `jWr` levels include `info`. These logs land in the profile's
      `logs/process-*.log` (already pruned by the CLI's own retention).
      Out of scope: `copilot-cli-adapter.ts:801,1100` (`none` on the non-ACP
      adapter + a `help config` probe).
- [x] 1.2 New `src/main/cli/adapters/acp-stderr-tail.ts`: small bounded tail
      buffer (last ~20 chunks / 8 KiB) with `push()`/`dump()`. Pure module, own
      spec.
- [x] 1.3 `acp-cli-adapter.ts` `attachProcessListeners`: feed stderr chunks to
      the tail buffer (live logging stays `debug`), and on `exit`/`error` log
      the tail at `info` together with code/signal — the exit-context record.
      Expose `getStderrTail()` for tests.

### Task 2 — exit-rejection must not kill auto-respawn

- [x] 2.1 `acp-cli-adapter.ts`: `isAcpAgentExitRejection(error)` helper
      (`/^ACP agent exited \(/` — matches only the message built at
      `acp-cli-adapter.ts:999`; `terminate()`'s "ACP adapter terminated…" does
      not match). In `sendInputImpl`'s catch, after the cancelled-by-client
      branch: swallow like cancelled — clear stream-idle watchdog, log `info`,
      return **without** `emit('status','error')` and `emit('error')`. The
      process-exit handler owns the aftermath (auto-respawn notice, or terminal
      `Process exited unexpectedly with code …` crash error via
      `buildCrashError`). Same rationale as the EPIPE guard. No output-error
      card: the exit handler already surfaces either recovery or the terminal
      error.
- [x] 2.2 `src/main/instance/instance-communication-adapter-helpers.ts`: add
      `isRecoveringStatus(status)` (`respawning | interrupting | cancelling`).
      Use it for the two existing triple-comparisons in the error handler
      (line-count neutral) and the new status guard.
- [x] 2.3 `src/main/instance/instance-communication.ts` status handler
      (~1373): ignore an advisory `error` status while the instance is
      recovering (`isRecoveringStatus`) — mirror of the error handler's
      existing guard ("let lifecycle handle it"). **LOC ratchet:** this file is
      at 2546 = ceiling 2496 + slack 50 exactly; net growth must be ≤ 0.
      Offset: collapse the 3-line `normalizedStatus` ternary to one line.

### Tests

- [x] 3.1 `acp-cli-adapter.spec.ts`:
      (a) exit mid-turn with pending prompt → `sendInput` resolves, emits no
      `error`/`status: 'error'`, `getStderrTail()` still readable;
      (b) non-exit failure still emits `status: 'error'` + `error` (regression).
- [x] 3.2 New `acp-stderr-tail.spec.ts`: bounds + dump.
- [x] 3.3 `copilot-acp-spawn-env.spec.ts`: assert `--log-level info` in spawn args.
- [x] 3.4 New focused `instance-communication` spec (partial-usage harness
      pattern): `error` status during `respawning` is ignored (status unchanged,
      no `queueUpdate('error')`); positive control: `error` from `busy`
      transitions normally.

### Verification (canonical checklist)

`npx tsc --noEmit` · `npm run typecheck:spec` · `npm run lint` ·
`npm run check:ts-max-loc` · `npm run build:main` · `npm run build:renderer` ·
`npm run test:quiet` (plus targeted `npm run test:quiet -- <file>` while iterating)

### Out of scope

- Attributing the CLI's mid-turn `routine` shutdown trigger (needs one repro
  with the new logging — that repro is the point of Task 1).
- Non-ACP `copilot-cli-adapter.ts` `--log-level none`.
- Loop-child instances (no auto-respawn by design: `!instance.parentId`).

---

## Deviations and notes

- **`--log-level info`, not `error`** as originally recommended: the likeliest
  shutdown trigger (stdin EOF) is logged by the CLI at **info**
  (`x.info("Received EOF on stdin, shutting down ACP server")`), so `error`
  would have kept it invisible — the gap this item exists to close.
- **One pre-existing flaky test fixed** (`acp-cli-adapter.spec.ts` "emits a
  stall_warning…"): it slept exactly 80ms with `stallWarningMs: 40` and
  asserted exactly 1 warning, but `acp-stall-watchdog.ts` re-arms every
  `intervalMs` by design — warning #2 was due at the assertion boundary and
  fired first under full-suite load (caught as the sole failure in one run).
  Now waits for the first `stall_warning` event instead of a fixed sleep;
  both original assertions retained and now deterministic. Not caused by this
  work (zero watchdog lines in the diff) but blocked the gate.
- **LOC ratchet:** `instance-communication.ts` was already at its exact slack
  limit (2546 = ceiling 2496 + 50). The status-handler guard is offset by
  collapsing the `normalizedStatus` ternary and one log call; net growth 0.
  Recorded ceilings were not raised.

## Gate history

- **Round 1 (2026-09-26): PASS.** Independent fresh-agent gate (task-completion-gate skill)
  re-ran every canonical command itself — all exit 0 — re-verified both
  mutations (guard 1 disabled → 1/79 fail; guard 2 disabled → 2/3 fail,
  positive control green), confirmed the exit-rejection message is built at
  exactly one site (`acp-cli-adapter.ts:1027`) and cannot match `terminate()`'s
  rejection, confirmed `partialUsage` accounting is untouched by the swallow,
  and confirmed the ratchet ceilings are unmodified. Zero actionable findings;
  two accepted Low observations: `StderrTailBuffer.clear()` is spec-only and a
  per-adapter tail could mix chunks across a respawn (bounded, diagnostic-only,
  exit line's code/signal disambiguates); stderr tail at INFO can capture a
  secret a child echoes on failure (inherent to the observability goal, same
  trust domain as the CLI's own logs).
