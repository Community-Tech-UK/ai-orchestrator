// src/tests/unit/memory/codebase-miner.test.ts
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
import {
  listProjectKnowledgeLinks,
  listProjectKnowledgeSources,
  upsertProjectKnowledgeSource,
} from '../../../main/persistence/rlm/rlm-project-knowledge';

const mockedFs = vi.mocked(fs);

describe('CodebaseMiner', () => {
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

  describe('mineDirectory', () => {
    it('should extract tech stack facts from package.json', async () => {
      const miner = CodebaseMiner.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({
            name: 'my-app',
            dependencies: {
              'express': '^4.18.0',
              'typescript': '^5.0.0',
            },
            devDependencies: {
              'vitest': '^3.0.0',
            },
          });
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.factsExtracted).toBeGreaterThan(0);

      const stats = kg.getStats();
      expect(stats.entities).toBeGreaterThanOrEqual(1);
    });

    it('should extract hints from README.md', async () => {
      const miner = CodebaseMiner.getInstance();
      const wake = WakeContextBuilder.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('README.md')) {
          return '# My App\n\nA web application for managing tasks. Built with React and Node.js.\n\n## Getting Started\n\nnpm install && npm run dev';
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.hintsCreated).toBeGreaterThan(0);

      const ctx = wake.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('My App');
    });

    it('should extract hints from CLAUDE.md or AGENTS.md', async () => {
      const miner = CodebaseMiner.getInstance();
      // Ensure WakeContextBuilder is initialized for hint storage
      WakeContextBuilder.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('CLAUDE.md')) {
          return '# Instructions\n\nAlways use TypeScript. Never use var. Prefer const over let.';
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.hintsCreated).toBeGreaterThan(0);
    });

    it('should handle missing files gracefully', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await miner.mineDirectory('/fake/empty');
      expect(result.factsExtracted).toBe(0);
      expect(result.hintsCreated).toBe(0);
      expect(result.errors).toHaveLength(0); // Missing files are not errors
    });

    it('should not re-mine a directory that was already mined', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({ name: 'test', dependencies: { express: '1.0' } });
        }
        throw new Error('ENOENT');
      });

      const result1 = await miner.mineDirectory('/fake/project');
      const result2 = await miner.mineDirectory('/fake/project');

      expect(result1.factsExtracted).toBeGreaterThan(0);
      expect(result2.skipped).toBe(true);
    });

    it('should report mining status for a directory', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('README.md')) {
          return '# Test Project\n\nMining status smoke test.';
        }
        throw new Error('ENOENT');
      });

      expect(miner.getStatus('/fake/project')).toMatchObject({
        normalizedPath: '/fake/project',
        rootPath: '/fake/project',
        projectKey: '/fake/project',
        displayName: 'project',
        discoverySource: 'manual',
        autoMine: true,
        isPaused: false,
        isExcluded: false,
        mined: false,
        status: 'never',
      });

      await miner.mineDirectory('/fake/project');

      expect(miner.getStatus('/fake/project')).toMatchObject({
        normalizedPath: '/fake/project',
        rootPath: '/fake/project',
        projectKey: '/fake/project',
        displayName: 'project',
        discoverySource: 'manual',
        autoMine: true,
        isPaused: false,
        isExcluded: false,
        mined: true,
        status: 'completed',
        filesRead: 1,
        hintsCreated: 1,
      });
    });

    it('should persist mining status across miner singleton resets', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({ name: 'persistent-project', dependencies: { express: '1.0.0' } });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/persistent');
      CodebaseMiner._resetForTesting();

      const freshMiner = CodebaseMiner.getInstance();
      expect(freshMiner.getStatus('/fake/persistent')).toMatchObject({
        normalizedPath: '/fake/persistent',
        mined: true,
        status: 'completed',
        factsExtracted: 2,
      });
    });

    it('should re-mine a directory when source file fingerprints change', async () => {
      const miner = CodebaseMiner.getInstance();
      let packageJson = JSON.stringify({
        name: 'changing-project',
        dependencies: { express: '1.0.0' },
      });

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return packageJson;
        }
        throw new Error('ENOENT');
      });

      const first = await miner.mineDirectory('/fake/changing');
      const second = await miner.mineDirectory('/fake/changing');

      packageJson = JSON.stringify({
        name: 'changing-project',
        dependencies: { express: '1.0.0', react: '18.0.0' },
      });
      const third = await miner.mineDirectory('/fake/changing');

      expect(first.skipped).toBeUndefined();
      expect(second.skipped).toBe(true);
      expect(second.skipReason).toBe('unchanged');
      expect(third.skipped).toBeUndefined();
      expect(third.factsExtracted).toBeGreaterThan(first.factsExtracted);
      expect(miner.getStatus('/fake/changing')).toMatchObject({
        status: 'completed',
        filesRead: 1,
      });
    });

    it('should record source provenance and evidence links for package facts', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('package.json')) {
          return JSON.stringify({ name: 'provenance-project', dependencies: { express: '1.0.0' } });
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/provenance');

      expect(result.sourcesProcessed).toBe(1);
      expect(result.sourceLinksCreated).toBeGreaterThan(0);
      expect(listProjectKnowledgeSources(db, '/fake/provenance')).toMatchObject([
        {
          sourceKind: 'manifest',
          sourceUri: '/fake/provenance/package.json',
          contentFingerprint: expect.any(String),
        },
      ]);
      expect(listProjectKnowledgeLinks(db, '/fake/provenance').some((link) => link.targetKind === 'kg_triple')).toBe(true);
    });

    it('should record source provenance and evidence links for README wake hints', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('README.md')) {
          return '# Provenance App\n\nLocal source evidence should point at this README.';
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/readme-provenance');

      expect(listProjectKnowledgeSources(db, '/fake/readme-provenance')).toMatchObject([
        {
          sourceKind: 'readme',
          sourceUri: '/fake/readme-provenance/README.md',
        },
      ]);
      expect(listProjectKnowledgeLinks(db, '/fake/readme-provenance').some((link) => link.targetKind === 'wake_hint')).toBe(true);
    });

    it('should backfill provenance for unchanged legacy mining status with no source rows', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('package.json')) {
          return JSON.stringify({ name: 'legacy-project', dependencies: { express: '1.0.0' } });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/legacy');
      db.prepare('DELETE FROM project_knowledge_sources WHERE project_key = ?').run('/fake/legacy');
      expect(listProjectKnowledgeSources(db, '/fake/legacy')).toHaveLength(0);

      const backfill = await miner.mineDirectory('/fake/legacy');

      expect(backfill.skipped).toBeUndefined();
      expect(backfill.sourcesProcessed).toBe(1);
      expect(listProjectKnowledgeSources(db, '/fake/legacy')).toHaveLength(1);
      expect(listProjectKnowledgeLinks(db, '/fake/legacy').length).toBeGreaterThan(0);
    });

    it('should skip unchanged projects without rewriting current source rows or duplicating links', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('package.json')) {
          return JSON.stringify({ name: 'skip-project', dependencies: { express: '1.0.0' } });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/skip');
      const beforeSources = listProjectKnowledgeSources(db, '/fake/skip');
      const beforeLinks = listProjectKnowledgeLinks(db, '/fake/skip');
      const second = await miner.mineDirectory('/fake/skip');

      expect(second.skipped).toBe(true);
      expect(second.skipReason).toBe('unchanged');
      expect(listProjectKnowledgeSources(db, '/fake/skip')).toEqual(beforeSources);
      expect(listProjectKnowledgeLinks(db, '/fake/skip')).toEqual(beforeLinks);
    });

    it('should prune stale source links when a high-signal source changes', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();
      const kg = KnowledgeGraphService.getInstance();
      let packageJson = JSON.stringify({ name: 'stale-project', dependencies: { express: '1.0.0' } });

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('package.json')) {
          return packageJson;
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/stale');
      const expressTripleId = kg.queryEntity('stale-project').find((fact) => fact.object === 'express')?.id;
      expect(expressTripleId).toBeDefined();
      expect(listProjectKnowledgeLinks(db, '/fake/stale').some((link) => link.targetId === expressTripleId)).toBe(true);

      packageJson = JSON.stringify({ name: 'stale-project', dependencies: { react: '18.0.0' } });
      await miner.mineDirectory('/fake/stale');

      const links = listProjectKnowledgeLinks(db, '/fake/stale');
      expect(links.some((link) => link.targetId === expressTripleId)).toBe(false);
      expect(links.some((link) => link.targetKind === 'kg_triple')).toBe(true);
    });

    it('should delete source rows and links for high-signal files removed from the project', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();
      let hasReadme = true;

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (hasReadme && file.endsWith('README.md')) {
          return '# Deleted Source\n\nThis file will be removed.';
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/deleted-source');
      expect(listProjectKnowledgeSources(db, '/fake/deleted-source')).toHaveLength(1);
      expect(listProjectKnowledgeLinks(db, '/fake/deleted-source').length).toBeGreaterThan(0);

      hasReadme = false;
      await miner.mineDirectory('/fake/deleted-source');

      expect(listProjectKnowledgeSources(db, '/fake/deleted-source')).toHaveLength(0);
      expect(listProjectKnowledgeLinks(db, '/fake/deleted-source')).toHaveLength(0);
    });

    it('should not delete code_file sources during high-signal source pruning', async () => {
      const miner = CodebaseMiner.getInstance();
      const db = getRLMDatabase().getRawDb();
      const codeSource = upsertProjectKnowledgeSource(db, {
        projectKey: '/fake/preserve-code',
        sourceKind: 'code_file',
        sourceUri: '/fake/preserve-code/src/main.ts',
        sourceTitle: 'src/main.ts',
        contentFingerprint: 'code-hash',
      }).source;
      let hasReadme = true;

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (hasReadme && file.endsWith('README.md')) {
          return '# Preserve Code\n\nThis source should be pruned when removed.';
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/preserve-code');
      expect(listProjectKnowledgeSources(db, '/fake/preserve-code')).toHaveLength(2);

      hasReadme = false;
      await miner.mineDirectory('/fake/preserve-code');

      expect(listProjectKnowledgeSources(db, '/fake/preserve-code')).toMatchObject([
        { id: codeSource.id, sourceKind: 'code_file' },
      ]);
    });

    it('should reuse exact-room project hints instead of general hints when linking evidence', async () => {
      const miner = CodebaseMiner.getInstance();
      const wake = WakeContextBuilder.getInstance();
      const db = getRLMDatabase().getRawDb();
      wake.addHint('Tech stack: express', { importance: 7, room: 'general' });
      const existingProjectHintId = wake.addHint('Tech stack: express', { importance: 3, room: '/fake/room' });

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const file = String(filePath);
        if (file.endsWith('package.json')) {
          return JSON.stringify({ name: 'room-project', dependencies: { express: '1.0.0' } });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/room');

      const wakeLink = listProjectKnowledgeLinks(db, '/fake/room').find((link) => link.targetKind === 'wake_hint');
      expect(wakeLink).toBeDefined();
      expect(wakeLink!.targetId).toBe(existingProjectHintId);
      expect(wake.getHint(wakeLink!.targetId)).toMatchObject({
        room: '/fake/room',
        content: 'Tech stack: express',
      });
    });

    it('should report paused registry metadata in mining status', () => {
      const miner = CodebaseMiner.getInstance();
      const registry = ProjectRootRegistry.getInstance();

      registry.ensureRoot('/fake/paused', 'manual-browse');
      registry.pauseRoot('/fake/paused');

      expect(miner.getStatus('/fake/paused')).toMatchObject({
        normalizedPath: '/fake/paused',
        discoverySource: 'manual-browse',
        isPaused: true,
        isExcluded: false,
        status: 'never',
      });
    });
  });

  describe('extractPackageJsonFacts', () => {
    it('should extract project name and dependencies', async () => {
      const miner = CodebaseMiner.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({
            name: '@scope/cool-app',
            dependencies: { react: '^18', next: '^14' },
            devDependencies: { jest: '^29' },
          });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/project');

      // Should have entities for react, next
      const facts = kg.queryEntity('@scope/cool-app');
      expect(facts.length).toBeGreaterThan(0);
    });
  });
});
