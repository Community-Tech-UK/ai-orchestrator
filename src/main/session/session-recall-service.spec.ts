import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { ChildResult } from '../../shared/types/child-result.types';
import type { AgentTreeSnapshot } from '../../shared/types/agent-tree.types';
import type { AutomationStore } from '../automations/automation-store';
import type { ChildResultStorage } from '../orchestration/child-result-storage';
import type { AgentTreePersistence } from './agent-tree-persistence';
import { SessionRecallService } from './session-recall-service';
import type { SessionArchiveManager } from './session-archive';

function makeChildResult(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    id: 'result-1',
    childId: 'child-1',
    parentId: 'parent-1',
    taskDescription: 'Fix webhook delivery',
    summary: 'Adjusted webhook delivery handling',
    summaryTokens: 10,
    artifacts: [],
    artifactCount: 0,
    conclusions: [],
    keyDecisions: ['Use bounded channel notifications'],
    fullTranscriptRef: '/tmp/transcript.json',
    fullTranscriptTokens: 100,
    success: true,
    completedAt: 100,
    duration: 10,
    tokensUsed: 100,
    ...overrides,
  };
}

function makeAutomationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'failed',
    trigger: 'webhook',
    scheduledAt: 100,
    startedAt: 110,
    finishedAt: 120,
    instanceId: 'inst-1',
    loopRunId: null,
    error: 'provider failed',
    outputSummary: null,
    outputFullRef: '/tmp/output.json',
    idempotencyKey: 'delivery-1',
    triggerSource: { type: 'webhook', provider: 'codex' },
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: 100,
    updatedAt: 120,
    attempt: 1,
    maxAttempts: 1,
    configSnapshot: {
      name: 'Webhook check',
      schedule: { type: 'cron', expression: '* * * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: {
        prompt: 'Check webhook',
        workingDirectory: '/repo',
        provider: 'codex',
        model: 'gpt-5.5',
      },
    },
    ...overrides,
  };
}

function makeSnapshot(): AgentTreeSnapshot {
  return {
    id: 'tree-1',
    rootId: 'parent-1',
    schemaVersion: 2,
    timestamp: 200,
    workingDirectory: '/repo',
    totalInstances: 2,
    totalTokensUsed: 0,
    edges: [{ parentId: 'parent-1', childId: 'child-1', timestamp: 100, task: 'Check webhook' }],
    nodes: [
      {
        instanceId: 'parent-1',
        displayName: 'Parent',
        parentId: null,
        childrenIds: ['child-1'],
        depth: 0,
        status: 'idle',
        provider: 'claude',
        workingDirectory: '/repo',
        sessionId: 'session-1',
        hasResult: false,
        statusTimeline: [{ status: 'idle', timestamp: 100 }],
        lastActivityAt: 100,
        createdAt: 90,
      },
      {
        instanceId: 'child-1',
        displayName: 'Webhook child',
        parentId: 'parent-1',
        childrenIds: [],
        depth: 1,
        status: 'failed',
        provider: 'codex',
        model: 'gpt-5.5',
        workingDirectory: '/repo',
        sessionId: 'session-2',
        hasResult: true,
        resultId: 'result-1',
        artifactCount: 1,
        statusTimeline: [{ status: 'failed', timestamp: 150 }],
        lastActivityAt: 150,
        routing: { actualProvider: 'codex', actualModel: 'gpt-5.5', reason: 'explicit model' },
        spawnConfig: { task: 'Check webhook', provider: 'codex', model: 'gpt-5.5' },
        createdAt: 100,
      },
    ],
  };
}

describe('SessionRecallService', () => {
  it('returns bounded prior decisions from child results', async () => {
    const service = new SessionRecallService(
      { listRuns: vi.fn(() => []) } as unknown as AutomationStore,
      { listSnapshots: vi.fn(async () => []) } as unknown as AgentTreePersistence,
      {
        getAllResults: vi.fn(async () => [makeChildResult()]),
        getResultsForParent: vi.fn(async () => [makeChildResult()]),
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: vi.fn(() => []) }) as unknown as SessionArchiveManager,
    );

    const results = await service.search({ query: 'bounded', intent: 'priorDecisions' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'child_result',
      sourceLink: { type: 'child_result', ref: 'result-1' },
      hasMore: true,
    });
  });

  it('searches pasted logs on their last question using content terms', async () => {
    const service = new SessionRecallService(
      { listRuns: () => [] } as unknown as AutomationStore,
      { listSnapshots: async () => [] } as unknown as AgentTreePersistence,
      { getAllResults: async () => [makeChildResult(), makeChildResult({ id: 'log-only', taskDescription: 'Debug exception stacktrace', summary: 'debug exception stacktrace', keyDecisions: [] })] } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: () => [] }) as unknown as SessionArchiveManager,
    );
    const results = await service.search({ query: 'DEBUG exception stacktrace\n'.repeat(100) + 'Why are webhook deliveries failing?', sources: ['child_result'] });
    expect(results.map(result => result.id)).toEqual(['result-1']);
  });

  it('matches meaningful short queries and excludes unrelated records', async () => {
    const service = new SessionRecallService(
      { listRuns: () => [] } as unknown as AutomationStore,
      { listSnapshots: async () => [] } as unknown as AgentTreePersistence,
      {
        getAllResults: async () => [
          makeChildResult({
            id: 'ci-hit',
            taskDescription: 'CI flakes',
            summary: 'ci pipeline is red',
            keyDecisions: [],
          }),
          makeChildResult({
            id: 'db-hit',
            taskDescription: 'DB retries',
            summary: 'db connection reset fixes',
            keyDecisions: [],
          }),
          makeChildResult({
            id: 'noise',
            taskDescription: 'Webhook report',
            summary: 'delivery notifications only',
            keyDecisions: [],
          }),
        ],
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: () => [] }) as unknown as SessionArchiveManager,
    );

    await expect(service.search({ query: 'ci', sources: ['child_result'] }))
      .resolves.toMatchObject([{ id: 'ci-hit' }]);
    await expect(service.search({ query: 'db', sources: ['child_result'] }))
      .resolves.toMatchObject([{ id: 'db-hit' }]);
  });

  it('does not treat nonempty all-stopword queries as match-all', async () => {
    const service = new SessionRecallService(
      { listRuns: () => [] } as unknown as AutomationStore,
      { listSnapshots: async () => [] } as unknown as AgentTreePersistence,
      {
        getAllResults: async () => [
          makeChildResult({ id: 'one', summary: 'ci pipeline is red', keyDecisions: [] }),
          makeChildResult({ id: 'two', summary: 'db connection reset', keyDecisions: [] }),
        ],
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: () => [] }) as unknown as SessionArchiveManager,
    );

    const results = await service.search({ query: 'the and to', sources: ['child_result'] });
    expect(results).toEqual([]);
  });

  it('keeps blank-query browse behavior', async () => {
    const service = new SessionRecallService(
      { listRuns: () => [] } as unknown as AutomationStore,
      { listSnapshots: async () => [] } as unknown as AgentTreePersistence,
      {
        getAllResults: async () => [
          makeChildResult({ id: 'one', summary: 'ci pipeline is red', keyDecisions: [] }),
          makeChildResult({ id: 'two', summary: 'db connection reset', keyDecisions: [] }),
        ],
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: () => [] }) as unknown as SessionArchiveManager,
    );

    const results = await service.search({ query: '   ', sources: ['child_result'] });
    expect(results.map(result => result.id)).toEqual(['one', 'two']);
  });

  it('uses the pasted-log final question with stopword removal and stemming', async () => {
    const service = new SessionRecallService(
      { listRuns: () => [] } as unknown as AutomationStore,
      { listSnapshots: async () => [] } as unknown as AgentTreePersistence,
      {
        getAllResults: async () => [
          makeChildResult({
            id: 'migration-hit',
            taskDescription: 'Fix migration rollback',
            summary: 'migration fail after restart',
            keyDecisions: [],
          }),
          makeChildResult({
            id: 'noise',
            taskDescription: 'Webhook retries',
            summary: 'delivery queue tuning',
            keyDecisions: [],
          }),
        ],
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: () => [] }) as unknown as SessionArchiveManager,
    );

    const results = await service.search({
      query: `STACKTRACE\n${'module error\n'.repeat(120)}Why are migrations failing after the restart?`,
      sources: ['child_result'],
    });
    expect(results.map(result => result.id)).toEqual(['migration-hit']);
  });

  it('surfaces stuck child diagnostics by provider and model', async () => {
    const snapshot = makeSnapshot();
    const service = new SessionRecallService(
      { listRuns: vi.fn(() => [makeAutomationRun()]) } as unknown as AutomationStore,
      {
        listSnapshots: vi.fn(async () => [{ id: 'tree-1', rootId: 'parent-1', totalInstances: 2, timestamp: 200 }]),
        loadSnapshot: vi.fn(async () => snapshot),
      } as unknown as AgentTreePersistence,
      {
        getAllResults: vi.fn(async () => []),
        getResultsForParent: vi.fn(async () => []),
      } as unknown as ChildResultStorage,
      () => ({ listArchivedSessions: vi.fn(() => []) }) as unknown as SessionArchiveManager,
    );

    const results = await service.search({
      query: 'webhook',
      intent: 'stuckSessionDiagnostics',
      provider: 'codex',
      model: 'gpt-5.5',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'child_diagnostic',
      id: 'tree-1:child-1',
      metadata: {
        childId: 'child-1',
        provider: 'codex',
        model: 'gpt-5.5',
      },
    });
  });
});
