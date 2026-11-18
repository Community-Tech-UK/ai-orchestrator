/**
 * LT-1184: context added to a message must come from the meaning search. A word
 * search over everyday words ("make", "look") used to add an unrelated earlier
 * answer (a sourdough recipe) to a message about a dashboard.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSection } from '../../shared/types/rlm.types';
import type { Instance } from '../../shared/types/instance.types';

function section(id: string, content: string): ContextSection {
  return {
    id,
    type: 'conversation',
    name: id,
    content,
    tokens: 20,
    startOffset: 0,
    endOffset: content.length,
    checksum: id,
    depth: 0,
  };
}

const RECIPE = section('recipe', 'Here is a country loaf. It makes one loaf and the crust looks deep brown.');
const NOTE = section('note', 'The staging database password rotation is on Tuesday at 14:00, owned by Priya.');

const contextMocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  rlm: {
    getStore: vi.fn(),
    executeQuery: vi.fn(),
    addSection: vi.fn(),
    createStore: vi.fn((sessionId: string) => ({ id: `store-${sessionId}` })),
    startSession: vi.fn(async (_storeId: string, sessionId: string) => ({ id: `rlm-${sessionId}` })),
    endSession: vi.fn(),
  },
}));

vi.mock('../logging/logger', () => ({ getLogger: () => contextMocks.logger }));
vi.mock('../memory/unified-controller', () => ({
  getUnifiedMemory: () => ({ retrieve: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: { getInstance: () => contextMocks.rlm },
}));

import { InstanceContextManager } from './instance-context';

const DASHBOARD_MESSAGE = 'make this dashboard look modern without touching how it works';

describe('InstanceContextManager.buildRlmContext — LT-1184 word matches alone add nothing', () => {
  let manager: InstanceContextManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    contextMocks.rlm.getStore.mockReturnValue({ id: 'store', sections: [RECIPE, NOTE], totalSize: 0 });
    manager = new InstanceContextManager();
    await manager.initializeRlm({ id: 'inst-1', sessionId: 'sess-1', metadata: {} } as unknown as Instance);
  });

  it('adds nothing when only the word search finds a section', async () => {
    contextMocks.rlm.executeQuery.mockImplementation(async (_session: string, query: { type: string }) =>
      query.type === 'grep'
        ? { result: 'match', sectionsAccessed: ['recipe'] }
        : { result: 'No matches found.', sectionsAccessed: [] });

    const context = await manager.buildRlmContext('inst-1', DASHBOARD_MESSAGE);

    expect(context).toBeNull();
    const semanticQuery = contextMocks.rlm.executeQuery.mock.calls
      .map(([, query]) => query)
      .find((query) => query.type === 'semantic_search');
    expect(semanticQuery.params.keywordFallback).toBe(false);
  });

  it('adds the section the meaning search found, and not one found only by words', async () => {
    contextMocks.rlm.executeQuery.mockImplementation(async (_session: string, query: { type: string }) =>
      query.type === 'grep'
        ? { result: 'match', sectionsAccessed: ['recipe', 'note'] }
        : { result: 'match', sectionsAccessed: ['note'] });

    const context = await manager.buildRlmContext(
      'inst-1',
      'when is the staging database password rotation and who owns it?',
    );

    expect(context?.context).toContain('password rotation');
    expect(context?.context).not.toContain('country loaf');
    expect(context?.sectionsAccessed).toEqual(['note']);
    expect(context?.source).toBe('hybrid');
  });
});
