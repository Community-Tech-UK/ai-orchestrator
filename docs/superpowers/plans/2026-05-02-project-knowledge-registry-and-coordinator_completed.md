# Project Knowledge Registry And Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Wave 1 of unified project memory: one persisted project-root/mining status registry backed by `codebase_mining_status`, plus a thin coordinator that routes manual/default/instance auto-mining through existing `CodebaseMiner`.

**Architecture:** Extend the existing mining status table instead of adding a parallel project-root table. Add `ProjectRootRegistry` as the persistence-facing service and `ProjectKnowledgeCoordinator` as a narrow orchestration wrapper around `CodebaseMiner`; later waves can subscribe indexing/codemem/conversation layers to this registry. UI and IPC keep the existing codebase mining surface but become pause/exclude aware.

**Tech Stack:** TypeScript 5.9, Electron main process, Angular 21 renderer, better-sqlite3/RLM migrations, Zod IPC payload schemas, Vitest.

---

## Reviewer Consensus

Claude and Gemini both approved the direction only with scope cuts:

- Do not create a new `project_roots` table while `codebase_mining_status` already persists project mining state.
- Keep Wave 1 focused on high-signal codebase mining only.
- Do not start recursive indexing/codemem/conversation mining in this slice.
- Make pause/exclude state part of the authoritative persisted status before broad auto-discovery.
- Route instance lifecycle auto-mining through a coordinator so direct calls do not duplicate work.

## Files

- Modify: `src/shared/types/knowledge-graph.types.ts`
  - Add project-root metadata fields to `CodebaseMiningStatus` and `CodebaseMiningResult`.
  - Add `ProjectDiscoverySource`.
  - Add skip reasons `paused` and `excluded`.
- Modify: `src/main/persistence/rlm-database.types.ts`
  - Add registry columns to `CodebaseMiningStatusRow`.
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
  - Add migration `019_project_root_registry` so already-applied local databases are upgraded safely.
- Modify: `src/main/persistence/rlm/rlm-codebase-mining.ts`
  - Add registry upsert/read/list/pause/resume/exclude functions.
  - Preserve existing mining result/status behavior.
- Create: `src/main/memory/project-root-registry.ts`
  - Normalize paths, derive display names, persist discovery metadata, and expose pause/resume/exclude.
- Create: `src/main/memory/project-knowledge-coordinator.ts`
  - Ensure project roots exist and route refreshes through `CodebaseMiner`.
- Modify: `src/main/memory/codebase-miner.ts`
  - Normalize persisted keys with `normalizeProjectMemoryKey`.
  - Ensure direct mining creates/updates a registry row with safe defaults.
  - Return registry metadata in status/result.
- Modify: `src/main/memory/index.ts`
  - Export registry and coordinator helpers.
- Modify: `src/main/bootstrap/memory-bootstrap.ts`
  - Initialize the coordinator helper in memory bootstrap.
- Modify: `src/main/instance/instance-lifecycle.ts`
  - Replace direct `getCodebaseMiner().mineDirectory(...)` auto-mining with `getProjectKnowledgeCoordinator().ensureProjectKnown(..., { autoRefresh: true })`.
- Modify: `src/main/ipc/handlers/knowledge-graph-handlers.ts`
  - Route mine/status through the coordinator.
  - Add pause/resume/exclude IPC handlers.
- Modify: `packages/contracts/src/channels/memory.channels.ts`
  - Add codebase pause/resume/exclude channels.
- Modify: `packages/contracts/src/schemas/knowledge.schemas.ts`
  - Add payload schemas for pause/resume/exclude.
- Modify: `src/preload/generated/channels.ts`
  - Mirror channel constants used by preload.
- Modify: `src/preload/domains/memory.preload.ts`
  - Expose pause/resume/exclude methods.
- Modify: `src/renderer/app/core/services/ipc/memory-ipc.service.ts`
  - Add typed wrappers for pause/resume/exclude.
- Modify: `src/renderer/app/core/state/knowledge.store.ts`
  - Add pause/resume/exclude actions and preserve registry metadata in local mining status.
- Modify: `src/renderer/app/features/knowledge/knowledge-page.component.ts`
  - Show paused/excluded/auto-mine metadata for the current directory.
  - Add pause/resume controls for the current directory.
- Test: `src/tests/unit/memory/codebase-miner.test.ts`
  - Extend existing coverage for registry metadata and paused direct status.
- Create test: `src/tests/unit/memory/project-root-registry.test.ts`
  - Cover root registration, metadata persistence, pause/resume/exclude, and preserving existing mining status.
- Create test: `src/tests/unit/memory/project-knowledge-coordinator.test.ts`
  - Cover auto-refresh behavior, paused/excluded skip behavior, and in-flight dedupe.
- Test: `src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`
  - Cover pause/resume/exclude button rendering and dispatch.

## Task 1: Persistence And Shared Type Tests

- [ ] **Step 1: Add failing registry tests**

Create `src/tests/unit/memory/project-root-registry.test.ts` with tests that use the same in-memory RLM setup pattern as `codebase-miner.test.ts`.

The tests should assert:

```ts
const registry = ProjectRootRegistry.getInstance();
const root = registry.ensureRoot('/fake/project', 'manual-browse');
expect(root).toMatchObject({
  normalizedPath: '/fake/project',
  rootPath: '/fake/project',
  projectKey: '/fake/project',
  discoverySource: 'manual-browse',
  autoMine: true,
  isPaused: false,
  isExcluded: false,
  displayName: 'project',
});

registry.pauseRoot('/fake/project');
expect(registry.getRoot('/fake/project')?.isPaused).toBe(true);

registry.resumeRoot('/fake/project');
expect(registry.getRoot('/fake/project')?.isPaused).toBe(false);

registry.excludeRoot('/fake/project');
expect(registry.getRoot('/fake/project')?.isExcluded).toBe(true);
```

Also add a test that creates a completed mining status through `CodebaseMiner.mineDirectory`, then calls `registry.ensureRoot(...)` and verifies all mining columns are preserved:

```ts
expect(root).toMatchObject({
  status: 'completed',
  contentFingerprint: expect.any(String),
  filesRead: expect.any(Number),
  factsExtracted: expect.any(Number),
  hintsCreated: expect.any(Number),
  startedAt: expect.any(Number),
  completedAt: expect.any(Number),
  errors: [],
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npx vitest run src/tests/unit/memory/project-root-registry.test.ts
```

Expected: fail because `project-root-registry.ts` does not exist.

- [ ] **Step 3: Extend shared types**

In `src/shared/types/knowledge-graph.types.ts`, add:

```ts
export type ProjectDiscoverySource =
  | 'manual'
  | 'manual-browse'
  | 'default-working-directory'
  | 'instance-working-directory';
```

Extend `CodebaseMiningStatus`:

```ts
rootPath?: string;
projectKey?: string;
displayName?: string;
discoverySource?: ProjectDiscoverySource;
autoMine?: boolean;
isPaused?: boolean;
isExcluded?: boolean;
lastActiveAt?: number;
```

Extend `CodebaseMiningResult.skipReason`:

```ts
skipReason?: 'unchanged' | 'in-flight' | 'paused' | 'excluded';
```

Mirror the useful metadata fields on `CodebaseMiningResult`:

```ts
rootPath?: string;
projectKey?: string;
displayName?: string;
discoverySource?: ProjectDiscoverySource;
autoMine?: boolean;
isPaused?: boolean;
isExcluded?: boolean;
```

- [ ] **Step 4: Extend DB row type and migration**

In `src/main/persistence/rlm-database.types.ts`, add registry fields to `CodebaseMiningStatusRow`:

```ts
root_path: string;
project_key: string;
display_name: string;
discovery_source: string;
auto_mine: number;
is_paused: number;
is_excluded: number;
last_active_at: number | null;
created_at: number;
metadata_json: string;
```

Do not edit migration `018_codebase_mining_status` in place. Add migration `019_project_root_registry` in `src/main/persistence/rlm/rlm-schema.ts`.

Migration `019` must use SQLite's rename/copy pattern because the `status` `CHECK` constraint must allow `'never'`:

```sql
DROP INDEX IF EXISTS idx_codebase_mining_status_status;
ALTER TABLE codebase_mining_status RENAME TO codebase_mining_status_old;

CREATE TABLE codebase_mining_status (
  normalized_path TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  project_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  discovery_source TEXT NOT NULL DEFAULT 'manual',
  auto_mine INTEGER NOT NULL DEFAULT 1,
  is_paused INTEGER NOT NULL DEFAULT 0,
  is_excluded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('never', 'running', 'completed', 'failed')),
  content_fingerprint TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  facts_extracted INTEGER NOT NULL DEFAULT 0,
  hints_created INTEGER NOT NULL DEFAULT 0,
  files_read INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  completed_at INTEGER,
  last_active_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO codebase_mining_status (
  normalized_path, root_path, project_key, display_name, discovery_source,
  auto_mine, is_paused, is_excluded, status, content_fingerprint, files_json,
  facts_extracted, hints_created, files_read, errors_json, started_at,
  completed_at, last_active_at, created_at, updated_at, metadata_json
)
SELECT
  normalized_path,
  normalized_path,
  normalized_path,
  normalized_path,
  'manual',
  1,
  0,
  0,
  status,
  content_fingerprint,
  files_json,
  facts_extracted,
  hints_created,
  files_read,
  errors_json,
  started_at,
  completed_at,
  updated_at,
  COALESCE(started_at, updated_at),
  updated_at,
  '{}'
FROM codebase_mining_status_old;

DROP TABLE codebase_mining_status_old;

CREATE INDEX IF NOT EXISTS idx_codebase_mining_status_status
  ON codebase_mining_status(status, updated_at);
```

- [ ] **Step 5: Add persistence helpers**

In `src/main/persistence/rlm/rlm-codebase-mining.ts`, add exported helpers:

```ts
export interface EnsureProjectRootParams {
  normalizedPath: string;
  rootPath: string;
  projectKey: string;
  displayName: string;
  discoverySource: ProjectDiscoverySource;
  autoMine?: boolean;
  lastActiveAt: number;
}

export function ensureProjectRoot(db: SqliteDriver, params: EnsureProjectRootParams): CodebaseMiningStatus;
export function listProjectRoots(db: SqliteDriver): CodebaseMiningStatus[];
export function pauseProjectRoot(db: SqliteDriver, normalizedPath: string, updatedAt: number): CodebaseMiningStatus | undefined;
export function resumeProjectRoot(db: SqliteDriver, normalizedPath: string, updatedAt: number): CodebaseMiningStatus | undefined;
export function excludeProjectRoot(db: SqliteDriver, normalizedPath: string, updatedAt: number): CodebaseMiningStatus | undefined;
```

Implementation rule: `ensureProjectRoot` inserts a `never` row if absent. On conflict, `discoverySource`, `rootPath`, `projectKey`, and `createdAt` are not overwritten. The conflict update set is limited to `display_name`, `auto_mine`, `last_active_at`, and `updated_at`; it must not clear existing mining counts, fingerprints, errors, or completed status.

- [ ] **Step 6: Run registry tests**

Run:

```bash
npx vitest run src/tests/unit/memory/project-root-registry.test.ts
```

Expected: still fail until Task 2 creates the registry service.

## Task 2: ProjectRootRegistry

- [ ] **Step 1: Create `src/main/memory/project-root-registry.ts`**

Implement:

```ts
export class ProjectRootRegistry {
  static getInstance(): ProjectRootRegistry;
  static _resetForTesting(): void;

  ensureRoot(rootPath: string, discoverySource: ProjectDiscoverySource): CodebaseMiningStatus;
  getRoot(rootPath: string): CodebaseMiningStatus | undefined;
  listRoots(): CodebaseMiningStatus[];
  pauseRoot(rootPath: string): CodebaseMiningStatus | undefined;
  resumeRoot(rootPath: string): CodebaseMiningStatus | undefined;
  excludeRoot(rootPath: string): CodebaseMiningStatus | undefined;
  canAutoMine(rootPath: string): boolean;
  canManualMine(rootPath: string): boolean;
}
```

Use `normalizeProjectMemoryKey(rootPath)` for the key and `path.basename(...)` for display name. If normalization returns an empty string, throw `Error('Project path is required')`.

Permission semantics:

- `canAutoMine` returns false when paused or excluded.
- `canManualMine` returns false only when excluded.
- Paused means "stop background/automatic mining"; it does not forbid an explicit user-triggered refresh.

- [ ] **Step 2: Export registry helper**

In `src/main/memory/index.ts`, export:

```ts
export { ProjectRootRegistry, getProjectRootRegistry } from './project-root-registry';
```

- [ ] **Step 3: Run registry tests**

Run:

```bash
npx vitest run src/tests/unit/memory/project-root-registry.test.ts
```

Expected: pass.

## Task 3: ProjectKnowledgeCoordinator

- [ ] **Step 1: Add failing coordinator tests**

Create `src/tests/unit/memory/project-knowledge-coordinator.test.ts`.

Use constructor injection so the test can pass fake dependencies:

```ts
const miner = {
  mineDirectory: vi.fn(),
  getStatus: vi.fn(),
};

const registry = {
  ensureRoot: vi.fn(),
  getRoot: vi.fn(),
  pauseRoot: vi.fn(),
  resumeRoot: vi.fn(),
  excludeRoot: vi.fn(),
  canAutoMine: vi.fn(),
  canManualMine: vi.fn(),
};
```

Test cases:

- `ensureProjectKnown(path, 'instance-working-directory', { autoRefresh: true })` calls `registry.ensureRoot` and `miner.mineDirectory` when `canAutoMine` is true.
- The same call does not mine when the root is paused.
- `refreshProject(path, 'manual-browse')` mines even if `autoMine` is false or the root is paused.
- `refreshProject(path, 'manual-browse')` does not mine when the root is excluded.
- Two concurrent `refreshProject` calls for the same normalized path share one miner call.
- `getProjectStatus(path)` delegates to `miner.getStatus(path)` without creating a registry row when the path has never been registered.

- [ ] **Step 2: Run the coordinator test and verify it fails**

Run:

```bash
npx vitest run src/tests/unit/memory/project-knowledge-coordinator.test.ts
```

Expected: fail because `project-knowledge-coordinator.ts` does not exist.

- [ ] **Step 3: Create `src/main/memory/project-knowledge-coordinator.ts`**

Implement:

```ts
export interface EnsureProjectKnownOptions {
  autoRefresh?: boolean;
}

export class ProjectKnowledgeCoordinator {
  static getInstance(): ProjectKnowledgeCoordinator;
  static _resetForTesting(): void;

  ensureProjectKnown(
    rootPath: string,
    discoverySource: ProjectDiscoverySource,
    options?: EnsureProjectKnownOptions,
  ): Promise<CodebaseMiningStatus | CodebaseMiningResult>;

  refreshProject(rootPath: string, discoverySource?: ProjectDiscoverySource): Promise<CodebaseMiningResult>;
  getProjectStatus(rootPath: string): CodebaseMiningStatus;
  pauseProject(rootPath: string): CodebaseMiningStatus | undefined;
  resumeProject(rootPath: string): CodebaseMiningStatus | undefined;
  excludeProject(rootPath: string): CodebaseMiningStatus | undefined;
}
```

Skip result for paused/excluded:

```ts
{
  normalizedPath,
  status: status.status,
  factsExtracted: 0,
  hintsCreated: 0,
  filesRead: status.filesRead ?? 0,
  errors: status.errors ?? [],
  skipped: true,
  skipReason: status.isExcluded ? 'excluded' : 'paused',
}
```

Use this skipped result only for auto-refresh paused and excluded cases, and for manual excluded cases. Manual refresh is allowed while paused.

- [ ] **Step 4: Export coordinator helper**

In `src/main/memory/index.ts`, export:

```ts
export { ProjectKnowledgeCoordinator, getProjectKnowledgeCoordinator } from './project-knowledge-coordinator';
```

- [ ] **Step 5: Run coordinator tests**

Run:

```bash
npx vitest run src/tests/unit/memory/project-knowledge-coordinator.test.ts
```

Expected: pass.

## Task 4: Integrate CodebaseMiner With Registry Metadata

- [ ] **Step 1: Extend existing miner tests**

In `src/tests/unit/memory/codebase-miner.test.ts`, add assertions that a mined status includes:

```ts
projectKey: '/fake/project',
rootPath: '/fake/project',
displayName: 'project',
discoverySource: 'manual',
autoMine: true,
isPaused: false,
isExcluded: false,
```

Add a test that pauses a root through `ProjectRootRegistry`, then verifies `CodebaseMiner.getStatus` reports `isPaused: true`.

- [ ] **Step 2: Run miner tests and verify failure**

Run:

```bash
npx vitest run src/tests/unit/memory/codebase-miner.test.ts
```

Expected: fail until the miner and persistence mapping return metadata.

- [ ] **Step 3: Update `CodebaseMiner`**

Changes:

- Replace `path.resolve(dirPath)` as the persisted key with `normalizeProjectMemoryKey(dirPath) || path.resolve(dirPath)`.
- Before `beginMining`, call `miningStore.ensureProjectRoot(...)` with discovery source `manual`.
- Ensure skipped unchanged results include registry metadata from prior status.
- Ensure failed/completed status writes preserve registry metadata through `ON CONFLICT` behavior.

- [ ] **Step 4: Run miner tests**

Run:

```bash
npx vitest run src/tests/unit/memory/codebase-miner.test.ts
```

Expected: pass.

## Task 5: IPC, Preload, Renderer Store, And Knowledge UI

- [ ] **Step 1: Add IPC channels and schemas**

In `packages/contracts/src/channels/memory.channels.ts`, add:

```ts
CODEBASE_PAUSE_PROJECT: 'codebase:pause-project',
CODEBASE_RESUME_PROJECT: 'codebase:resume-project',
CODEBASE_EXCLUDE_PROJECT: 'codebase:exclude-project',
```

In `packages/contracts/src/schemas/knowledge.schemas.ts`, add schemas with `{ dirPath: z.string().min(1) }`.

Mirror the channels in `src/preload/generated/channels.ts`.

- [ ] **Step 2: Route handlers through coordinator**

In `src/main/ipc/handlers/knowledge-graph-handlers.ts`:

- Replace `getCodebaseMiner().mineDirectory` with `getProjectKnowledgeCoordinator().refreshProject(data.dirPath, 'manual-browse')`.
- Replace `getCodebaseMiner().getStatus` with `getProjectKnowledgeCoordinator().getProjectStatus(data.dirPath)`.
- Add handlers for pause/resume/exclude.

- [ ] **Step 3: Add preload and renderer wrappers**

In `src/preload/domains/memory.preload.ts`, add:

```ts
codebasePauseProject: (payload: unknown) => ipcRenderer.invoke(ch.CODEBASE_PAUSE_PROJECT, payload)
codebaseResumeProject: (payload: unknown) => ipcRenderer.invoke(ch.CODEBASE_RESUME_PROJECT, payload)
codebaseExcludeProject: (payload: unknown) => ipcRenderer.invoke(ch.CODEBASE_EXCLUDE_PROJECT, payload)
```

In `src/renderer/app/core/services/ipc/memory-ipc.service.ts`, add matching methods.

- [ ] **Step 4: Add KnowledgeStore actions**

In `src/renderer/app/core/state/knowledge.store.ts`, add:

```ts
async pauseMining(dirPath: string): Promise<void>
async resumeMining(dirPath: string): Promise<void>
async excludeMining(dirPath: string): Promise<void>
```

Each method calls the IPC wrapper and updates `_miningStatus` from returned data.

- [ ] **Step 5: Add existing-panel UI controls**

In `src/renderer/app/features/knowledge/knowledge-page.component.ts`:

- Show `Paused` when `miningStatus()?.isPaused` is true.
- Show `Excluded` when `miningStatus()?.isExcluded` is true.
- Add `Pause` button when current status is not paused/excluded.
- Add `Resume` button when paused.
- Add `Exclude` button only when not excluded.
- Disable `Mine` only when excluded. Show a paused badge/warning when paused.

Do not build the full project selector in this slice.

- [ ] **Step 6: Update UI component tests**

In `src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`, add tests that:

- Render Pause when `miningStatus.isPaused === false && isExcluded === false`.
- Render Resume when `miningStatus.isPaused === true`.
- Disable Mine only when `isExcluded === true`.
- Click Pause/Resume/Exclude and verify the store methods are called with the current `mineDir`.

- [ ] **Step 7: Compile renderer/main types**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: pass.

## Task 6: Instance Lifecycle Wiring

- [ ] **Step 1: Update imports**

In `src/main/instance/instance-lifecycle.ts`, replace:

```ts
import { getCodebaseMiner } from '../memory/codebase-miner';
```

with:

```ts
import { getProjectKnowledgeCoordinator } from '../memory/project-knowledge-coordinator';
```

- [ ] **Step 2: Replace fire-and-forget mining call**

Replace:

```ts
getCodebaseMiner().mineDirectory(instance.workingDirectory).catch(...)
```

with:

```ts
getProjectKnowledgeCoordinator()
  .ensureProjectKnown(instance.workingDirectory, 'instance-working-directory', { autoRefresh: true })
  .catch(...)
```

Keep the existing non-fatal logging behavior.

- [ ] **Step 3: Update tests/mocks that reference `getCodebaseMiner` through lifecycle**

Search:

```bash
rg -n "getCodebaseMiner|mineDirectory" src/main/instance src/tests packages -g '*.ts'
```

Update mocks that expected lifecycle auto-mining to mock `getProjectKnowledgeCoordinator` instead.

- [ ] **Step 4: Run affected tests**

Run:

```bash
npx vitest run src/main/instance/__tests__/instance-manager.spec.ts src/main/instance/__tests__/instance-manager.normalized-event.spec.ts src/tests/unit/memory/codebase-miner.test.ts src/tests/unit/memory/project-root-registry.test.ts src/tests/unit/memory/project-knowledge-coordinator.test.ts
```

Expected: pass.

## Task 7: Verification And Plan Review Closure

- [ ] **Step 1: Run targeted memory/KG tests**

Run:

```bash
npx vitest run src/tests/unit/memory/codebase-miner.test.ts src/tests/unit/memory/project-root-registry.test.ts src/tests/unit/memory/project-knowledge-coordinator.test.ts src/tests/unit/memory/knowledge-graph-service.test.ts src/tests/unit/persistence/rlm-knowledge-graph.test.ts
```

- [ ] **Step 2: Run full quality checks**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

- [ ] **Step 3: Restore Electron native ABI if Vitest rebuilds native modules**

If `npm run test` rebuilds `better-sqlite3` for Node, run:

```bash
npm run rebuild:native
```

- [ ] **Step 4: Final diff audit**

Run:

```bash
git diff --check
git status --short
```

Report:

- Spec review consensus.
- Plan review consensus.
- Implemented files.
- Verification commands and exact pass/fail results.
- Any incomplete waves explicitly left for later.

## Out Of Scope For This Plan

- Recursive code indexing/codemem project-key integration.
- Source registry/provenance tables.
- Conversation candidate staging/promotion.
- Startup brief retrieval rewrite.
- Full project selector and evidence inspector.
- Provider-native write-back.
