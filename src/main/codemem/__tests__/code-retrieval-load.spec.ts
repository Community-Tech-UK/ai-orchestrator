import Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';
import { CodeRetrievalService } from '../code-retrieval-service';

async function writeFixtureBatch(
  files: { path: string; content: string }[],
  batchSize = 100,
): Promise<void> {
  for (let offset = 0; offset < files.length; offset += batchSize) {
    await Promise.all(
      files
        .slice(offset, offset + batchSize)
        .map((file) => writeFile(file.path, file.content, 'utf8')),
    );
  }
}

describe('CodeRetrievalService load behavior', () => {
  let workDir: string;
  let db: Database.Database;
  let store: CasStore;
  let manager: CodeIndexManager;

  beforeEach(async () => {
    workDir = join(tmpdir(), `codemem-load-${Date.now()}-${Math.random()}`);
    await mkdir(join(workDir, 'src'), { recursive: true });
    await mkdir(join(workDir, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(workDir, 'dist'), { recursive: true });
    await mkdir(join(workDir, 'build'), { recursive: true });

    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    manager = new CodeIndexManager({ store });
  });

  afterEach(async () => {
    await manager.stop();
    db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('ignores generated folders and keeps repeated retrieval bounded', async () => {
    const sourceFiles = Array.from({ length: 500 }, (_, index) => {
      const suffix = index.toString().padStart(4, '0');
      return {
        path: join(workDir, 'src', `file-${suffix}.ts`),
        content: [
          `export function uniqueSourceToken${suffix}(): string {`,
          `  return 'unique source token ${suffix}';`,
          '}',
          '',
        ].join('\n'),
      };
    });
    const generatedFiles = [
      ...Array.from({ length: 1000 }, (_, index) => {
        const suffix = index.toString().padStart(4, '0');
        return {
          path: join(workDir, 'node_modules/pkg', `file-${suffix}.ts`),
          content: `export const generatedDependencyToken${suffix} = 'generated dependency token';\n`,
        };
      }),
      ...Array.from({ length: 1000 }, (_, index) => {
        const suffix = index.toString().padStart(4, '0');
        return {
          path: join(workDir, 'dist', `file-${suffix}.js`),
          content: `export const generatedDependencyToken${suffix} = 'generated dependency token';\n`,
        };
      }),
      ...Array.from({ length: 1000 }, (_, index) => {
        const suffix = index.toString().padStart(4, '0');
        return {
          path: join(workDir, 'build', `file-${suffix}.js`),
          content: `export const generatedDependencyToken${suffix} = 'generated dependency token';\n`,
        };
      }),
    ];

    await writeFixtureBatch([...sourceFiles, ...generatedFiles]);

    const indexResult = await manager.coldIndex(workDir);

    expect(store.searchWorkspaceChunks(indexResult.workspaceHash, 'generated dependency token', 10)).toHaveLength(0);
    expect(store.searchWorkspaceChunks(indexResult.workspaceHash, 'unique source token 0042', 10)[0]).toEqual(
      expect.objectContaining({ pathFromRoot: 'src/file-0042.ts' }),
    );

    const retrieval = new CodeRetrievalService({ store });
    let maxDurationMs = 0;
    for (let index = 0; index < 50; index += 1) {
      const suffix = (index % 500).toString().padStart(4, '0');
      const start = performance.now();
      const results = await retrieval.search({
        workspacePath: workDir,
        query: `unique source token ${suffix}`,
        limit: 5,
      });
      maxDurationMs = Math.max(maxDurationMs, performance.now() - start);

      expect(results[0]).toEqual(expect.objectContaining({
        relativePath: `src/file-${suffix}.ts`,
        source: 'fts',
      }));
      expect(results.every((result) => result.content.length <= 3600)).toBe(true);
    }

    expect(maxDurationMs).toBeLessThan(500);
  }, 60_000);
});
