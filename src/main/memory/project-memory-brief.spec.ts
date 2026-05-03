import { describe, expect, it, vi } from 'vitest';
import type { PromptHistoryProjectAlias } from '../../shared/types/prompt-history.types';
import type { ConversationHistoryEntry, HistorySnippet } from '../../shared/types/history.types';
import type { ProjectKnowledgeReadModel } from '../../shared/types/knowledge-graph.types';
import { ProjectMemoryBriefService, redactProjectMemoryBriefText } from './project-memory-brief';

const now = Date.now();

function promptAlias(entries: PromptHistoryProjectAlias['entries']): PromptHistoryProjectAlias {
  return {
    projectPath: '/repo',
    entries,
    updatedAt: now,
  };
}

function historyEntry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: overrides.id ?? 'history-1',
    displayName: overrides.displayName ?? 'Auth thread',
    createdAt: overrides.createdAt ?? now - 2000,
    endedAt: overrides.endedAt ?? now - 1000,
    workingDirectory: overrides.workingDirectory ?? '/repo',
    messageCount: overrides.messageCount ?? 4,
    firstUserMessage: overrides.firstUserMessage ?? 'Investigate auth refresh',
    lastUserMessage: overrides.lastUserMessage ?? 'Auth refresh fixed',
    status: overrides.status ?? 'completed',
    originalInstanceId: overrides.originalInstanceId ?? 'inst-1',
    parentId: overrides.parentId ?? null,
    sessionId: overrides.sessionId ?? 'session-1',
    historyThreadId: overrides.historyThreadId ?? 'thread-1',
    provider: overrides.provider ?? 'claude',
    currentModel: overrides.currentModel ?? 'opus',
    snippets: overrides.snippets ?? [
      { position: 1, excerpt: 'auth refresh bug fixed in middleware', score: 0.9 },
    ],
    ...overrides,
  };
}

function emptyRecall() {
  return {
    search: vi.fn(async () => []),
  };
}

function emptyProjectKnowledge() {
  return {
    getReadModel: vi.fn(() => projectReadModel()),
  };
}

function projectReadModel(overrides: Partial<ProjectKnowledgeReadModel> = {}): ProjectKnowledgeReadModel {
  return {
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
      },
      inventory: {
        totalSources: 0,
        totalLinks: 0,
        totalKgLinks: 0,
        totalWakeLinks: 0,
        totalCodeSymbols: 0,
        byKind: {},
      },
    },
    sources: [],
    facts: [],
    wakeHints: [],
    codeIndex: {
      projectKey: '/repo',
      status: 'never',
      fileCount: 0,
      symbolCount: 0,
      updatedAt: 0,
      metadata: {},
    },
    codeSymbols: [],
    ...overrides,
  };
}

describe('ProjectMemoryBriefService', () => {
  it('returns an empty valid brief when no project history exists', async () => {
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([])),
      },
      history: {
        getEntries: vi.fn(() => []),
      },
      snippets: {
        expandSnippetsOnDemand: vi.fn(async () => []),
      },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({ projectPath: '/repo' });

    expect(brief.text).toBe('');
    expect(brief.sections).toEqual([]);
    expect(brief.sources).toEqual([]);
    expect(brief.stats).toMatchObject({
      candidatesScanned: 0,
      candidatesIncluded: 0,
      truncated: false,
    });
  });

  it('includes same-project prompts and chat excerpts while excluding other projects', async () => {
    const getEntries = vi.fn(() => [
      historyEntry({ id: 'history-same', workingDirectory: '/repo' }),
    ]);
    const expandSnippetsOnDemand = vi.fn(async (): Promise<HistorySnippet[]> => [
      { position: 2, excerpt: 'auth middleware fix from prior chat', score: 1 },
    ]);
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          {
            id: 'prompt-1',
            text: 'please inspect auth middleware',
            createdAt: now - 500,
            projectPath: '/repo',
            provider: 'claude',
            model: 'opus',
          },
          {
            id: 'prompt-other',
            text: 'other project prompt',
            createdAt: now - 500,
            projectPath: '/other',
          },
        ])),
      },
      history: { getEntries },
      snippets: { expandSnippetsOnDemand },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({
      projectPath: '/repo/',
      initialPrompt: 'auth middleware',
      provider: 'claude',
      model: 'opus',
    });

    expect(getEntries).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo',
      projectScope: 'current',
      source: 'history-transcript',
    }));
    expect(brief.text).toContain('please inspect auth middleware');
    expect(brief.text).toContain('auth middleware fix from prior chat');
    expect(brief.text).not.toContain('other project prompt');
    expect(brief.sources.map(source => source.type).sort()).toEqual([
      'history-transcript',
      'prompt-history',
    ]);
  });

  it('opts into session recall transcript retrieval for project old-chat evidence', async () => {
    const recallSearch = vi.fn(async () => [
      {
        source: 'history-transcript' as const,
        id: 'history-recall:4',
        title: 'Recall thread',
        summary: 'recall auth transcript excerpt',
        score: 1,
        timestamp: now - 1000,
        metadata: {
          entryId: 'history-recall',
          position: 4,
          excerpt: 'recall auth transcript excerpt',
          provider: 'gemini',
          model: 'flash',
          workingDirectory: '/repo',
        },
      },
    ]);
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([])),
      },
      history: {
        getEntries: vi.fn(() => []),
      },
      snippets: {
        expandSnippetsOnDemand: vi.fn(async () => []),
      },
      recall: {
        search: recallSearch,
      },
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({
      projectPath: '/repo/',
      initialPrompt: 'auth',
      provider: 'gemini',
      model: 'flash',
    });

    expect(recallSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'auth',
      repositoryPath: '/repo',
      provider: 'gemini',
      model: 'flash',
      sources: ['history-transcript', 'archived_session'],
      includeHistoryTranscripts: true,
    }));
    expect(brief.text).toContain('recall auth transcript excerpt');
    expect(brief.sources[0]).toMatchObject({
      id: 'history:history-recall:4',
      type: 'history-transcript',
      provider: 'gemini',
      model: 'flash',
      projectPath: '/repo',
    });
  });

  it('collapses duplicate prompt and transcript text to one direct source', async () => {
    const duplicate = 'same auth fix detail';
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          { id: 'prompt-1', text: duplicate, createdAt: now - 500, projectPath: '/repo' },
        ])),
      },
      history: {
        getEntries: vi.fn(() => [historyEntry({ id: 'history-1' })]),
      },
      snippets: {
        expandSnippetsOnDemand: vi.fn(async () => [
          { position: 1, excerpt: duplicate, score: 1 },
        ]),
      },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({
      projectPath: '/repo',
      initialPrompt: 'auth fix',
      maxResults: 10,
    });

    expect(brief.sources).toHaveLength(1);
    expect(brief.sources[0]?.type).toBe('history-transcript');
  });

  it('prioritizes direct transcript matches over prompt history when both match', async () => {
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          {
            id: 'prompt-1',
            text: 'auth middleware prompt',
            createdAt: now - 500,
            projectPath: '/repo',
          },
        ])),
      },
      history: {
        getEntries: vi.fn(() => [historyEntry({ id: 'history-1' })]),
      },
      snippets: {
        expandSnippetsOnDemand: vi.fn(async () => [
          { position: 1, excerpt: 'auth middleware transcript evidence', score: 1 },
        ]),
      },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({
      projectPath: '/repo',
      initialPrompt: 'auth middleware',
      maxResults: 1,
    });

    expect(brief.sources[0]?.type).toBe('history-transcript');
    expect(brief.text).toContain('auth middleware transcript evidence');
  });

  it('enforces character caps with visible truncation', async () => {
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias(
          Array.from({ length: 8 }, (_, index) => ({
            id: `prompt-${index}`,
            text: `very long prompt ${index} ${'x'.repeat(220)}`,
            createdAt: now - index,
            projectPath: '/repo',
          })),
        )),
      },
      history: {
        getEntries: vi.fn(() => []),
      },
      snippets: {
        expandSnippetsOnDemand: vi.fn(async () => []),
      },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
    });

    const brief = await service.buildBrief({
      projectPath: '/repo',
      maxChars: 500,
      maxResults: 8,
    });

    expect(brief.text.length).toBeLessThanOrEqual(500);
    expect(brief.text).toContain('more project memory available');
    expect(brief.stats.truncated).toBe(true);
  });

  it('includes source-backed facts, wake hints, code index status, and matching symbols', async () => {
    const projectKnowledge = {
      getReadModel: vi.fn(() => projectReadModel({
        facts: [
          {
            targetKind: 'kg_triple',
            targetId: 'triple-1',
            subject: 'AI Orchestrator',
            predicate: 'uses_frontend',
            object: 'Angular 21 zoneless signals',
            confidence: 0.9,
            validFrom: '2026-05-03T00:00:00.000Z',
            validTo: null,
            sourceFile: '/repo/package.json',
            evidenceCount: 2,
          },
        ],
        wakeHints: [
          {
            targetKind: 'wake_hint',
            targetId: 'hint-1',
            content: 'Prefer source-backed project memory over stale chat recollection.',
            importance: 8,
            room: '/repo',
            createdAt: now - 100,
            evidenceCount: 1,
          },
        ],
        codeIndex: {
          projectKey: '/repo',
          workspaceHash: 'workspace-1',
          status: 'ready',
          fileCount: 12,
          symbolCount: 3,
          lastSyncedAt: now,
          updatedAt: now,
          metadata: {},
        },
        codeSymbols: [
          {
            targetKind: 'code_symbol',
            targetId: 'symbol-1',
            id: 'pcs_1',
            projectKey: '/repo',
            sourceId: 'source-1',
            workspaceHash: 'workspace-1',
            symbolId: 'symbol-1',
            pathFromRoot: 'src/main/memory/project-memory-brief.ts',
            name: 'ProjectMemoryBriefService',
            kind: 'class',
            startLine: 97,
            startCharacter: 0,
            endLine: 220,
            endCharacter: 1,
            createdAt: now,
            updatedAt: now,
            metadata: {},
            evidenceCount: 1,
          },
        ],
      })),
    };
    const service = new ProjectMemoryBriefService({
      promptHistory: { getForProject: vi.fn(() => promptAlias([])) },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge,
    });

    const brief = await service.buildBrief({
      projectPath: '/repo',
      initialPrompt: 'update project memory brief service',
    });

    expect(projectKnowledge.getReadModel).toHaveBeenCalledWith('/repo');
    expect(brief.text).toContain('Current source-backed facts');
    expect(brief.text).toContain('[fact src:2 conf:90%]');
    expect(brief.text).toContain('AI Orchestrator uses frontend Angular 21 zoneless signals.');
    expect(brief.text).toContain('[code-index ready]');
    expect(brief.text).toContain('12 files, 3 symbols indexed');
    expect(brief.text).toContain('ProjectMemoryBriefService at src/main/memory/project-memory-brief.ts:97');
    expect(brief.text).toContain('Project wake hints');
    expect(brief.sources.map(source => source.type)).toEqual(expect.arrayContaining([
      'project-fact',
      'code-index-status',
      'code-symbol',
      'project-wake-hint',
    ]));
    expect(brief.sources).toHaveLength(4);
  });

  it('can disable mined memory and continue when project knowledge reads fail', async () => {
    const projectKnowledge = { getReadModel: vi.fn(() => projectReadModel()) };
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          { id: 'prompt-1', text: 'plain prompt memory', createdAt: now, projectPath: '/repo' },
        ])),
      },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge,
    });

    const brief = await service.buildBrief({
      projectPath: '/repo',
      includeMinedMemory: false,
    });

    expect(projectKnowledge.getReadModel).not.toHaveBeenCalled();
    expect(brief.text).toContain('plain prompt memory');

    const failingService = new ProjectMemoryBriefService({
      promptHistory: { getForProject: vi.fn(() => promptAlias([])) },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: { getReadModel: vi.fn(() => { throw new Error('read failed'); }) },
    });

    await expect(failingService.buildBrief({ projectPath: '/repo' })).resolves.toMatchObject({
      text: '',
      sources: [],
    });
  });

  it('uses the explicit code-symbol fallback threshold', async () => {
    const manySymbols = Array.from({ length: 13 }, (_, index) => ({
      targetKind: 'code_symbol' as const,
      targetId: `symbol-${index}`,
      id: `pcs_${index}`,
      projectKey: '/repo',
      sourceId: `source-${index}`,
      workspaceHash: 'workspace-1',
      symbolId: `symbol-${index}`,
      pathFromRoot: `src/file-${index}.ts`,
      name: `Unrelated${index}`,
      kind: 'function',
      startLine: index + 1,
      startCharacter: 0,
      endLine: index + 1,
      endCharacter: 1,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      evidenceCount: 1,
    }));
    const codeIndex = {
      projectKey: '/repo',
      workspaceHash: 'workspace-1',
      status: 'ready' as const,
      fileCount: 13,
      symbolCount: 13,
      lastSyncedAt: now,
      updatedAt: now,
      metadata: {},
    };

    const service = new ProjectMemoryBriefService({
      promptHistory: { getForProject: vi.fn(() => promptAlias([])) },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: { getReadModel: vi.fn(() => projectReadModel({ codeIndex, codeSymbols: manySymbols })) },
    });

    const omitted = await service.buildBrief({ projectPath: '/repo', initialPrompt: 'auth middleware' });
    expect(omitted.sources.some(source => source.type === 'code-symbol')).toBe(false);

    const includedService = new ProjectMemoryBriefService({
      promptHistory: { getForProject: vi.fn(() => promptAlias([])) },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: { getReadModel: vi.fn(() => projectReadModel({ codeIndex, codeSymbols: manySymbols.slice(0, 12) })) },
    });

    const included = await includedService.buildBrief({ projectPath: '/repo', initialPrompt: 'auth middleware' });
    expect(included.sources.filter(source => source.type === 'code-symbol')).toHaveLength(7);
  });

  it('reserves source-backed candidates and dedupes using source-backed priority', async () => {
    const sourceFacts = Array.from({ length: 4 }, (_, index) => ({
      targetKind: 'kg_triple' as const,
      targetId: `triple-${index}`,
      subject: `Fact${index}`,
      predicate: 'uses',
      object: `Source${index}`,
      confidence: 0.9,
      validFrom: null,
      validTo: null,
      sourceFile: '/repo/package.json',
      evidenceCount: 1,
    }));
    sourceFacts[0] = {
      ...sourceFacts[0],
      subject: 'duplicate',
      predicate: 'says',
      object: 'same detail',
    };
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          { id: 'prompt-dup', text: 'duplicate says same detail.', createdAt: now + 1000, projectPath: '/repo' },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `prompt-${index}`,
            text: `prompt ${index} old chat context`,
            createdAt: now - index,
            projectPath: '/repo',
          })),
        ])),
      },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: { getReadModel: vi.fn(() => projectReadModel({ facts: sourceFacts })) },
    });

    const brief = await service.buildBrief({ projectPath: '/repo', maxResults: 6 });

    expect(brief.sources.filter(source => source.type === 'project-fact')).toHaveLength(4);
    expect(brief.sources.some(source => source.id === 'prompt:prompt-dup')).toBe(false);
  });

  it('records exact redacted rendered text and ignores recorder failures', async () => {
    const recorder = vi.fn();
    const service = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          { id: 'prompt-1', text: 'api_key=sk-test-abc123 should not leak', createdAt: now, projectPath: '/repo' },
        ])),
      },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
      recorder,
    });

    const brief = await service.buildBrief({ projectPath: '/repo', instanceId: 'instance-1' });

    expect(brief.text).toContain('api_key=[REDACTED_SECRET]');
    expect(brief.text).not.toContain('sk-test-abc123');
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'instance-1',
      projectKey: '/repo',
      renderedText: brief.text,
      metadata: expect.objectContaining({
        candidatesScanned: 1,
        candidatesDeduped: 1,
        candidatesIncluded: 1,
        sourceCounts: expect.objectContaining({ 'prompt-history': 1 }),
      }),
    }));

    const failingService = new ProjectMemoryBriefService({
      promptHistory: {
        getForProject: vi.fn(() => promptAlias([
          { id: 'prompt-1', text: 'still builds', createdAt: now, projectPath: '/repo' },
        ])),
      },
      history: { getEntries: vi.fn(() => []) },
      snippets: { expandSnippetsOnDemand: vi.fn(async () => []) },
      recall: emptyRecall(),
      projectKnowledge: emptyProjectKnowledge(),
      recorder: vi.fn(() => { throw new Error('record failed'); }),
    });

    await expect(failingService.buildBrief({ projectPath: '/repo', instanceId: 'instance-2' })).resolves.toMatchObject({
      text: expect.stringContaining('still builds'),
    });
  });

  it('redacts common secret shapes without redacting normal project text', () => {
    const token = 'abcdEFGH1234abcdEFGH1234abcdEFGH1234+/';
    const redacted = redactProjectMemoryBriefText([
      'api_key=sk-test-abc123',
      'password: hunter2',
      'AKIA1234567890ABCDEF',
      'https://user:pass@example.com/repo.git',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      token,
      '/Users/suas/work/orchestrat0r/ai-orchestrator',
      'ProjectMemoryBriefService',
      'package.json',
    ].join('\n'));

    expect(redacted).toContain('api_key=[REDACTED_SECRET]');
    expect(redacted).toContain('password=[REDACTED_SECRET]');
    expect(redacted).toContain('[REDACTED_AWS_KEY]');
    expect(redacted).toContain('https://[REDACTED_CREDENTIALS]@example.com/repo.git');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY_MARKER]');
    expect(redacted).toContain('[REDACTED_TOKEN]');
    expect(redacted).not.toContain('sk-test-abc123');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('/Users/suas/work/orchestrat0r/ai-orchestrator');
    expect(redacted).toContain('ProjectMemoryBriefService');
    expect(redacted).toContain('package.json');
  });
});
