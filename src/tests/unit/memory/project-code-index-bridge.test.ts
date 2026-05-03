import { mkdir, mkdtemp, rm, writeFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../../main/db/sqlite-driver';
import * as schema from '../../../main/persistence/rlm/rlm-schema';
import { ProjectCodeIndexBridge, type ProjectCodeIndexSource } from '../../../main/memory/project-code-index-bridge';
import type { CodebaseMiningStatus } from '../../../shared/types/knowledge-graph.types';
import type { WorkspaceManifestRow, WorkspaceSymbolRecord } from '../../../main/codemem/types';
import { listProjectKnowledgeSources } from '../../../main/persistence/rlm/rlm-project-knowledge';
import { listProjectCodeSymbols } from '../../../main/persistence/rlm/rlm-project-code-index';

describe('ProjectCodeIndexBridge', () => {
  let db: SqliteDriver;
  let rawDb: Database.Database;
  let tempDirs: string[];

  beforeEach(() => {
    ProjectCodeIndexBridge._resetForTesting();
    vi.clearAllMocks();
    rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = rawDb;
    schema.createTables(db);
    schema.createMigrationsTable(db);
    schema.runMigrations(db);
    tempDirs = [];
  });

  afterEach(async () => {
    rawDb.close();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('syncs manifest files and symbols into project memory', async () => {
    const rootPath = await createProject({ 'src/main.ts': 'export function bootstrap() {}' });
    const source = createSource({
      manifestEntries: [manifest('workspace-1', 'src/main.ts')],
      symbols: [symbol('workspace-1', 'symbol-1', 'src/main.ts', 'bootstrap')],
    });
    const bridge = createBridge(rootPath, source);

    const status = await bridge.refreshProject(rootPath);

    expect(status).toMatchObject({
      status: 'ready',
      workspaceHash: 'workspace-1',
      fileCount: 1,
      symbolCount: 1,
      metadata: { snapshotVersion: 1 },
    });
    expect(listProjectKnowledgeSources(db, rootPath)).toMatchObject([
      {
        sourceKind: 'code_file',
        sourceUri: join(rootPath, 'src/main.ts'),
        contentFingerprint: 'hash-src/main.ts',
      },
    ]);
    expect(listProjectCodeSymbols(db, rootPath)).toMatchObject([
      {
        targetKind: 'code_symbol',
        targetId: 'symbol-1',
        name: 'bootstrap',
        pathFromRoot: 'src/main.ts',
      },
    ]);
  });

  it('writes terminal statuses for disabled, paused, and excluded projects without indexing', async () => {
    const rootPath = await createProject();
    const disabled = createSource({ enabled: false });
    expect(await createBridge(rootPath, disabled).refreshProject(rootPath)).toMatchObject({
      status: 'disabled',
      metadata: { reason: 'codemem_disabled' },
    });
    expect(disabled.ensureWorkspace).not.toHaveBeenCalled();

    const pausedRoot = status(rootPath, { isPaused: true });
    const paused = createSource();
    expect(await createBridge(rootPath, paused, pausedRoot).refreshProject(rootPath)).toMatchObject({
      status: 'paused',
      metadata: { reason: 'project_paused' },
    });
    expect(paused.ensureWorkspace).not.toHaveBeenCalled();

    const excludedRoot = status(rootPath, { isExcluded: true });
    const excluded = createSource();
    expect(await createBridge(rootPath, excluded, excludedRoot).refreshProject(rootPath)).toMatchObject({
      status: 'excluded',
      metadata: { reason: 'project_excluded' },
    });
    expect(excluded.ensureWorkspace).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight refreshes for the same project key', async () => {
    const rootPath = await createProject({ 'src/main.ts': 'export const x = 1;' });
    let resolveEnsure!: (value: { workspaceHash: string; lastIndexedAt: number | null }) => void;
    const source = createSource({
      ensureWorkspace: vi.fn(() => new Promise((resolve) => {
        resolveEnsure = resolve;
      })),
      manifestEntries: [manifest('workspace-1', 'src/main.ts')],
      symbols: [symbol('workspace-1', 'symbol-1', 'src/main.ts', 'x')],
    });
    const bridge = createBridge(rootPath, source);

    const first = bridge.refreshProject(rootPath, { automatic: true });
    const second = bridge.refreshProject(`${rootPath}/`, { automatic: false });
    await vi.waitFor(() => expect(source.ensureWorkspace).toHaveBeenCalled());
    resolveEnsure({ workspaceHash: 'workspace-1', lastIndexedAt: 5 });

    await Promise.all([first, second]);
    expect(source.ensureWorkspace).toHaveBeenCalledTimes(1);
  });

  it('fails before codemem when file or byte limits are exceeded', async () => {
    const rootPath = await createProject({
      'a.ts': 'a',
      'b.ts': 'b',
    });
    const fileLimited = createSource();
    const fileStatus = await createBridge(rootPath, fileLimited, undefined, { maxFiles: 1 }).refreshProject(rootPath);
    expect(fileStatus).toMatchObject({
      status: 'failed',
      metadata: { reason: 'limit_exceeded', limit: 'files' },
    });
    expect(fileLimited.ensureWorkspace).not.toHaveBeenCalled();

    const byteLimited = createSource();
    const byteStatus = await createBridge(rootPath, byteLimited, undefined, { maxBytes: 1 }).refreshProject(rootPath);
    expect(byteStatus).toMatchObject({
      status: 'failed',
      metadata: { reason: 'limit_exceeded', limit: 'bytes' },
    });
    expect(byteLimited.ensureWorkspace).not.toHaveBeenCalled();
  });

  it('preserves prior rows on timeout, symbol-limit, and sync failures', async () => {
    const rootPath = await createProject({ 'src/main.ts': 'export function ok() {}' });
    const bridge = createBridge(rootPath, createSource({
      manifestEntries: [manifest('workspace-1', 'src/main.ts')],
      symbols: [symbol('workspace-1', 'symbol-1', 'src/main.ts', 'ok')],
    }));
    await bridge.refreshProject(rootPath);

    const timeout = createBridge(rootPath, createSource({
      ensureWorkspace: vi.fn(() => new Promise(() => {})),
    }), undefined, { timeoutMs: 5 });
    expect(await timeout.refreshProject(rootPath)).toMatchObject({
      status: 'failed',
      metadata: { reason: 'timeout' },
    });
    expect(listProjectCodeSymbols(db, rootPath)).toHaveLength(1);

    const tooManySymbols = createBridge(rootPath, createSource({
      manifestEntries: [manifest('workspace-1', 'src/main.ts')],
      symbols: [
        symbol('workspace-1', 'symbol-1', 'src/main.ts', 'ok'),
        symbol('workspace-1', 'symbol-2', 'src/main.ts', 'tooMany'),
      ],
    }), undefined, { maxSymbols: 1 });
    expect(await tooManySymbols.refreshProject(rootPath)).toMatchObject({
      status: 'failed',
      metadata: { reason: 'limit_exceeded', limit: 'symbols' },
    });
    expect(listProjectCodeSymbols(db, rootPath)).toHaveLength(1);

    const throwing = createBridge(rootPath, createSource({
      ensureWorkspace: vi.fn(async () => {
        throw new Error('codemem unavailable');
      }),
    }));
    expect(await throwing.refreshProject(rootPath)).toMatchObject({
      status: 'failed',
      error: 'codemem unavailable',
    });
    expect(listProjectCodeSymbols(db, rootPath)).toHaveLength(1);
  });

  it('prunes missing code_file sources and cascades their symbols on successful replay', async () => {
    const rootPath = await createProject({
      'src/a.ts': 'export function a() {}',
      'src/b.ts': 'export function b() {}',
    });
    const bridge = createBridge(rootPath, createSource({
      manifestEntries: [manifest('workspace-1', 'src/a.ts'), manifest('workspace-1', 'src/b.ts')],
      symbols: [
        symbol('workspace-1', 'symbol-a', 'src/a.ts', 'a'),
        symbol('workspace-1', 'symbol-b', 'src/b.ts', 'b'),
      ],
    }));
    await bridge.refreshProject(rootPath);
    expect(listProjectCodeSymbols(db, rootPath)).toHaveLength(2);

    await unlink(join(rootPath, 'src/b.ts'));
    const replay = createBridge(rootPath, createSource({
      manifestEntries: [manifest('workspace-1', 'src/a.ts')],
      symbols: [symbol('workspace-1', 'symbol-a', 'src/a.ts', 'a')],
    }));
    await replay.refreshProject(rootPath);

    expect(listProjectKnowledgeSources(db, rootPath)).toMatchObject([
      { sourceKind: 'code_file', sourceTitle: 'src/a.ts' },
    ]);
    expect(listProjectCodeSymbols(db, rootPath)).toMatchObject([
      { symbolId: 'symbol-a' },
    ]);
  });

  function createBridge(
    rootPath: string,
    source: ProjectCodeIndexSource,
    root: CodebaseMiningStatus = status(rootPath),
    limits: { maxFiles?: number; maxBytes?: number; maxSymbols?: number; timeoutMs?: number } = {},
  ): ProjectCodeIndexBridge {
    return new ProjectCodeIndexBridge({
      registry: {
        ensureRoot: vi.fn(() => root),
        getRoot: vi.fn(() => root),
      },
      source,
      db,
      limits,
    });
  }

  function createSource(overrides: Partial<ProjectCodeIndexSource> & {
    enabled?: boolean;
    indexingEnabled?: boolean;
    manifestEntries?: WorkspaceManifestRow[];
    symbols?: WorkspaceSymbolRecord[];
  } = {}): ProjectCodeIndexSource & { ensureWorkspace: ReturnType<typeof vi.fn> } {
    const workspaceHash = overrides.manifestEntries?.[0]?.workspaceHash
      ?? overrides.symbols?.[0]?.workspaceHash
      ?? 'workspace-1';
    const ensureWorkspace = (overrides.ensureWorkspace
      ?? vi.fn(async () => ({ workspaceHash, lastIndexedAt: 5 }))) as ReturnType<typeof vi.fn>;
    return {
      isEnabled: vi.fn(() => overrides.enabled ?? true),
      isIndexingEnabled: vi.fn(() => overrides.indexingEnabled ?? true),
      ensureWorkspace,
      listManifestEntries: vi.fn(() => overrides.manifestEntries ?? []),
      listWorkspaceSymbols: vi.fn(() => overrides.symbols ?? []),
    };
  }

  async function createProject(files: Record<string, string> = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aio-code-index-'));
    tempDirs.push(dir);
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(dir, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    return dir;
  }

  function status(rootPath: string, overrides: Partial<CodebaseMiningStatus> = {}): CodebaseMiningStatus {
    return {
      normalizedPath: rootPath,
      rootPath,
      projectKey: rootPath,
      displayName: 'project',
      discoverySource: 'manual-browse',
      autoMine: true,
      isPaused: false,
      isExcluded: false,
      mined: true,
      status: 'completed',
      ...overrides,
    };
  }

  function manifest(workspaceHash: string, pathFromRoot: string): WorkspaceManifestRow {
    return {
      workspaceHash,
      pathFromRoot,
      contentHash: `hash-${pathFromRoot}`,
      merkleLeafHash: `leaf-${pathFromRoot}`,
      mtime: 1,
    };
  }

  function symbol(
    workspaceHash: string,
    symbolId: string,
    pathFromRoot: string,
    name: string,
  ): WorkspaceSymbolRecord {
    return {
      workspaceHash,
      symbolId,
      pathFromRoot,
      name,
      kind: 'function',
      containerName: null,
      startLine: 1,
      startCharacter: 0,
      endLine: 1,
      endCharacter: name.length,
      signature: null,
      docComment: null,
    };
  }
});
