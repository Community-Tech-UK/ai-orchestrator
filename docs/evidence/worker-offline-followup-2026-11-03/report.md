# Worker offline findings: worker handoff, 3 November 2026

Status: implementation and worker checks passed; ready for independent queue verification.
This is not the coordinator's independent canonical/full-suite verification.

## Changes and acceptance

- LT-710 was already fixed in the supplied base. `src/main/persistence/rlm/rlm-schema.ts:311`
  acquires the immediate transaction before reading applied migrations at line 314. Checksum
  validation, pending discovery, DDL and migration tracking writes share that transaction.
  Existing `rlm-schema.spec.ts:79` deterministically lets another SQLite connection migrate
  before the first acquires its lock; the first then sees current state. That regression,
  interrupted-migration rollback, checksum mismatch/recovery and SQLITE_FULL error preservation
  pass. No replacement migration implementation was added.
- The compiled `context-worker-main.js` ran as a real Electron utility process on a new,
  disposable user-data profile while main opened that same RLM database. It sent `ready`,
  answered a `list-stores` request with an empty array, and main observed 75 distinct applied
  migrations with none pending. The parent observed the utility process exit before exiting.
  See `fresh-worker.json` and the corresponding command receipt.
- LT-711 needed a contract fix. The original event was emitted by
  `src/main/app/remote-gateway-initialization-steps.ts:68` but rejected at
  `src/main/event-bus/electron-window-transport.ts:31`. The shared strict discriminated union
  now admits `coordinator-route` with required `running|stopped|absent|unknown` state.
  It still rejects missing, invalid, null, numeric and extra-field payloads.
- The pinned `contract-probe.cjs` loads the exact base schema and current schema without changing
  production files. All four supported states are rejected by base and accepted by current code;
  invalid states remain rejected. Contract tests retain all prior assertions and add coverage.
  The new `coordinator-route-delivery.spec.ts` verifies real watcher callbacks through the event
  bus and validating Electron transport, unchanged-poll deduplication, and invalid-state rejection
  before webContents delivery.

## Real transport and view check

`runtime-results.json` records both mounted production parent views and child templates. Actual
hint elements in Worker Nodes and Settings Computers changed absent → present → absent during
synthetic `running → stopped → running`, with the same parent DOM elements throughout. The paired
worker stayed disconnected, no bulk roster/lifecycle events were emitted, and roster requests
increased 2 → 4 → 6. The prior-schema negative control kept both views stale while main's roster
contained the hint. Production event bus, validating Electron transport, full preload, renderer
IPC services and roster builder were used. See `runtime-report.txt` for exact wiring and replay.

This used isolated read-only IPC handlers and synthetic settings/auth/registry/probe dependencies,
with actual Angular JIT components and templates but omitted external SCSS. The host rejected
Chromium sandbox initialization; successful hidden runs used `--no-sandbox`, so this is no claim
about sandbox enforcement or full normal app startup. The first sandbox failure is retained.

A genuinely fresh agent used `task-completion-gate`, independently reran focused tests, typecheck
and lint, traced the production call chain, inspected the exact runtime sources/results/screenshot,
and verified the runtime receipt hashes. It returned `VERDICT: PASS` for worker readiness with no
actionable findings. Its full-suite/clean-state gate remains expressly pending; see `fresh-review.md`.

## Verification

All recorded worker commands exited 0: the focused tests (5 files, 28 tests), `npx tsc --noEmit`,
`npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`,
main build, renderer production build, alias/IPC generators and contracts-alias check.
The generators made no tracked changes. `git diff --check` is clean.

Full-suite verification is deliberately left to the queue verifier under the current user
instruction. The renderer build reports an initial-bundle budget warning. The compiled worker
probe logged a host sandbox-extension warning but completed its readiness/RPC assertions.
Neither warning is suppressed or represented as an absent warning.

## Scope and evidence limitations

The linked LT-710/LT-711 register sections and old `worker-offline-2026-10-27` evidence directory
are missing from both the supplied checkout and root checkout. The origin document's retained
27 October evidence run supplies the failure details and executing paths; the worker plan
records that discrepancy. This bundle is new evidence, not a reconstruction of missing receipts.
There is no separate specification. The active plan was edited only at its root-checkout path.

No actual Tailscale interruption, operating-system notification display, Windows sign-in-policy
change, Windows Update restart, worker restart, release or deployment was performed. Those remain
open in the original live-test owner and have not been substituted with synthetic observations.
No new live-test deferral is needed for the code checks: the full-suite gate is queue verification,
and the disruptive external checks already have an open owning live-test document.

## Replay and custody

Run the retained contract probe directly from the checkout with Node. To repeat the compiled
fresh-worker check, rebuild main, place `fresh-worker-probe.cjs.txt` at
`_scratch/worker-offline-followup/fresh-worker.cjs`, ensure that directory has no
`fresh-worker-profile` from an earlier run, then run the exact Electron command in
`command-receipts.jsonl`. The fixture uses explicit disposable paths and hides the app dock icon;
it opens no window. Remove that newly created profile after the process has exited.

The command receipts retain timing, actual exit status and log path. Small command logs and
fixture sources are retained with this bundle; compiled output, profiles and fixture bundles
are removed after sealing. Dependencies stay in the worktree for the verifier. No commit,
staging, stash, branch switch, new branch or worktree lifecycle operation was performed.
Archived logs use `.log.txt` so repository ignore rules do not omit them from the handoff.
`source-check-seal.json` records source/document/artifact hashes before runtime deletion;
`cleanup.json` records the removals and post-cleanup checks.
