# Interrupt leftover hang + streaming rewind

Status: Completed 2026-09-20. The blocker above is cleared — the unrelated
compile errors are gone and the full canonical checklist runs green on this tree
(see the completion record). The live Stop/stream checks stay deferred in the
livetest doc; they need a rebuilt app and are not claimed as verified.

Live checks: [2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_livetest.md](./2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind_livetest.md)

## Problem

Live instance `u8094rzzn` (Cursor ACP session `68aaf1c1-…`) did not crash. Stop cancelled the in-flight prompt, then Harness showed a false stuck banner and a stream-idle warning over a healthy idle session.

Observed:

1. Renderer IPC interrupt (`origin: renderer-ipc`) while `busy`.
2. ACP cancelled the prompt (`durationMs: 13546`). Transcript: `Interrupted — waiting for input`.
3. Stuck detector stayed in `generating` (`processAlive: true`) and fired the 75s soft warning.
4. Stream-idle watchdog fired at 90s on the same pid.
5. Hard auto-restart did not run. Session was archived later.
6. Separate Cursor ACP `[STREAMING_DROP]`: streamed assistant text shrank (`I'll check…` → `I'll`) and the UI applied the rewind.

## Root cause

- ACP `sendInputImpl` swallows client-cancel and returns without emitting `status: idle` or clearing the stream-idle timer.
- Interrupt completion moves the instance to `idle` but never tells the stuck detector, so `generating` keeps ticking over expected post-Stop silence.
- Streaming merge only refuses empty rewinds. A shorter non-empty snapshot still overwrites committed text.

## Fix

1. ACP cancel: clear stream-idle watchdog on `interrupt()`, emit `idle` on client-cancel.
2. Interrupt completion / in-place settle / respawn-to-idle: `onToolStateChange(id, 'idle')`.
3. Shared monotonic streaming merge: keep committed text when a later chunk is shorter. Use it in main and renderer.

## As built

- `AcpCliAdapter.interrupt()` clears the stream-idle watchdog immediately.
- Client-cancel in `sendInputImpl` emits `status: idle` instead of returning silently.
- `InterruptRespawnHandler` calls `onToolStateChange(id, 'idle')` on in-place settle, completion-to-idle, and respawn-to-idle. Wired from lifecycle → instance-manager stuck detector.
- `nextMonotonicStreamingContent` keeps committed assistant text when a later streaming chunk is empty or shorter. Used in main `addToOutputBuffer` and renderer `InstanceOutputStore`.

## Verification

- Targeted specs: 6 files, 238 tests passed (`streaming-content`, `acp-cli-adapter`, both interrupt-respawn specs, `instance-communication`, `instance-output.store`).
- `npm run lint` and `npm run check:ts-max-loc` passed.
- `npx tsc --noEmit` is blocked by an unrelated dirty-tree error in `codex-app-server-adapter.ts` (`clearPendingContextCost`). Not part of this change.
- Live Stop + streaming rewind: deferred to the livetest doc (rebuild required).

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
