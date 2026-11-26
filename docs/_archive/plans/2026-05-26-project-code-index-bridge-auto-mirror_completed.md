# ProjectCodeIndexBridge Auto-Mirror on Workspace Open

**Date:** 2026-05-26
**Status:** Draft (not yet implemented)
**Owner:** TBD

## Problem

`ProjectCodeIndexBridge` (`src/main/memory/project-code-index-bridge.ts`)
mirrors codemem's per-workspace symbol + manifest snapshot into the RLM
`project_code_index_status` / `project_code_symbols` / `project_knowledge_*`
tables. That mirror is what the Knowledge Graph read model
(`getProjectKnowledgeReadModelService`), the project-knowledge UI, and the
wake-context builder use to "see" the codebase — without it, those surfaces
show zero `code_file` sources, zero `code_symbol` evidence, and the project
appears empty to anything that doesn't go through codemem directly.

Today the bridge only fires on **depth-0 instance spawn**:

- `src/main/instance/instance-lifecycle.ts:1170-1182` — after a spawn,
  fire-and-forget:
  ```ts
  getProjectKnowledgeCoordinator().ensureProjectKnown(
    instance.workingDirectory,
    'instance-working-directory',
    { autoRefresh: true },
  );
  ```
- `ensureProjectKnown` runs the codebase miner and (via
  `refreshProjectCodeIndexInBackground`) the bridge.

So a user who opens a folder in the UI but doesn't spawn a CLI against it
leaves the project-knowledge store stale: codemem may have warmed (per spec
1) or be indexing (per spec 2), but the RLM mirror that hangs off codemem
never runs until the first spawn. This is the same shape of gap the
codemem-auto-warm and codebase-indexing-auto-start specs fix for their
respective subsystems.

## Goal

`ProjectKnowledgeCoordinator.ensureProjectKnown(path, 'recent-directory-open',
{ autoRefresh: true })` fires automatically whenever a workspace path enters
the app — without blocking the UI, without re-firing on every minor event,
and without breaking the existing spawn-time call which remains the safety
net.

## Non-Goals

- Replacing the spawn-time call at `instance-lifecycle.ts:1172`. That stays
  as the synchronous safety net for cases where pre-mirror never happened
  (remote node, instance restored from history, brand-new workspace passed
  on the CLI).
- Changing what the bridge writes or how. Pure trigger work.
- Mirroring every recent directory the user has ever opened. Active
  workspace + the most-recent on boot, mirroring the policy of specs 1 & 2.
- Touching the codebase-miner side of `ensureProjectKnown` independently.
  We deliberately go through the coordinator so the miner and the bridge
  warm together for a freshly-opened workspace (the user expectation: "if
  there is a codebase, do whatever it does to it").

## Design

### Central hook point: `RecentDirectoriesManager` — same as siblings

Specs 1 (`2026-05-26-codemem-auto-warm-on-workspace-open.md`) and 2
(`2026-05-26-codebase-indexing-auto-start.md`) both establish
`RecentDirectoriesManager`'s `'directory-added'` event
(`src/main/core/config/recent-directories-manager.ts:114`) as the canonical
"workspace is present" trigger. This spec adds a **third independent
listener** to the same event.

The three listeners are intentionally independent:

| Coordinator | What it triggers | Cost profile |
|---|---|---|
| `CodememPrewarmCoordinator` (spec 1) | `getCodemem().warmWorkspace(path)` | Light; per-path debounced |
| `CodebaseIndexingAutoCoordinator` (spec 2) | `indexingService.indexCodebase(...)` | Heavy; embedder-bound |
| `ProjectKnowledgeAutoMirrorCoordinator` (this spec) | `ensureProjectKnown(..., 'recent-directory-open', { autoRefresh: true })` | Medium; SQLite-bound, depends on codemem snapshot |

Adding a third listener is cleaner than extending either sibling, because:
- Each owns a distinct settings gate, queue, and status surface.
- The bridge depends on codemem having produced a manifest, while the other
  two are standalone — co-locating concerns would muddle the ordering.
- The bridge has its own concurrency profile (single SQLite writer; bounded
  symbol-replay transaction) that doesn't share a budget with codemem or the
  embedder.

### Listener: `ProjectKnowledgeAutoMirrorCoordinator`

New file:
`src/main/memory/project-knowledge-auto-mirror-coordinator.ts`

Responsibilities:

1. Subscribe to `getRecentDirectoriesManager().on('directory-added', …)` at
   app startup.
2. On each event:
   - Skip if `entry.nodeId` is present — remote paths' project-knowledge
     stores live on the owning node.
   - Skip if `settings.projectKnowledgeAutoMirrorEnabled` is false.
   - Skip if `!getCodemem().isEnabled() || !getCodemem().isIndexingEnabled()` —
     bridge guards on these internally but checking up front avoids
     enqueueing dead work.
   - Skip if `projectRootRegistry.canAutoMine(path)` is false (covers
     pause/exclude/autoMine=false uniformly). The coordinator inside
     `ensureProjectKnown` also checks this, but we want the early-exit on
     this hot path.
3. Short-circuit on recent sync (see "De-duplication" below).
4. Debounce per-path with a short window (default 2000 ms) so rapid-fire
   add/remove/re-add collapses to one mirror call.
5. Concurrency cap: at most 2 simultaneous mirrors. The bridge serialises on
   the SQLite connection anyway, but the cap protects against opening 5
   recent dirs in a row firing 5 cold-codemem warm-ups in parallel.
6. Call `getProjectKnowledgeCoordinator().ensureProjectKnown(path,
   'recent-directory-open', { autoRefresh: true })`. Fire-and-forget;
   swallow rejections; log warnings.

#### Why `ensureProjectKnown`, not `refreshProject` directly

The prompt asks whether the listener should wrap
`ProjectKnowledgeCoordinator.ensureProjectKnown` or call
`ProjectCodeIndexBridge.refreshProject` directly. Use the coordinator:

- `ensureProjectKnown` does the registry book-keeping
  (`ensureRoot(rootPath, discoverySource)`) **and** runs both the codebase
  miner (KG facts, wake hints) **and** the bridge mirror together. That
  matches the "if there's a codebase, warm everything" expectation.
- It applies the `canAutoMine` gate uniformly — calling the bridge directly
  would bypass that and re-implement the same logic.
- The existing spawn-time call (`instance-lifecycle.ts:1172`) goes through
  the same entry point, so the de-duplication mechanism (see below) only
  has to reason about one shape of caller.

### New discovery source

Add `'recent-directory-open'` to `ProjectDiscoverySource` in
`src/shared/types/knowledge-graph.types.ts:76-80`:

```ts
export type ProjectDiscoverySource =
  | 'manual'
  | 'manual-browse'
  | 'default-working-directory'
  | 'instance-working-directory'
  | 'recent-directory-open';   // ← new
```

`ProjectRootRegistry.canAutoMine` (`project-root-registry.ts:66-69`) does
**not** switch on `discoverySource` today — it only checks
`isPaused`/`isExcluded`/`autoMine !== false`, and `ensureProjectRoot`
defaults `auto_mine = 1` for new rows. So **no policy code change is
required**: rows newly discovered via `'recent-directory-open'` auto-mine
by default just like the existing sources.

Add a clarifying comment on `canAutoMine` noting that
`'recent-directory-open'` is a valid auto-mine source so future readers
don't add a source-allowlist filter by mistake. (Defensive: a future change
that *did* want to gate by source would have to revisit this; today it
doesn't.)

### Active-workspace prioritisation (consolidated hint channel)

Specs 1 and 2 each propose their own renderer→main hint IPC
(`CODEMEM_PREWARM_HINT` and `CODEBASE_AUTO_HINT`). This spec proposes
**consolidating all three into a single workspace-level channel** rather
than introducing a third:

```ts
// packages/contracts/src/channels/workspace.channels.ts
WORKSPACE_HINT_ACTIVE: 'workspace:hint-active',
```

Renderer side: a single `workspace.hintActive(path)` preload method called
from `new-session-draft.service.setWorkingDirectory`
(`src/renderer/app/core/services/new-session-draft.service.ts:60`). Main
side: one handler fanning out to whichever of the three coordinators are
present:

```ts
// pseudocode
ipcMain.handle(WORKSPACE_CHANNELS.WORKSPACE_HINT_ACTIVE, (_e, payload) => {
  const { path } = parse(payload);
  tryHint(() => getCodememPrewarmCoordinator()?.hintActiveWorkspace(path));
  tryHint(() => getCodebaseIndexingAutoCoordinator()?.hintActiveWorkspace(path));
  tryHint(() => getProjectKnowledgeAutoMirrorCoordinator().hintActiveWorkspace(path));
});
```

**Arguments for consolidation** (chosen):
- Renderer doesn't need to know which subsystems care; it only knows "the
  user selected this workspace."
- One IPC round-trip instead of three on every `setWorkingDirectory`.
- One call site to keep in sync — three subsystems coming and going over
  time become a maintenance liability if each owns its own channel.

**Arguments against**:
- Couples three independent subsystems behind one channel; if one starts to
  need a payload shape the others don't, the channel grows or we have to
  fork.
- Mitigation: keep payload shape minimal (`{ path: string; nodeId?: string }`)
  and let each coordinator extract what it needs.

**Migration nuance**: if either sibling spec lands first and ships its own
channel, two strategies:
1. **Preferred**: introduce `WORKSPACE_HINT_ACTIVE` and immediately delete
   the sibling's channel (one PR, one rename — both specs are still in
   Draft, so neither has a stable API to honour yet).
2. **Fallback**: register an extra subscriber on whichever channel landed
   first. This spec then doesn't introduce its own channel.

The Files-to-touch table below assumes strategy (1).

### Startup behaviour

In `src/main/app/initialization-steps.ts`, after the `'Codemem'` step
(line 510), wire the coordinator and emit a startup hint for the
most-recent local directory if any exists. Same rule as specs 1 and 2 —
only the **most-recent** entry warms on boot, not the full recents list:

```ts
{
  name: 'Project knowledge auto-mirror',
  fn: async () => {
    const coordinator = getProjectKnowledgeAutoMirrorCoordinator();
    coordinator.start();
    if (!getSettingsManager().getAll().projectKnowledgeAutoMirrorStartupHint) return;
    const recents = await getRecentDirectoriesManager().getDirectories({ limit: 1 });
    const top = recents[0];
    if (top && !top.nodeId) {
      coordinator.hintActiveWorkspace(top.path);
    }
  },
},
```

Keep the existing `ensureProjectKnown(..., 'instance-working-directory')`
call in `instance-lifecycle.ts:1172` unchanged.

### De-duplication with the spawn-time call

The bridge has `inflight: Map<string, Promise<…>>`
(`project-code-index-bridge.ts:99`, cleared in `.finally()` at line 128).
This deduplicates **concurrent** calls but gives no protection against a
recently-completed sync: if pre-mirror finishes at T=0 and the user spawns
at T=200ms, the spawn-time call re-enters the full bridge pipeline (preflight
walk, codemem ensureWorkspace, full snapshot replay in one transaction).

Two layers protect against that:

1. **In the new coordinator only** — short-circuit on a recent
   `lastSyncedAt`. Read
   `getProjectKnowledgeCoordinator().getProjectStatus(path)` (returns
   `CodebaseMiningStatus`) and `ProjectCodeIndexBridge.getStatus(projectKey)`
   (already exists; reads `lastSyncedAt`). Skip the
   `ensureProjectKnown` call if `lastSyncedAt` is within
   `projectKnowledgeAutoMirrorSkipWithinMs` (default 30_000). This only
   skips the **coordinator's** retrigger — it doesn't touch the spawn-time
   call or the manual refresh path.
2. **Do not add a TTL inside the bridge itself.** Manual refresh and
   spawn-time always need to be free to re-run regardless of how recently
   the last sync completed (the spawn-time call is the safety net; if we
   gate it by TTL, restored-from-history instances will re-show stale
   data). The TTL belongs in the auto-mirror coordinator only.

The bridge's existing `inflight` map continues to handle the concurrent
overlap case (pre-mirror still running when spawn happens) — that path is
already correct.

### Settings

Add to `src/shared/types/settings.types.ts` (alongside the existing codemem
prewarm keys from spec 1):

```ts
/**
 * When true, the RLM project-knowledge mirror (ProjectCodeIndexBridge +
 * CodebaseMiner via ProjectKnowledgeCoordinator) refreshes automatically
 * the moment a workspace path enters the app. Gated by codememEnabled +
 * codememIndexingEnabled — without those the bridge has nothing to mirror.
 */
projectKnowledgeAutoMirrorEnabled: boolean;        // default true
projectKnowledgeAutoMirrorDebounceMs: number;      // default 2000
projectKnowledgeAutoMirrorMaxConcurrent: number;   // default 2
projectKnowledgeAutoMirrorSkipWithinMs: number;    // default 30_000
projectKnowledgeAutoMirrorStartupHint: boolean;    // default true
```

Defaults to the corresponding `DEFAULT_SETTINGS` block.

Effective gate at coordinator level:
```
codememEnabled && codememIndexingEnabled && projectKnowledgeAutoMirrorEnabled
```

## Files to touch

| File | Change |
|---|---|
| `src/main/memory/project-knowledge-auto-mirror-coordinator.ts` | **new** — listener, debounce, concurrency cap, `lastSyncedAt` short-circuit, `hintActiveWorkspace` API, `start()` / `stop()` lifecycle |
| `src/main/memory/index.ts` | export `getProjectKnowledgeAutoMirrorCoordinator()` helper (lazy singleton + `_resetForTesting`) |
| `src/main/memory/project-root-registry.ts:66-69` | comment-only — note that `'recent-directory-open'` is a valid auto-mine source |
| `src/main/app/initialization-steps.ts` | add a new `'Project knowledge auto-mirror'` step after the `'Codemem'` step; call `coordinator.start()` and emit startup hint for most-recent local dir |
| `src/shared/types/knowledge-graph.types.ts:76-80` | extend `ProjectDiscoverySource` union with `'recent-directory-open'` |
| `packages/contracts/src/channels/workspace.channels.ts` | add `WORKSPACE_HINT_ACTIVE: 'workspace:hint-active'` (remove sibling channels per migration strategy 1, if they land first) |
| `packages/contracts/src/schemas/workspace-tools.schemas.ts` (or new `workspace.schemas.ts`) | add `WorkspaceHintActivePayloadSchema` (`{ path: string; nodeId?: string | null }`) |
| `src/main/ipc/handlers/workspace-handlers.ts` (or new `workspace-hint-handler.ts`) | register `WORKSPACE_HINT_ACTIVE`, fan out to all three coordinators (each call wrapped in `try { ... } catch` so a missing/disabled coordinator is a no-op) |
| `src/preload/domains/workspace.preload.ts` | expose `workspace.hintActive(payload)` |
| `src/renderer/app/core/services/new-session-draft.service.ts:60` | call `workspace.hintActive({ path, nodeId })` from `setWorkingDirectory` (replaces spec-1 and spec-2 calls if they landed) |
| `src/shared/types/settings.types.ts` | add five new keys + defaults |
| `packages/contracts/src/schemas/settings.schemas.ts` | mirror the new keys into the settings schema if it validates `AppSettings` |
| `src/main/persistence/rlm/rlm-codebase-mining.ts` | no code change — confirm the new discovery-source string flows through the existing TEXT column without migration |

### Packaging-gotcha check

No new `@contracts/schemas/...` subpath added (`workspace-tools.schemas` already
exists; if we add a new `workspace.schemas` file instead, update **all three**
of `tsconfig.json`, `tsconfig.electron.json`, and
`src/main/register-aliases.ts` (`exactAliases`) per the rule in `AGENTS.md`,
plus `vitest.config.ts` if the new path is imported from tests). No Electron
bump.

## Tests

1. **`src/main/memory/__tests__/project-knowledge-auto-mirror-coordinator.spec.ts`** —
   - Fires `ensureProjectKnown(path, 'recent-directory-open', { autoRefresh: true })`
     on `'directory-added'` for a local path.
   - Skips remote (`nodeId` present).
   - Skips when `projectKnowledgeAutoMirrorEnabled === false`.
   - Skips when codemem reports `isEnabled() === false` or
     `isIndexingEnabled() === false`.
   - Skips when `projectRootRegistry.canAutoMine(path)` returns false
     (pause + exclude cases).
   - Debounces multiple events for the same path within window (default
     2000 ms) into a single `ensureProjectKnown` call.
   - Concurrency cap honoured — third in-flight request queues until one
     completes.
   - `lastSyncedAt` short-circuit: if the bridge's status reports
     `lastSyncedAt = Date.now() - 5_000` and the threshold is 30_000, the
     coordinator does **not** call `ensureProjectKnown`.
   - De-duplication with concurrent `refreshProject`: when the bridge's
     `inflight` map already has an entry for the project, the coordinator's
     own call awaits the existing promise (this is the bridge's behaviour;
     verified by mocking the bridge and asserting the coordinator does not
     try to bypass it).
   - `hintActiveWorkspace(path)` reorders the queue — the hinted path runs
     ahead of others already queued.
2. **`src/main/ipc/handlers/__tests__/workspace-hint-handler.spec.ts`** (new
   or merged into existing workspace-handlers spec) —
   - `WORKSPACE_HINT_ACTIVE` routes to all three coordinator hint methods.
   - A throwing coordinator does not prevent the others from receiving the
     hint.
   - Rejects/short-circuits on invalid payloads via Zod schema.
3. **`src/tests/unit/memory/project-knowledge-coordinator.test.ts`** —
   add a case asserting `ensureRoot(path, 'recent-directory-open')` is
   accepted and round-trips through `canAutoMine` without modification.
4. **`src/tests/unit/memory/project-code-index-bridge.test.ts`** —
   verify the existing inflight-dedupe case (line 96-115) still passes
   unchanged.
5. **Integration**: open a small fixture directory through the
   recent-directories IPC (no instance spawn), wait for the
   coordinator's `'mirrored'` event (or poll for status), then assert:
   - `getProjectCodeIndexStatus(db, projectKey).status === 'ready'`,
   - `getProjectCodeIndexStatus(db, projectKey).lastSyncedAt` set,
   - `listProjectKnowledgeSources(db, projectKey)` returns one or more
     `code_file` rows for the fixture,
   - **no `Instance` rows or running instances** were created during the
     test.

## Acceptance criteria

- [ ] Opening a folder in the UI (any of the call sites that hit
      `RecentDirectoriesManager.addDirectory`) starts a project-knowledge
      auto-mirror within `projectKnowledgeAutoMirrorDebounceMs`, observable
      via `getProjectCodeIndexStatus(...).status` transitioning from
      `'never'` → `'indexing'` → `'ready'`, with no instance spawn.
- [ ] Spawning an instance against a workspace that was just auto-mirrored
      (within `projectKnowledgeAutoMirrorSkipWithinMs`) does **not** cause
      the bridge to re-run a full snapshot — confirmed by spying the bridge
      mock or by observing `lastSyncedAt` does not advance.
- [ ] Remote paths (`entry.nodeId` truthy) do not trigger the coordinator.
- [ ] Excluded or paused projects are no-ops via the existing
      `ProjectKnowledgeCoordinator` gate.
- [ ] Disabling `projectKnowledgeAutoMirrorEnabled` cleanly disables the
      coordinator without affecting the spawn-time path or the manual
      `PROJECT_KNOWLEDGE_REFRESH_CODE_INDEX` IPC.
- [ ] `WORKSPACE_HINT_ACTIVE` fans out to all live coordinators; the
      renderer's `setWorkingDirectory` only emits this one channel.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx tsc --noEmit -p tsconfig.spec.json` clean.
- [ ] `npm run lint` clean.
- [ ] `src/tests/unit/memory/project-code-index-bridge.test.ts` and
      `src/tests/unit/memory/project-knowledge-coordinator.test.ts` pass
      without modification (other than the additive case in test 3 above).
- [ ] Manual smoke (per `verify` skill): launch the app, open a folder via
      the welcome screen, do **not** spawn an instance, open the
      Project-Knowledge / KG view and confirm the folder shows
      `code_file` sources and `code_symbol` evidence rows.

## Risks

- **Mirror cost** — not free. The bridge does a preflight directory walk
  (capped at `PROJECT_CODE_INDEX_MAX_FILES = 5_000` files and
  `MAX_BYTES = 250 MiB`), reads the full symbol list from codemem (capped
  at `MAX_SYMBOLS = 100_000`), and replays the snapshot into RLM in a
  single transaction. On a workspace that fits inside those caps this is
  typically sub-second once codemem has a manifest. On a workspace that
  exceeds them, the bridge writes a `'failed'` status with
  `metadata.reason === 'limit_exceeded'` and does not touch the knowledge
  store — the auto-mirror coordinator must not retry-loop on that
  terminal status (use the `lastSyncedAt` / `lastSyncedAt`-equivalent on
  the failed row to dedupe, or skip if `status === 'failed' && lastError`
  is `limit_exceeded`).
- **Codemem cold-index latency** — the bridge calls
  `getCodemem().ensureWorkspace(rootPath)` inside a 120 s timeout
  (`PROJECT_CODE_INDEX_TIMEOUT_MS`). On a freshly-opened workspace with
  no codemem warm-up, the bridge will sit behind codemem's cold index for
  up to that long. If spec 1 (`codemem-auto-warm-on-workspace-open`) has
  landed, codemem will have warmed on the same `'directory-added'`
  event ahead of (or in parallel with) the bridge; the bridge then sees a
  warm workspace and finishes fast. If spec 1 has not landed, the bridge
  triggers codemem itself via `ensureWorkspace` — same end-state, longer
  first-mirror latency. Either way the user is unblocked because the call
  is fire-and-forget.
- **Large-repo limits**: `PROJECT_CODE_INDEX_MAX_FILES = 5_000`,
  `MAX_BYTES = 250 MiB`, `MAX_SYMBOLS = 100_000`. These are bridge-side,
  not coordinator-side; the coordinator does not need its own preflight.
  Workspaces above the limits get a `'failed'` status row with explicit
  `limit_exceeded` metadata — visible in the Project-Knowledge UI so the
  user can see why. The coordinator should respect that as a terminal
  state for the current `lastSyncedAt`/`updated_at` window and not retry
  in tight loops (an explicit user action — opening the folder again
  after the limits change, or hitting "manual refresh" — re-runs it).
- **Race with spawn-time call** — bridge's `inflight` map handles
  concurrent overlap (both `ensureProjectKnown` paths route through
  `refreshProject` → same map). For a *recently completed* pre-mirror,
  the spawn-time call still re-runs the full pipeline today; the
  coordinator-side `lastSyncedAt` short-circuit fixes that for the
  coordinator path but deliberately not for spawn-time (we keep that as
  the always-fresh safety net for restored / re-attached instances).
- **Channel consolidation churn** — if specs 1 or 2 land first with their
  own `*_HINT` channels, this spec has to either delete those (preferred,
  while they're still in Draft) or keep them and forgo consolidation.
  Calling this out up front so reviewers can land all three in a single
  coordinated sequence rather than as drive-by edits.
- **`AGENTS.md` packaging trap** — if implementation introduces a new
  `@contracts/schemas/workspace` subpath (rather than reusing
  `workspace-tools.schemas.ts`), all three alias maps **and**
  `vitest.config.ts` must be updated, or the packaged DMG will crash on
  startup with `Cannot find module '…/schemas/workspace'`. Typecheck and
  lint will pass — the test is "run the DMG."
