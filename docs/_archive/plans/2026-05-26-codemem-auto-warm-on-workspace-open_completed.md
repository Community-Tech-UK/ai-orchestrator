# Codemem Auto-Warm on Workspace Open

**Date:** 2026-05-26
**Status:** Completed (implemented and verified)
**Owner:** Codex

## Problem

Codemem (`src/main/codemem/`) is AI Orchestrator's analog of Copilot's
"Codebase Semantic Index" — AST + LSP + CAS store, tree-sitter chunker,
file watcher, Merkle tree for incremental rescans, all running in a
dedicated worker.

Today the index is only warmed when an **instance is spawned** against a
working directory:

- `src/main/instance/instance-lifecycle.ts:1402` —
  `await this.warmCodememWorkspace(instance.workingDirectory)`
- which calls `warmCodememWithTimeout(...)` in
  `src/main/instance/warm-codemem.ts`
- which calls `getCodemem().warmWorkspace(path)` in
  `src/main/codemem/index.ts:113`

That means:

1. If a user opens a folder in the UI but never spawns a CLI against it,
   codemem never indexes it. There's no useful background work happening
   the moment a codebase is "present."
2. The very first spawn against a fresh workspace pays the full
   cold-index cost on the critical path (bounded at 15 s, but a real
   delay nonetheless).

We want indexing to start the moment a codebase is known to the app —
independent of CLI spawn — so the index is already warm (or warming) by
the time the user actually launches an instance.

## Goal

Codemem `warmWorkspace(path)` fires automatically whenever a workspace
path enters the app's knowledge — without blocking the UI, without
re-firing on every minor event, and without breaking the existing
spawn-time warm-up path.

## Non-Goals

- Replacing the spawn-time warm-up. That stays — it's the safety net
  for cases where pre-warm didn't happen (e.g. instance restored from
  history, fresh worker re-spawned, remote node).
- Indexing every directory the user has ever opened on app startup.
  We only pre-warm the **active** workspace and (optionally) the most
  recent N.
- Changing what codemem indexes or how. Pure trigger work.

## Design

### Central hook point: `RecentDirectoriesManager`

`src/main/core/config/recent-directories-manager.ts` is already the
canonical chokepoint for "a workspace path entered the app." Every UI
flow that opens a folder eventually calls
`getRecentDirectoriesManager().addDirectory(path)`:

- `src/main/channels/channel-message-router.ts:2125` — instance create
- `src/renderer/.../welcome-coordinator.service.ts:347, 435`
- `src/renderer/.../instance-list.component.ts:874, 1063, 1566`
- `src/main/ipc/handlers/recent-directories-handlers.ts:93` — explicit
  IPC add
- Renderer dropdown `recent-directories-dropdown.component.ts:594`

It already emits `'directory-added'` (line 114). That event is the hook.

### Listener: `CodememPrewarmCoordinator`

New file: `src/main/codemem/codemem-prewarm-coordinator.ts`

Responsibilities:

1. Subscribe to `recentDirectoriesManager.on('directory-added', …)` at
   app startup.
2. On each event, check:
   - `entry.nodeId` is falsy (skip remote paths — codemem can't index
     them locally; remote nodes own their own indices).
   - Path exists locally and is a directory (the manager already
     enforces existence for local paths at line 75, so this is belt &
     braces).
   - `getCodemem().isEnabled() && getCodemem().isIndexingEnabled()`.
3. Debounce per-path with a short window (default 1500 ms) so that
   rapid-fire add/remove/re-add (e.g. user clicking around recent dirs)
   collapses to one warm call.
4. Maintain a `Set<string>` of paths warmed in this app session. If the
   path is already in the set AND its codemem `lastIndexedAt` is recent
   (e.g. ≤ 30 s), skip — the watcher is already keeping it live.
5. Call `getCodemem().warmWorkspace(path)` with a long-ish timeout
   (60 s — we're off the critical path, can afford a real cold index).
   Fire-and-forget; swallow rejections; log warnings.
6. Concurrency cap: at most 2 simultaneous warm-ups (configurable
   constant). New requests queue. Prevents user opening 5 recent dirs in
   a row from saturating the index worker.

### Active-workspace prioritisation

When the renderer's `NewSessionDraftService` (`setWorkingDirectory`)
changes the active draft's workingDirectory, the coordinator should
jump that path to the front of the queue if it's queued, or fire
immediately if not yet seen this session.

This is implemented through the unified renderer → main workspace hint
channel, `IPC_CHANNELS.WORKSPACE_HINT_ACTIVE`, called from
`NewSessionDraftService.setWorkingDirectory`. The main handler fans the
hint out to the codemem prewarm, codebase auto-index, and project
knowledge mirror coordinators; the codemem target calls
`getCodememPrewarmCoordinator().hintActiveWorkspace(path)`.

### Startup boot of the most-recent directory

In `src/main/app/initialization-steps.ts` (after Codemem init), if the
recent-directories store has at least one entry and the most-recent
entry is local, call `coordinator.hintActiveWorkspace(mostRecent.path)`.
That re-warms what the user is most likely to open first.

Keep the existing `warmCodememWorkspace` call in `instance-lifecycle.ts`
unchanged. The pre-warm coordinator is best-effort; spawn-time stays as
the synchronous safety net.

### Settings

Add to `src/shared/types/settings.types.ts`:

```ts
codememPrewarmEnabled: boolean;       // default true
codememPrewarmMaxConcurrent: number;  // default 2
codememPrewarmDebounceMs: number;     // default 1500
codememPrewarmStartupHint: boolean;   // default true
```

All gated under the existing `codememEnabled && codememIndexingEnabled`
master flags.

## Files to touch

| File | Change |
|---|---|
| `src/main/codemem/codemem-prewarm-coordinator.ts` | **new** — singleton listener, debounce, concurrency cap, hint API |
| `src/main/codemem/index.ts` | export `getCodememPrewarmCoordinator()` helper |
| `src/main/app/initialization-steps.ts` | after `initializeCodemem`, start the prewarm coordinator + emit startup hint for most-recent dir |
| `packages/contracts/src/channels/workspace.channels.ts` / generated IPC channel exports | add unified `WORKSPACE_HINT_ACTIVE` channel |
| `src/main/ipc/handlers/workspace-hint-handlers.ts` | register handler that fans out to workspace-present coordinators |
| `src/preload/domains/workspace.preload.ts` | expose `workspaceHintActive(payload)` |
| `src/renderer/app/core/services/ipc/workspace-ipc.service.ts` | **new** — thin wrapper |
| `src/renderer/app/core/services/new-session-draft.service.ts:60` | call ipc on `setWorkingDirectory` |
| `src/shared/types/settings.types.ts` | new settings keys + defaults |

## Tests

1. **`src/main/codemem/__tests__/codemem-prewarm-coordinator.spec.ts`** —
   - emits warm on `'directory-added'` for local paths
   - skips remote paths (nodeId present)
   - skips when codemem disabled
   - debounces multiple events for the same path within window
   - respects concurrency cap (third event queues until one completes)
   - `hintActiveWorkspace` jumps to the front of the queue
   - already-warmed-recently paths are skipped
2. **`src/main/instance/warm-codemem.spec.ts`** — unchanged; spawn-time
   path still works when pre-warm has not happened.
3. **`src/main/codemem/__tests__/codemem-service-warm-workspace.spec.ts`** —
   already-ready workspaces return immediately without rewarming index/LSP.
4. **Integration**: open a directory via the recent-directories IPC,
   wait for `directory-added`, assert
   `getCodemem().getWorkspaceLspState(path)` advances from `idle` →
   `warming`/`ready` without any instance being spawned.

## Acceptance criteria

- [x] Opening a folder in the UI (any of the 5 call sites that hit
      `addDirectory`) starts a codemem warm-up within `debounceMs`,
      observable via the LSP-state-machine moving off `idle`.
- [x] Spawning an instance against an already-pre-warmed folder
      completes the spawn-time warm-up in ≤ 200 ms (vs. multi-second
      cold path).
- [x] No regressions in `warm-codemem.spec.ts`,
      `instance-lifecycle.spec.ts`,
      `recent-directories-manager.spec.ts`.
- [x] `npx tsc --noEmit` clean.
- [x] `npx tsc --noEmit -p tsconfig.spec.json` clean.
- [x] `npm run lint` clean.
- [x] Disabling `codememPrewarmEnabled` in settings cleanly disables the
      coordinator without affecting spawn-time warm-up.

## Risks

- **Index worker saturation** on app start if many recent dirs warm at
  once. Mitigated by concurrency cap + only auto-firing for the
  most-recent on startup; other dirs only warm on actual interaction.
- **Wasted CPU** on dirs the user opened but doesn't intend to use.
  Mitigated by debounce + already-warmed dedupe. Worst case is one cold
  index per opened folder per app session, which is the desired
  behaviour anyway ("if there is a codebase, do whatever it does to
  it").
- **Race with spawn-time warm-up**: both can fire for the same path.
  `getCodemem().warmWorkspace` is idempotent (it routes through the
  index worker gateway and the worker dedupes). Once the LSP state is
  `ready`, spawn-time warm-up returns from the cached ready state instead
  of re-entering the index/LSP workers, so the safety-net call is fast for
  prewarmed workspaces.
