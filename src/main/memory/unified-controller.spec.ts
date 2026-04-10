import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const memoryManagerMock = {
  decideOperation: vi.fn(),
  executeOperation: vi.fn(),
  retrieve: vi.fn(),
  recordTaskOutcome: vi.fn(),
  getStats: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

const rlmContextMock = {
  getStoreByInstance: vi.fn(),
};

const skillsLoaderMock = {
  initialize: vi.fn(),
  detectRelevantSkills: vi.fn(),
  loadSkillsWithBudget: vi.fn(),
};

const wakeContextBuilderMock = {
  getWakeUpText: vi.fn(),
};

vi.mock('./r1-memory-manager', () => ({
  getMemoryManager: () => memoryManagerMock,
  MemoryManagerAgent: class {},
}));

vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: () => rlmContextMock,
  },
}));

vi.mock('./skills-loader', () => ({
  getSkillsLoader: () => skillsLoaderMock,
  SkillsLoader: class {},
}));

vi.mock('./wake-context-builder', () => ({
  getWakeContextBuilder: () => wakeContextBuilderMock,
}));

import {
  getUnifiedMemory,
  UnifiedMemoryController,
} from './unified-controller';

describe('UnifiedMemoryController hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    UnifiedMemoryController._resetForTesting();

    memoryManagerMock.decideOperation.mockResolvedValue({
      operation: 'NOOP',
      confidence: 0.9,
      reasoning: 'no-op',
    });
    memoryManagerMock.executeOperation.mockResolvedValue(null);
    memoryManagerMock.retrieve.mockResolvedValue([]);
    memoryManagerMock.getStats.mockReturnValue({
      totalEntries: 0,
      totalTokens: 0,
      avgRelevanceScore: 0,
      operationCounts: { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 },
      recentRetrievals: 0,
      cacheHitRate: 0,
    });

    rlmContextMock.getStoreByInstance.mockReturnValue(null);

    skillsLoaderMock.detectRelevantSkills.mockResolvedValue([]);
    skillsLoaderMock.loadSkillsWithBudget.mockResolvedValue({ content: [] });
    wakeContextBuilderMock.getWakeUpText.mockReturnValue(
      'Identity: Orchestrator\n\nEssential Story: Maintain project continuity.'
    );
  });

  afterEach(() => {
    UnifiedMemoryController._resetForTesting();
  });

  it('invalidates retrieval cache after new input is processed', async () => {
    const memory = getUnifiedMemory();

    const before = await memory.retrieve('build failure', 'task-1');
    expect(before.shortTerm).toEqual([]);

    await memory.processInput('build failure in parser fixed by import update', 'session-1', 'task-2');

    const after = await memory.retrieve('build failure', 'task-1');
    expect(after.shortTerm.join(' ')).toContain('build failure');
  });

  it('returns cloned cached retrieval results to prevent external mutation', async () => {
    const memory = getUnifiedMemory();

    await memory.processInput('cache clone safety check', 'session-1', 'task-1');

    const first = await memory.retrieve('cache clone safety', 'task-2');
    first.shortTerm.push('MUTATED-RESULT');

    const second = await memory.retrieve('cache clone safety', 'task-2');
    expect(second.shortTerm).not.toContain('MUTATED-RESULT');
  });

  it('fails open when long-term retrieval errors and still returns short-term context', async () => {
    const memory = getUnifiedMemory();
    const sourceErrorSpy = vi.fn();
    memory.on('retrieve:sourceError', sourceErrorSpy);

    memory.configure({ trainingStage: 2 });
    memoryManagerMock.retrieve.mockRejectedValueOnce(new Error('upstream retrieval failed'));

    await memory.processInput('resilient retrieval should keep short term context', 'session-2', 'task-3');

    await expect(memory.retrieve('resilient retrieval', 'task-4')).resolves.toMatchObject({
      shortTerm: expect.any(Array),
    });

    const result = await memory.retrieve('resilient retrieval', 'task-4');
    expect(result.shortTerm.length).toBeGreaterThan(0);
    expect(sourceErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'long_term' })
    );
  });

  it('includes wake context in retrieval results when session context is provided', async () => {
    const memory = getUnifiedMemory();

    const result = await memory.retrieve('project continuity', 'task-5', {
      sessionId: 'session-ctx',
      instanceId: 'instance-ctx',
    });

    expect(result.wakeContext).toContain('Identity: Orchestrator');
    expect(result.totalTokens).toBeGreaterThan(0);

    const cached = await memory.retrieve('project continuity', 'task-5', {
      sessionId: 'session-ctx',
      instanceId: 'instance-ctx',
    });

    expect(cached.wakeContext).toBe(result.wakeContext);
  });
});
