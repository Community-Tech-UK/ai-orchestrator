import { describe, expect, it, vi } from 'vitest';
import type { PromptHistoryProjectAlias } from '../../shared/types/prompt-history.types';
import type { ConversationHistoryEntry, HistorySnippet } from '../../shared/types/history.types';
import { ProjectMemoryBriefService } from './project-memory-brief';

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
});
