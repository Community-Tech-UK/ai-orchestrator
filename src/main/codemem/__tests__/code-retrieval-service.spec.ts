import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeRetrievalService } from '../code-retrieval-service';
import type { Chunk } from '../types';

const sampleChunk = (overrides: Partial<Chunk> = {}): Chunk => ({
  contentHash: 'a'.repeat(64),
  astNormalizedHash: 'b'.repeat(64),
  language: 'typescript',
  chunkType: 'function',
  name: 'issueSessionToken',
  signature: null,
  docComment: null,
  symbolsJson: JSON.stringify(['issueSessionToken']),
  importsJson: '[]',
  exportsJson: '[]',
  rawText: 'export function issueSessionToken(userId: string): string { return `session:${userId}`; }',
  ...overrides,
});

describe('CodeRetrievalService', () => {
  let db: Database.Database;
  let store: CasStore;
  let workspacePath: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    workspacePath = join(tmpdir(), `retrieval-${Date.now()}-${Math.random()}`);
    await mkdir(join(workspacePath, 'src'), { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('searches indexed codemem chunk rows and resolves content from CAS', async () => {
    store.upsertWorkspaceRoot({
      workspaceHash: 'w1',
      absPath: workspacePath,
      headCommit: null,
      primaryLanguage: 'typescript',
      lastIndexedAt: 1,
      merkleRootHash: null,
      pagerankJson: null,
    });
    store.upsertChunk(sampleChunk());
    store.replaceWorkspaceChunksForFile('w1', 'src/auth.ts', [
      {
        workspaceHash: 'w1',
        pathFromRoot: 'src/auth.ts',
        chunkIndex: 0,
        contentHash: 'a'.repeat(64),
        startLine: 1,
        endLine: 3,
        language: 'typescript',
        chunkType: 'function',
        name: 'issueSessionToken',
        updatedAt: 1,
      },
    ]);

    const service = new CodeRetrievalService({ store });
    const results = await service.search({
      workspacePath,
      query: 'issue session token',
      limit: 5,
    });

    expect(results[0]).toEqual(expect.objectContaining({
      relativePath: 'src/auth.ts',
      source: 'fts',
      symbolName: 'issueSessionToken',
      stale: false,
    }));
    expect(results[0]?.content).toContain('issueSessionToken');
  });

  it('falls back to bounded grep search when the codemem index is cold', async () => {
    const fallback = vi.fn(async () => [
      {
        workspacePath,
        relativePath: 'src/auth.ts',
        absolutePath: join(workspacePath, 'src/auth.ts'),
        content: 'export function issueSessionToken() {}',
        startLine: 1,
        endLine: 1,
        score: 0,
        source: 'grepFallback' as const,
        language: 'typescript',
        symbolName: null,
        stale: true,
      },
    ]);
    const warmWorkspace = vi.fn(async () => ({
      indexed: false,
      absPath: workspacePath,
      primaryLanguage: 'typescript',
    }));
    const service = new CodeRetrievalService({
      store,
      indexWorkerGateway: { warmWorkspace },
      runFallbackSearch: fallback,
    });

    const results = await service.search({
      workspacePath,
      query: 'issue session token',
      limit: 5,
    });

    expect(warmWorkspace).toHaveBeenCalledWith(workspacePath, 2500);
    expect(fallback).toHaveBeenCalledWith(workspacePath, 'issue session token', 5);
    expect(results[0]).toEqual(expect.objectContaining({
      relativePath: 'src/auth.ts',
      source: 'grepFallback',
      stale: true,
    }));
  });

  it('keeps generated and vendor paths out of grep fallback results', async () => {
    await mkdir(join(workspacePath, 'vendor/pkg'), { recursive: true });
    await mkdir(join(workspacePath, 'cache'), { recursive: true });
    await writeFile(join(workspacePath, 'vendor/pkg/generated.ts'), 'export const vendorOnlyNeedle = true;\n');
    await writeFile(join(workspacePath, 'cache/generated.ts'), 'export const vendorOnlyNeedle = true;\n');

    const service = new CodeRetrievalService({ store });
    const results = await service.search({
      workspacePath,
      query: 'vendorOnlyNeedle',
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });

  describe('off-thread index worker search', () => {
    const makeResult = (overrides: Record<string, unknown> = {}) => ({
      workspacePath,
      relativePath: 'src/auth.ts',
      absolutePath: join(workspacePath, 'src/auth.ts'),
      content: 'export function issueSessionToken() {}',
      startLine: 1,
      endLine: 1,
      score: 1,
      source: 'fts' as const,
      language: 'typescript',
      symbolName: 'issueSessionToken',
      stale: false,
      ...overrides,
    });

    it('returns worker results without touching the main-thread store or ripgrep', async () => {
      const searchWorkspaceChunks = vi.fn(async () => ({ indexed: true, results: [makeResult()] }));
      const warmWorkspace = vi.fn();
      const fallback = vi.fn(async () => []);
      const storeSpy = vi.spyOn(store, 'searchWorkspaceChunks');
      const service = new CodeRetrievalService({
        store,
        indexWorkerGateway: { warmWorkspace, searchWorkspaceChunks } as never,
        runFallbackSearch: fallback,
      });

      const results = await service.search({ workspacePath, query: 'issue session', limit: 5 });

      expect(searchWorkspaceChunks).toHaveBeenCalledWith(workspacePath, 'issue session', 5);
      expect(results[0]).toEqual(expect.objectContaining({ source: 'fts', relativePath: 'src/auth.ts' }));
      expect(fallback).not.toHaveBeenCalled();
      expect(storeSpy).not.toHaveBeenCalled(); // never a synchronous main-thread FTS
    });

    it('warms in the background and ripgreps when the workspace is not yet indexed', async () => {
      const searchWorkspaceChunks = vi.fn(async () => ({ indexed: false, results: [] }));
      const warmWorkspace = vi.fn(async () => ({ indexed: true, absPath: workspacePath, primaryLanguage: 'typescript' }));
      const fallback = vi.fn(async () => [makeResult({ source: 'grepFallback', stale: true })]);
      const service = new CodeRetrievalService({
        store,
        indexWorkerGateway: { warmWorkspace, searchWorkspaceChunks } as never,
        runFallbackSearch: fallback,
      });

      const results = await service.search({ workspacePath, query: 'issue session', limit: 5 });

      expect(warmWorkspace).toHaveBeenCalledWith(workspacePath); // background, no deadline arg
      expect(fallback).toHaveBeenCalled();
      expect(results[0]?.source).toBe('grepFallback');
    });

    it('ripgreps without a sync store search or warm when the worker is degraded/times out', async () => {
      const searchWorkspaceChunks = vi.fn(async () => null);
      const warmWorkspace = vi.fn();
      const fallback = vi.fn(async () => [makeResult({ source: 'grepFallback', stale: true })]);
      const storeSpy = vi.spyOn(store, 'searchWorkspaceChunks');
      const service = new CodeRetrievalService({
        store,
        indexWorkerGateway: { warmWorkspace, searchWorkspaceChunks } as never,
        runFallbackSearch: fallback,
      });

      const results = await service.search({ workspacePath, query: 'issue session', limit: 5 });

      expect(fallback).toHaveBeenCalled();
      expect(warmWorkspace).not.toHaveBeenCalled();
      expect(storeSpy).not.toHaveBeenCalled();
      expect(results[0]?.source).toBe('grepFallback');
    });
  });
});
