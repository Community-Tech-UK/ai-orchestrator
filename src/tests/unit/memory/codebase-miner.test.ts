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
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';

const mockedFs = vi.mocked(fs);

describe('CodebaseMiner', () => {
  beforeEach(() => {
    CodebaseMiner._resetForTesting();
    KnowledgeGraphService._resetForTesting();
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

      expect(miner.getStatus('/fake/project')).toEqual({
        normalizedPath: '/fake/project',
        mined: false,
      });

      await miner.mineDirectory('/fake/project');

      expect(miner.getStatus('/fake/project')).toEqual({
        normalizedPath: '/fake/project',
        mined: true,
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
