import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('codemem soak', () => {
  let workDir: string;
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;

  beforeEach(async () => {
    workDir = join(tmpdir(), `codemem-soak-${Date.now()}-${Math.random()}`);
    await mkdir(join(workDir, 'src'), { recursive: true });

    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store, debounceMs: 10 });

    await writeFile(join(workDir, 'src/seed.ts'), 'export const x = 0;\n');
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
    db.close();
  });

  it('handles 200 rapid edits and indexes the final file state', async () => {
    const result = await mgr.coldIndex(workDir);
    await mgr.start(workDir, result.workspaceHash);
    const finalSource = 'export const x = 200;\n';

    for (let i = 1; i <= 200; i += 1) {
      await writeFile(join(workDir, 'src/seed.ts'), `export const x = ${i};\n`);
      if (i % 25 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    const seedEntry = store
      .listManifestEntries(result.workspaceHash)
      .find((entry) => entry.pathFromRoot === 'src/seed.ts');

    expect(seedEntry).toBeDefined();
    expect(seedEntry?.contentHash).toBe(sha256(finalSource));
  }, 30_000);
});
