// @vitest-environment node
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Compile current production source, so this probe never tests stale dist code.
describe('compiled RLM migrations with two native database owners', () => {
  let directory: string;
  beforeAll(async () => {
    await mkdir('_scratch', { recursive: true });
    directory = await mkdtemp(path.resolve('_scratch/lt710-compiled-'));
    await build({
      entryPoints: ['src/main/db/better-sqlite3-driver.ts', 'src/main/persistence/rlm/rlm-schema.ts'],
      outbase: 'src/main', outdir: directory, bundle: true,
      platform: 'node', format: 'cjs', logLevel: 'silent', external: ['better-sqlite3'],
    });
  }, 30_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('serializes discovery and allows a current database to open behind a writer', async () => {
    const electron = createRequire(import.meta.url)('electron') as string;
    const { stdout } = await promisify(execFile)(electron, [
      path.resolve('src/tests/fixtures/rlm-migration-concurrency.cjs'),
      directory,
    ], { cwd: process.cwd(), timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(JSON.parse(stdout.trim())).toEqual({
      twoConnections: true, staleDiscovery: 'safe',
      writeLockBeforeRead: true, currentDatabaseWithoutWriteLock: true,
    });
  }, 35_000);
});
