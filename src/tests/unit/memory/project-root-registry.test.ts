import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs/promises';

let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('fs/promises');

import { CodebaseMiner } from '../../../main/memory/codebase-miner';
import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { ProjectRootRegistry } from '../../../main/memory/project-root-registry';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';
import { getRLMDatabase } from '../../../main/persistence/rlm-database';
import * as miningStore from '../../../main/persistence/rlm/rlm-codebase-mining';

const mockedFs = vi.mocked(fs);

describe('ProjectRootRegistry', () => {
  beforeEach(() => {
    CodebaseMiner._resetForTesting();
    KnowledgeGraphService._resetForTesting();
    ProjectRootRegistry._resetForTesting();
    WakeContextBuilder._resetForTesting();
    vi.clearAllMocks();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  it('registers project roots with stable metadata', () => {
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
      mined: false,
      status: 'never',
    });
    expect(root.createdAt).toEqual(expect.any(Number));
    expect(root.updatedAt).toEqual(expect.any(Number));
    expect(root.lastActiveAt).toEqual(expect.any(Number));
  });

  it('pauses, resumes, and excludes project roots', () => {
    const registry = ProjectRootRegistry.getInstance();
    registry.ensureRoot('/fake/project', 'manual-browse');

    registry.pauseRoot('/fake/project');
    expect(registry.getRoot('/fake/project')).toMatchObject({
      isPaused: true,
      isExcluded: false,
    });
    expect(registry.canAutoMine('/fake/project')).toBe(false);
    expect(registry.canManualMine('/fake/project')).toBe(true);

    registry.resumeRoot('/fake/project');
    expect(registry.getRoot('/fake/project')).toMatchObject({
      isPaused: false,
      isExcluded: false,
    });
    expect(registry.canAutoMine('/fake/project')).toBe(true);
    expect(registry.canManualMine('/fake/project')).toBe(true);

    registry.excludeRoot('/fake/project');
    expect(registry.getRoot('/fake/project')).toMatchObject({
      isExcluded: true,
    });
    expect(registry.canAutoMine('/fake/project')).toBe(false);
    expect(registry.canManualMine('/fake/project')).toBe(false);
  });

  it('preserves mining columns when an existing mined root is registered again', async () => {
    const miner = CodebaseMiner.getInstance();
    const registry = ProjectRootRegistry.getInstance();

    mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
      const file = String(filePath);
      if (file.endsWith('package.json')) {
        return JSON.stringify({
          name: 'preserved-project',
          dependencies: { express: '1.0.0', typescript: '5.0.0' },
        });
      }
      throw new Error('ENOENT');
    });

    await miner.mineDirectory('/fake/preserved');
    const before = miner.getStatus('/fake/preserved');
    const root = registry.ensureRoot('/fake/preserved', 'manual-browse');

    expect(root).toMatchObject({
      status: 'completed',
      contentFingerprint: expect.any(String),
      filesRead: before.filesRead,
      factsExtracted: before.factsExtracted,
      hintsCreated: before.hintsCreated,
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
      errors: [],
      discoverySource: 'manual',
    });
  });

  it('does not overwrite the original discovery source on repeated registration', () => {
    const registry = ProjectRootRegistry.getInstance();

    registry.ensureRoot('/fake/project', 'manual-browse');
    registry.ensureRoot('/fake/project', 'manual');

    expect(registry.getRoot('/fake/project')).toMatchObject({
      discoverySource: 'manual-browse',
    });
  });

  it('preserves disabled auto-mining when a later registration omits autoMine', () => {
    const db = getRLMDatabase().getRawDb();

    miningStore.ensureProjectRoot(db, {
      normalizedPath: '/fake/auto-off',
      rootPath: '/fake/auto-off',
      projectKey: '/fake/auto-off',
      displayName: 'auto-off',
      discoverySource: 'manual-browse',
      autoMine: false,
      lastActiveAt: 1_900_000_000_000,
    });

    const refreshed = miningStore.ensureProjectRoot(db, {
      normalizedPath: '/fake/auto-off',
      rootPath: '/fake/auto-off',
      projectKey: '/fake/auto-off',
      displayName: 'Auto Off',
      discoverySource: 'manual',
      lastActiveAt: 1_900_000_000_100,
    });

    expect(refreshed).toMatchObject({
      autoMine: false,
      displayName: 'Auto Off',
      discoverySource: 'manual-browse',
      lastActiveAt: 1_900_000_000_100,
    });
  });
});
