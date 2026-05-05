import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorProjectStore } from './operator-project-store';
import { ProjectRegistry } from './project-registry';

describe('ProjectRegistry', () => {
  const tempPaths: string[] = [];
  const dbs: SqliteDriver[] = [];

  afterEach(async () => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    await Promise.all(tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
    tempPaths.length = 0;
  });

  it('seeds projects from recent directories and deduplicates nested paths to the git root', async () => {
    const repo = await createProject('ai-orchestrator', {
      packageName: '@suas/ai-orchestrator',
      readmeTitle: 'AI Orchestrator',
    });
    const nested = path.join(repo, 'src', 'main');
    await fs.mkdir(nested, { recursive: true });

    const registry = createRegistry({
      recentDirectories: [
        {
          path: nested,
          displayName: 'main',
          isPinned: true,
          lastAccessed: 1710000000000,
          accessCount: 4,
        },
      ],
    });

    const projects = await registry.refreshProjects({ includeRecent: true });

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      canonicalPath: repo,
      displayName: 'AI Orchestrator',
      source: 'recent-directory',
      gitRoot: repo,
      isPinned: true,
      lastAccessedAt: 1710000000000,
    });
    expect(projects[0].aliases).toEqual(expect.arrayContaining([
      'AI Orchestrator',
      'ai-orchestrator',
      '@suas/ai-orchestrator',
      'suas/ai-orchestrator',
    ]));
  });

  it('resolves exact aliases and reports ambiguous fuzzy matches', async () => {
    const alpha = await createProject('dingley-web', { readmeTitle: 'Dingley Web' });
    const beta = await createProject('dingley-api', { readmeTitle: 'Dingley API' });
    const registry = createRegistry();

    await registry.upsertProjectFromPath(alpha, { source: 'manual', aliases: ['dingley frontend'] });
    await registry.upsertProjectFromPath(beta, { source: 'manual', aliases: ['dingley backend'] });

    expect(registry.resolveProject('dingley frontend')).toMatchObject({
      status: 'resolved',
      project: expect.objectContaining({ canonicalPath: alpha }),
    });

    const ambiguous = registry.resolveProject('dingley');
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.candidates.map((candidate) => candidate.canonicalPath).sort()).toEqual([alpha, beta].sort());
  });

  function createRegistry(options: {
    recentDirectories?: Array<{
      path: string;
      displayName: string;
      isPinned: boolean;
      lastAccessed: number;
      accessCount: number;
    }>;
  } = {}): ProjectRegistry {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    dbs.push(db);
    return new ProjectRegistry({
      store: new OperatorProjectStore(db),
      recentDirectories: {
        getDirectories: async () => options.recentDirectories ?? [],
      },
      conversationLedger: {
        listConversations: () => [],
      },
      instanceManager: {
        getAllInstances: () => [],
      },
    });
  }

  async function createProject(
    dirname: string,
    options: { packageName?: string; readmeTitle?: string } = {},
  ): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-project-registry-'));
    tempPaths.push(parent);
    const repo = path.join(parent, dirname);
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    if (options.packageName) {
      await fs.writeFile(
        path.join(repo, 'package.json'),
        JSON.stringify({ name: options.packageName }, null, 2),
        'utf-8',
      );
    }
    if (options.readmeTitle) {
      await fs.writeFile(path.join(repo, 'README.md'), `# ${options.readmeTitle}\n`, 'utf-8');
    }
    return repo;
  }
});
