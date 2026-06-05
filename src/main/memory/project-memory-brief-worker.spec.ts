import { describe, expect, it, vi } from 'vitest';
import { buildProjectMemoryBriefInWorker } from './project-memory-brief-worker';
import type { ProjectKnowledgeReadModel } from '../../shared/types/knowledge-graph.types';

const readModel: ProjectKnowledgeReadModel = {
  project: {
    projectKey: '/repo',
    rootPath: '/repo',
    displayName: 'repo',
    miningStatus: {
      normalizedPath: '/repo',
      rootPath: '/repo',
      projectKey: '/repo',
      mined: true,
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
    },
    inventory: {
      totalSources: 1,
      totalLinks: 2,
      byKind: {},
    },
  },
  sources: [],
  facts: [
    {
      targetKind: 'kg_triple',
      targetId: 'fact-1',
      subject: 'AuthMiddleware',
      predicate: 'guards',
      object: 'admin routes',
      confidence: 0.9,
      validFrom: null,
      validTo: null,
      sourceFile: 'src/auth.ts',
      evidenceCount: 2,
    },
  ],
  wakeHints: [
    {
      targetKind: 'wake_hint',
      targetId: 'hint-1',
      content: 'Remember the auth middleware rejects missing workspace IDs.',
      importance: 0.8,
      room: '/repo',
      createdAt: 10,
      evidenceCount: 1,
    },
  ],
  codeIndex: {
    projectKey: '/repo',
    status: 'ready',
    fileCount: 12,
    symbolCount: 34,
    updatedAt: 20,
    metadata: {},
  },
  codeSymbols: [
    {
      targetKind: 'code_symbol',
      targetId: 'sym-1',
      id: 'sym-1',
      projectKey: '/repo',
      sourceId: 'source-1',
      workspaceHash: 'hash',
      symbolId: 'AuthMiddleware',
      pathFromRoot: 'src/auth.ts',
      name: 'AuthMiddleware',
      kind: 'class',
      startLine: 5,
      startCharacter: 0,
      endLine: 40,
      endCharacter: 1,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
      evidenceCount: 1,
    },
  ],
};

describe('buildProjectMemoryBriefInWorker', () => {
  it('builds a source-backed brief from clone-safe project knowledge and records startup metadata', async () => {
    const recorder = vi.fn();

    const brief = await buildProjectMemoryBriefInWorker(
      {
        projectPath: '/repo',
        instanceId: 'inst-1',
        initialPrompt: 'auth middleware routes',
        provider: 'claude',
        model: 'opus',
        maxChars: 1200,
      },
      {
        projectKnowledge: { getReadModel: vi.fn(() => readModel) },
        recorder,
      },
    );

    expect(brief.text).toContain('Project Memory Brief');
    expect(brief.text).toContain('AuthMiddleware guards admin routes');
    expect(brief.text).toContain('auth middleware rejects missing workspace IDs');
    expect(brief.text).toContain('src/auth.ts');
    expect(brief.sources.map((source) => source.type)).toEqual([
      'code-index-status',
      'project-fact',
      'project-wake-hint',
      'code-symbol',
    ]);
    expect(brief.stats).toMatchObject({
      projectKey: '/repo',
      candidatesScanned: 4,
      candidatesIncluded: 4,
      truncated: false,
    });
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      projectKey: '/repo',
      provider: 'claude',
      model: 'opus',
    }));
  });

  it('returns an empty brief when project knowledge is unavailable', async () => {
    const brief = await buildProjectMemoryBriefInWorker(
      { projectPath: '/missing' },
      {
        projectKnowledge: {
          getReadModel: vi.fn(() => {
            throw new Error('not registered');
          }),
        },
      },
    );

    expect(brief.text).toBe('');
    expect(brief.sources).toEqual([]);
    expect(brief.stats.candidatesScanned).toBe(0);
  });
});
