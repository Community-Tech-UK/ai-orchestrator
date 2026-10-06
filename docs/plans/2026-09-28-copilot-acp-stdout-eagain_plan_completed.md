# Copilot ACP sessions die mid-turn (stdout EAGAIN) — plan

Status: completed (2026-09-28) — code complete and verified; one live check
pending in the livetest doc. As built: root cause 1 needed no Harness change
(Copilot 1.0.89-5); root cause 2 fixed by `deferExitToRecoveryOwner`.

## Problem

Copilot sessions (e.g. `pogg12k15`) kept dying mid-turn with exit code 0, and
one failed recovery left the session `terminated` with no message.

## Root cause 1 — Copilot CLI (upstream; fixed in 1.0.89-5)

Copilot CLI up to at least 1.0.89-3 treated EAGAIN on its stdout as a fatal
disconnect. Its embedded Node runtime marks a pipe/socket stdout `O_NONBLOCK`;
when the reader fell behind, its Rust ACP writer logged
`ACP connection write failed {"stage":"flush","error":"Resource temporarily
unavailable (os error 35)"}`, dropped the live turn and exited 0
(`ACP transport ended, shutting down`). Harness spawns ACP agents with
`stdio: 'pipe'` — a Unix socketpair with 8 KiB send + 8 KiB receive buffer on
macOS — so a Harness main-thread stall, a large tool output, or a
multi-megabyte `session/load` replay was enough.

Evidence:

- Every `os error 35` in the Copilot profile logs coincides with a Harness
  death: 09-27 15:11:30 (native `session/load` → "could not be restored
  natively"), 09-27 15:14:01 (mid-turn), 09-28 01:19:17, 08:46:29 (mid-turn,
  right after viewing a 101.6 KB tool output while the main loop was busy),
  08:46:36 (the respawn's `session/load`).
- Standalone repro (`_scratch/copilot-eagain/repro-load*.mjs`): `session/load`
  of a 13 MB session with the client stalled 1.5 s. Run side by side against
  each cached build's `index.js`: **1.0.89-3 dies after 65 KB (2/2), 1.0.89-5
  streams all 8.6 MB (2/2).** No EAGAIN has occurred on this machine since
  1.0.89-5 was installed (09-28 09:13:37 UTC) across 17 large replays,
  including 5 s stalls through the real `AcpCliAdapter`. The changelog does not
  mention the fix.

A Harness-side transport workaround (child stdout as an unlinked temp file,
tailed by polling) was built and proven against 1.0.89-3, then withdrawn once
the upstream fix was confirmed: it would keep every byte a session writes on
disk until the process exits, for a failure that no longer occurs. Also ruled
out: a `NODE_OPTIONS --require` preload (the native binary ignores it) and
`--acp --port` TCP (unauthenticated, multi-client, survives disconnect).

## Root cause 2 — Harness recovery race (fixed here)

When the replacement process dies while a recovery owner (unexpected-exit or
interrupt respawn) is mid-spawn, the generic adapter-exit handler settled it
first: `respawning` is not auto-respawn eligible, so exit code 0 became
`terminated` with no error and no message. That tripped the owner's
`shouldAbort()` and skipped its fallback (native resume → fresh session with
replay). Result: `pogg12k15` went silently dead at 08:46:37.

## Changes

- [x] `deferExitToRecoveryOwner` (instance-communication-recent-respawn-retry.ts):
      an exit while `respawning` with the session lock held defers to the
      owner; after the lock releases it re-runs normal exit handling unless
      the owner settled the instance (its stale-adapter guard drops the replay
      if the owner swapped in a fallback adapter).
- [x] instance-communication.ts: exit listener is a named `handleExit` so the
      deferral can replay it (file stays at its LOC ceiling, 2546).

## Verification

- [x] Unit: 5 deferral tests in instance-communication.spec.ts; revert checks
      (deferral disabled → 4 fail; settled-guard removed → 1 fails).
- [x] Canonical gates: tsc, typecheck:spec, lint, ts-max-loc, build:main,
      build:renderer all exit 0; full `test:quiet` 2248 files / 26875 tests
      passed (before the review hardening; after it: tsc/lint/loc green,
      instance-communication + lifecycle + session specs green, one unrelated
      wall-clock spec timed out under load and passed 2/2 in isolation).
- [x] Fresh-eyes completion gate: PASS; its two hardening notes (whole deferred
      callback in try/catch, `redactRecoveryError` on the log) applied and
      re-reviewed by a second fresh agent: PASS.
- Runtime check deferred to [2026-09-28-copilot-acp-stdout-eagain_livetest.md](2026-09-28-copilot-acp-stdout-eagain_livetest.md)
  (needs the rebuilt app).

## Follow-ups (not in this change)

- A mid-turn crash still loses the in-flight turn after native resume; the
  user has to send "continue". James approved automatic continuation; it is
  tracked separately in `2026-09-28-crash-turn-auto-continue_plan.md`.
- Optional upstream report: EAGAIN on stdout was fatal in ACP stdio mode up
  to 1.0.89-3 (fixed silently in 1.0.89-5).
