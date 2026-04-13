import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';

const FIXTURE = resolve(__dirname, '../../../../test/fixtures/codemem-sample');

describe('CodeIndexManager (cold index)', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store });
  });

  afterEach(async () => {
    await mgr.stop();
    db.close();
  });

  it('coldIndex populates manifest entries for every non-ignored file', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const entries = store.listManifestEntries(result.workspaceHash);
    const paths = entries.map((entry) => entry.pathFromRoot).sort();

    expect(paths).toEqual([
      'scripts/build.py',
      'src/math.ts',
      'src/string-utils.ts',
    ]);
  });

  it('coldIndex writes a workspace_root row with non-null merkle_root_hash', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const root = store.getWorkspaceRoot(result.workspaceHash);

    expect(root).not.toBeNull();
    expect(root?.merkleRootHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('coldIndex persists workspace symbol rows', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const symbols = store.listWorkspaceSymbols(result.workspaceHash);

    expect(symbols.some((symbol) => symbol.name === 'add' && symbol.kind === 'function')).toBe(true);
    expect(symbols.some((symbol) => symbol.name === 'capitalize' && symbol.kind === 'function')).toBe(true);
    expect(symbols.some((symbol) => symbol.name === 'build' && symbol.kind === 'function')).toBe(true);
  });

  it('coldIndex is deterministic for the same fixture', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const firstRootHash = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;

    const db2 = new Database(':memory:');
    migrate(db2);
    const store2 = new CasStore(db2);
    const mgr2 = new CodeIndexManager({ store: store2 });

    const result2 = await mgr2.coldIndex(FIXTURE);
    const secondRootHash = store2.getWorkspaceRoot(result2.workspaceHash)?.merkleRootHash;

    expect(firstRootHash).toBe(secondRootHash);

    await mgr2.stop();
    db2.close();
  });

  it('coldIndex respects .gitignore', async () => {
    const result = await mgr.coldIndex(FIXTURE);
    const entries = store.listManifestEntries(result.workspaceHash);

    expect(entries.find((entry) => entry.pathFromRoot.startsWith('node_modules/'))).toBeUndefined();
  });
});

describe('CodeIndexManager (incremental)', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;
  let workDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store, debounceMs: 30 });
    workDir = join(tmpdir(), `codemem-incr-${Date.now()}-${Math.random()}`);
    await mkdir(join(workDir, 'src'), { recursive: true });
    await copyFile(join(FIXTURE, 'src/math.ts'), join(workDir, 'src/math.ts'));
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
    db.close();
  });

  it('onFileChange re-indexes only the changed file', async () => {
    const result = await mgr.coldIndex(workDir);
    const rootBefore = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;

    await writeFile(
      join(workDir, 'src/math.ts'),
      'export function add(a: number, b: number): number { return a + b + 1; }\n',
    );

    await mgr.onFileChange(join(workDir, 'src/math.ts'), result.workspaceHash);

    const rootAfter = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;
    const entry = store
      .listManifestEntries(result.workspaceHash)
      .find((candidate) => candidate.pathFromRoot === 'src/math.ts');

    expect(rootAfter).not.toBe(rootBefore);
    expect(entry).toBeDefined();
  });

  it('onFileChange refreshes workspace symbol rows for the edited file', async () => {
    const result = await mgr.coldIndex(workDir);

    await writeFile(
      join(workDir, 'src/math.ts'),
      [
        'export function sum(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n'),
    );

    await mgr.onFileChange(join(workDir, 'src/math.ts'), result.workspaceHash);

    const symbols = store
      .listWorkspaceSymbols(result.workspaceHash)
      .filter((symbol) => symbol.pathFromRoot === 'src/math.ts')
      .map((symbol) => symbol.name);

    expect(symbols).toContain('sum');
    expect(symbols).not.toContain('add');
  });

  it('format-only change does not change merkle_root_hash', async () => {
    const result = await mgr.coldIndex(workDir);
    const rootBefore = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;

    await writeFile(
      join(workDir, 'src/math.ts'),
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function multiply(a: number, b: number): number {',
        '  return a * b;',
        '}',
        '',
      ].join('\n'),
    );

    await mgr.onFileChange(join(workDir, 'src/math.ts'), result.workspaceHash);

    const rootAfter = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;
    expect(rootAfter).toBe(rootBefore);
  });

  it('start watches the workspace and emits code-index:changed after edits', async () => {
    const result = await mgr.coldIndex(workDir);
    const seen: string[] = [];
    mgr.on('code-index:changed', (event: { workspaceHash: string; paths: string[] }) => {
      seen.push(...event.paths);
    });

    await mgr.start(workDir, result.workspaceHash);
    await writeFile(
      join(workDir, 'src/math.ts'),
      '// edited\nexport function add(a: number, b: number): number { return a + b + 2; }\n',
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen).toContain('src/math.ts');
  });
});
