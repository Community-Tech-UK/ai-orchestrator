import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorProjectStore } from './operator-project-store';

describe('OperatorProjectStore', () => {
  const tempPaths: string[] = [];
  const dbs: SqliteDriver[] = [];

  afterEach(async () => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    await Promise.all(tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
    tempPaths.length = 0;
  });

  it('persists projects and aliases in the operator tables', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-project-store-'));
    tempPaths.push(tempDir);
    const dbPath = path.join(tempDir, 'operator.db');

    const db = openDb(dbPath);
    const firstStore = new OperatorProjectStore(db);
    const project = firstStore.upsertProject({
      canonicalPath: '/work/ai-orchestrator',
      displayName: 'AI Orchestrator',
      aliases: ['AI Orchestrator', 'ai-orchestrator', 'orchestrat0r/ai-orchestrator'],
      source: 'recent-directory',
      gitRoot: '/work/ai-orchestrator',
      remotes: [{ name: 'origin', url: 'git@github.com:suas/ai-orchestrator.git' }],
      currentBranch: 'main',
      isPinned: true,
      lastAccessedAt: 1710000000000,
      metadata: { packageName: '@suas/ai-orchestrator' },
    });

    const secondStore = new OperatorProjectStore(db);

    expect(secondStore.listProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        canonicalPath: '/work/ai-orchestrator',
        displayName: 'AI Orchestrator',
        aliases: ['AI Orchestrator', 'ai-orchestrator', 'orchestrat0r/ai-orchestrator'],
        source: 'recent-directory',
        gitRoot: '/work/ai-orchestrator',
        currentBranch: 'main',
        isPinned: true,
        lastAccessedAt: 1710000000000,
        metadata: { packageName: '@suas/ai-orchestrator' },
      }),
    ]);
  });

  it('persists scan roots so registry refreshes survive store recreation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-project-store-'));
    tempPaths.push(tempDir);
    const dbPath = path.join(tempDir, 'operator.db');
    const db = openDb(dbPath);

    const firstStore = new OperatorProjectStore(db);
    firstStore.upsertScanRoot('/Users/suas/work', { source: 'manual' });

    const secondStore = new OperatorProjectStore(db);
    expect(secondStore.listScanRoots()).toEqual([
      expect.objectContaining({
        rootPath: '/Users/suas/work',
        metadata: { source: 'manual' },
      }),
    ]);
  });

  function openDb(dbPath: string): SqliteDriver {
    const db = defaultDriverFactory(dbPath);
    createOperatorTables(db);
    dbs.push(db);
    return db;
  }
});
