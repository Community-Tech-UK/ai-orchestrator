import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { CodeRetrievalService } from '../code-retrieval-service';

const searchWorkspaceChunks = vi.fn(async () => ({
  indexed: true,
  results: [
    {
      workspacePath: join(tmpdir(), 'retrieval-lazy'),
      relativePath: 'src/auth.ts',
      absolutePath: join(tmpdir(), 'retrieval-lazy/src/auth.ts'),
      content: 'export function issueSessionToken() {}',
      startLine: 1,
      endLine: 1,
      score: 1,
      source: 'fts' as const,
      language: 'typescript',
      symbolName: 'issueSessionToken',
      stale: false,
    },
  ],
}));

describe('CodeRetrievalService codemem dependency lifecycle', () => {
  it('uses an injected index worker without loading the codemem singleton', async () => {
    const fallback = vi.fn(async () => []);
    const workspacePath = join(tmpdir(), 'retrieval-lazy');
    const service = new CodeRetrievalService({
      indexWorkerGateway: {
        warmWorkspace: vi.fn(),
        searchWorkspaceChunks,
      },
      runFallbackSearch: fallback,
    });

    const results = await service.search({
      workspacePath,
      query: 'issue session token',
      limit: 5,
    });

    expect(searchWorkspaceChunks).toHaveBeenCalledWith(workspacePath, 'issue session token', 5);
    expect(results[0]).toEqual(expect.objectContaining({
      source: 'fts',
      relativePath: 'src/auth.ts',
    }));
    expect(fallback).not.toHaveBeenCalled();
  });
});
