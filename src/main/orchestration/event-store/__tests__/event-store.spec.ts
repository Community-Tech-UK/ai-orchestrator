/**
 * Orchestration Event Store — Unit Tests
 *
 * Uses an in-memory mock database to avoid a native better-sqlite3 dependency
 * in the test environment.
 *
 * The EVENT_SOURCING feature flag is forced on via env var so that
 * append() actually persists events.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the logger so tests don't need Electron or a log directory
// ---------------------------------------------------------------------------
vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Enable the EVENT_SOURCING flag for the entire test suite
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env['ORCH_FEATURE_EVENT_SOURCING'] = 'true';
});

afterAll(() => {
  delete process.env['ORCH_FEATURE_EVENT_SOURCING'];
});

import { OrchestrationEventStore } from '../orchestration-event-store';
import { OrchestrationProjector } from '../orchestration-projector';
import type { OrchestrationEvent } from '../orchestration-events';

// ---------------------------------------------------------------------------
// Simple in-memory mock that satisfies the EventStoreDb interface
// ---------------------------------------------------------------------------
class InMemoryDb {
  private tables = new Map<string, unknown[]>();
  private indices = new Set<string>();

  exec(sql: string): void {
    const tableMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    if (tableMatch) this.tables.set(tableMatch[1], []);
    const indexMatch = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/);
    if (indexMatch) this.indices.add(indexMatch[1]);
  }

  prepare(sql: string) {
    const tables = this.tables;
    const tableName = sql.includes('orchestration_command_receipts')
      ? 'orchestration_command_receipts'
      : 'orchestration_events';
    return {
      run(...args: unknown[]) {
        const rows = tables.get(tableName) ?? [];
        if (tableName === 'orchestration_command_receipts') {
          const commandId = args[0];
          const existingIndex = rows.findIndex((row) => Array.isArray(row) && row[0] === commandId);
          if (existingIndex >= 0) {
            rows.splice(existingIndex, 1, args);
          } else {
            rows.push(args);
          }
        } else {
          rows.push(args);
        }
        tables.set(tableName, rows);
        return { changes: 1 };
      },
      all(...args: unknown[]) {
        const rows = tables.get(tableName) ?? [];

        type RowObj = Record<string, unknown>;

        const mapped: RowObj[] = rows.map((r: unknown) => {
          const a = r as unknown[];
          if (tableName === 'orchestration_command_receipts') {
            return {
              command_id: a[0],
              status: a[1],
              type: a[2],
              aggregate_id: a[3],
              timestamp: a[4],
              event_id: a[5],
              reason: a[6],
              metadata: a[7],
            };
          }
          return {
            id: a[0],
            type: a[1],
            aggregate_id: a[2],
            timestamp: a[3],
            payload: a[4],
            metadata: a[5],
          };
        });

        const filtered = mapped.filter((row) => {
          if (sql.includes('WHERE command_id')) return row['command_id'] === args[0];
          if (sql.includes('WHERE aggregate_id')) return row['aggregate_id'] === args[0];
          if (sql.includes('WHERE type')) return row['type'] === args[0];
          return true;
        });

        const sorted = filtered.sort((a, b) => {
          if (sql.includes('ORDER BY timestamp DESC')) {
            return (b['timestamp'] as number) - (a['timestamp'] as number);
          }
          return (a['timestamp'] as number) - (b['timestamp'] as number);
        });

        const limitArg = sql.includes('LIMIT')
          ? (args[args.length - 1] as number)
          : undefined;

        return limitArg !== undefined ? sorted.slice(0, limitArg) : sorted;
      },
      get(...args: unknown[]) {
        return this.all(...args)[0];
      },
    };
  }
}

// ---------------------------------------------------------------------------
// OrchestrationEventStore tests
// ---------------------------------------------------------------------------
describe('OrchestrationEventStore', () => {
  let store: OrchestrationEventStore;

  beforeEach(() => {
    OrchestrationEventStore._resetForTesting();
    store = OrchestrationEventStore.getInstance(new InMemoryDb());
    store.initialize();
  });

  it('appends and retrieves events by aggregate ID', () => {
    const event: OrchestrationEvent = {
      id: 'evt-1',
      type: 'verification.requested',
      aggregateId: 'ver-1',
      timestamp: Date.now(),
      payload: { query: 'Is this safe?' },
    };
    store.append(event);

    const events = store.getByAggregateId('ver-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('verification.requested');
    expect(events[0].payload['query']).toBe('Is this safe?');
  });

  it('retrieves events by type', () => {
    store.append({
      id: 'evt-1',
      type: 'debate.started',
      aggregateId: 'd-1',
      timestamp: 1000,
      payload: {},
    });
    store.append({
      id: 'evt-2',
      type: 'verification.requested',
      aggregateId: 'v-1',
      timestamp: 2000,
      payload: {},
    });

    const debates = store.getByType('debate.started');
    expect(debates).toHaveLength(1);
    expect(debates[0].aggregateId).toBe('d-1');
  });

  it('retrieves recent events in descending timestamp order', () => {
    store.append({
      id: 'evt-1',
      type: 'debate.started',
      aggregateId: 'd-1',
      timestamp: 1000,
      payload: {},
    });
    store.append({
      id: 'evt-2',
      type: 'debate.completed',
      aggregateId: 'd-1',
      timestamp: 2000,
      payload: {},
    });

    const recent = store.getRecentEvents(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].timestamp).toBeGreaterThanOrEqual(recent[1].timestamp);
  });

  it('projects active verification requests from lifecycle events', () => {
    store.append({
      id: 'evt-v1-start',
      type: 'verification.requested',
      aggregateId: 'v-1',
      timestamp: 1000,
      payload: {
        id: 'v-1',
        instanceId: 'inst-1',
        prompt: 'First verification',
        config: { agentCount: 3, timeout: 60000, synthesisStrategy: 'merge' },
      },
    });
    store.append({
      id: 'evt-v2-start',
      type: 'verification.requested',
      aggregateId: 'v-2',
      timestamp: 2000,
      payload: {
        id: 'v-2',
        instanceId: 'inst-2',
        prompt: 'Second verification',
        config: { agentCount: 3, timeout: 60000, synthesisStrategy: 'merge' },
      },
    });
    store.append({
      id: 'evt-v1-cancel',
      type: 'verification.cancelled',
      aggregateId: 'v-1',
      timestamp: 3000,
      payload: { verificationId: 'v-1' },
    });

    expect(store.getActiveVerificationRequests()).toEqual([
      expect.objectContaining({
        id: 'v-2',
        instanceId: 'inst-2',
        prompt: 'Second verification',
      }),
    ]);
  });

  it('projects active debates from lifecycle events', () => {
    const round = {
      roundNumber: 1,
      type: 'initial',
      contributions: [],
      consensusScore: 0.5,
      timestamp: 1500,
      durationMs: 250,
    };

    store.append({
      id: 'evt-d1-start',
      type: 'debate.started',
      aggregateId: 'd-1',
      timestamp: 1000,
      payload: {
        id: 'd-1',
        query: 'Should we ship?',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-1',
        currentRound: 0,
        rounds: [],
        startTime: 1000,
        status: 'in_progress',
      },
    });
    store.append({
      id: 'evt-d1-round',
      type: 'debate.round_completed',
      aggregateId: 'd-1',
      timestamp: 2000,
      payload: {
        id: 'd-1',
        query: 'Should we ship?',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-1',
        currentRound: 1,
        rounds: [round],
        startTime: 1000,
        status: 'in_progress',
        round,
      },
    });
    store.append({
      id: 'evt-d1-paused',
      type: 'debate.paused',
      aggregateId: 'd-1',
      timestamp: 2500,
      payload: {
        id: 'd-1',
        query: 'Should we ship?',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-1',
        currentRound: 1,
        rounds: [round],
        startTime: 1000,
        status: 'paused',
      },
    });
    store.append({
      id: 'evt-d1-resumed',
      type: 'debate.resumed',
      aggregateId: 'd-1',
      timestamp: 3000,
      payload: {
        id: 'd-1',
        query: 'Should we ship?',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-1',
        currentRound: 1,
        rounds: [round],
        startTime: 1000,
        status: 'in_progress',
      },
    });

    expect(store.getActiveDebates()).toEqual([
      expect.objectContaining({
        id: 'd-1',
        currentRound: 1,
        status: 'in_progress',
        rounds: [round],
      }),
    ]);

    store.append({
      id: 'evt-d1-complete',
      type: 'debate.completed',
      aggregateId: 'd-1',
      timestamp: 4000,
      payload: { id: 'd-1', status: 'completed' },
    });

    expect(store.getActiveDebates()).toEqual([]);
  });

  it('projects verification results from persisted completion events', () => {
    const verificationResult = {
      id: 'v-result',
      request: {
        id: 'v-result',
        instanceId: 'inst-result',
        prompt: 'Verify persisted result',
        config: { agentCount: 3, timeout: 60_000, synthesisStrategy: 'merge' as const },
      },
      responses: [],
      analysis: {
        agreements: [],
        disagreements: [],
        uniqueInsights: [],
        responseRankings: [],
        overallConfidence: 0.91,
        outlierAgents: [],
        consensusStrength: 0.88,
      },
      synthesizedResponse: 'Persisted synthesis',
      synthesisMethod: 'merge' as const,
      synthesisConfidence: 0.91,
      totalDuration: 1_200,
      totalTokens: 512,
      totalCost: 0.12,
      completedAt: 2_000,
    };

    store.append({
      id: 'evt-v-result-start',
      type: 'verification.requested',
      aggregateId: 'v-result',
      timestamp: 1_000,
      payload: verificationResult.request,
    });
    store.append({
      id: 'evt-v-result-complete',
      type: 'verification.completed',
      aggregateId: 'v-result',
      timestamp: 2_000,
      payload: verificationResult,
    });

    expect(store.getVerificationResult('v-result')).toEqual(verificationResult);
  });

  it('projects debate results from persisted completion events', () => {
    const debateResult = {
      id: 'd-result',
      query: 'Should we persist debate results?',
      rounds: [],
      synthesis: 'Yes',
      consensusReached: true,
      finalConsensusScore: 0.95,
      keyAgreements: ['Persist the final result'],
      unresolvedDisagreements: [],
      tokensUsed: 256,
      duration: 800,
      status: 'completed' as const,
    };

    store.append({
      id: 'evt-d-result-start',
      type: 'debate.started',
      aggregateId: 'd-result',
      timestamp: 1_000,
      payload: {
        id: 'd-result',
        query: 'Should we persist debate results?',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5_000,
        },
        currentRound: 0,
        rounds: [],
        startTime: 1_000,
        status: 'in_progress',
      },
    });
    store.append({
      id: 'evt-d-result-complete',
      type: 'debate.completed',
      aggregateId: 'd-result',
      timestamp: 1_800,
      payload: debateResult,
    });

    expect(store.getDebateResult('d-result')).toEqual(debateResult);
  });

  it('preserves metadata when provided', () => {
    const event: OrchestrationEvent = {
      id: 'evt-meta',
      type: 'consensus.started',
      aggregateId: 'con-1',
      timestamp: 5000,
      payload: {},
      metadata: { instanceId: 'inst-abc', source: 'test' },
    };
    store.append(event);

    const [retrieved] = store.getByAggregateId('con-1');
    expect(retrieved.metadata).toEqual({ instanceId: 'inst-abc', source: 'test' });
  });

  it('returns empty array when no events match aggregate ID', () => {
    expect(store.getByAggregateId('nonexistent')).toHaveLength(0);
  });

  it('initialize() is idempotent', () => {
    // Second call should not throw
    expect(() => store.initialize()).not.toThrow();
  });

  it('persists and retrieves command receipts', () => {
    store.recordCommandReceipt({
      commandId: 'cmd-1',
      status: 'accepted',
      commandType: 'verification.request',
      eventType: 'verification.requested',
      aggregateId: 'ver-1',
      timestamp: 1234,
      eventId: 'evt-1',
      metadata: { source: 'test' },
    });

    expect(store.getCommandReceipt('cmd-1')).toEqual({
      commandId: 'cmd-1',
      status: 'accepted',
      commandType: 'verification.request',
      eventType: 'verification.requested',
      aggregateId: 'ver-1',
      timestamp: 1234,
      eventId: 'evt-1',
      metadata: { source: 'test' },
    });
  });

  it('normalizes legacy event-typed receipts when reading from storage', () => {
    OrchestrationEventStore._resetForTesting();
    const db = new InMemoryDb();
    const legacyStore = OrchestrationEventStore.getInstance(db);
    legacyStore.initialize();

    db.prepare(`
      INSERT OR REPLACE INTO orchestration_command_receipts (
        command_id, status, type, aggregate_id, timestamp, event_id, reason, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cmd-legacy',
      'accepted',
      'verification.requested',
      'ver-legacy',
      4321,
      'evt-legacy',
      null,
      null,
    );

    expect(legacyStore.getCommandReceipt('cmd-legacy')).toEqual({
      commandId: 'cmd-legacy',
      status: 'accepted',
      commandType: 'verification.request',
      eventType: 'verification.requested',
      aggregateId: 'ver-legacy',
      timestamp: 4321,
      eventId: 'evt-legacy',
      metadata: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// OrchestrationProjector tests
// ---------------------------------------------------------------------------
describe('OrchestrationProjector', () => {
  const projector = new OrchestrationProjector();

  it('projects verification summary', () => {
    const events: OrchestrationEvent[] = [
      { id: 'e1', type: 'verification.requested', aggregateId: 'v-1', timestamp: 1000, payload: {} },
      { id: 'e2', type: 'verification.agent_responded', aggregateId: 'v-1', timestamp: 2000, payload: {} },
      { id: 'e3', type: 'verification.agent_responded', aggregateId: 'v-1', timestamp: 3000, payload: {} },
      {
        id: 'e4',
        type: 'verification.completed',
        aggregateId: 'v-1',
        timestamp: 4000,
        payload: { result: 'safe' },
      },
    ];

    const summary = projector.projectVerification(events);
    expect(summary?.status).toBe('completed');
    expect(summary?.agentResponses).toBe(2);
    expect(summary?.result).toBe('safe');
    expect(summary?.completedAt).toBe(4000);
  });

  it('projects debate summary', () => {
    const events: OrchestrationEvent[] = [
      { id: 'e1', type: 'debate.started', aggregateId: 'd-1', timestamp: 1000, payload: {} },
      { id: 'e2', type: 'debate.round_completed', aggregateId: 'd-1', timestamp: 2000, payload: {} },
      { id: 'e3', type: 'debate.round_completed', aggregateId: 'd-1', timestamp: 3000, payload: {} },
      {
        id: 'e4',
        type: 'debate.synthesized',
        aggregateId: 'd-1',
        timestamp: 4000,
        payload: { synthesis: 'Use modular monolith' },
      },
      { id: 'e5', type: 'debate.completed', aggregateId: 'd-1', timestamp: 5000, payload: {} },
    ];

    const summary = projector.projectDebate(events);
    expect(summary?.status).toBe('completed');
    expect(summary?.roundsCompleted).toBe(2);
    expect(summary?.synthesis).toBe('Use modular monolith');
    expect(summary?.completedAt).toBe(5000);
  });

  it('returns null for empty events', () => {
    expect(projector.projectVerification([])).toBeNull();
    expect(projector.projectDebate([])).toBeNull();
  });

  it('projects in-progress verification', () => {
    const events: OrchestrationEvent[] = [
      { id: 'e1', type: 'verification.requested', aggregateId: 'v-2', timestamp: 1000, payload: {} },
      { id: 'e2', type: 'verification.agent_responded', aggregateId: 'v-2', timestamp: 2000, payload: {} },
    ];

    const summary = projector.projectVerification(events);
    expect(summary?.status).toBe('in_progress');
    expect(summary?.agentResponses).toBe(1);
    expect(summary?.completedAt).toBeUndefined();
  });

  it('projects in-progress debate', () => {
    const events: OrchestrationEvent[] = [
      { id: 'e1', type: 'debate.started', aggregateId: 'd-2', timestamp: 1000, payload: {} },
      { id: 'e2', type: 'debate.round_completed', aggregateId: 'd-2', timestamp: 2000, payload: {} },
    ];

    const summary = projector.projectDebate(events);
    expect(summary?.status).toBe('in_progress');
    expect(summary?.roundsCompleted).toBe(1);
  });

  it('projects active verification lifecycle', () => {
    const events: OrchestrationEvent[] = [
      {
        id: 'e1',
        type: 'verification.requested',
        aggregateId: 'v-10',
        timestamp: 1000,
        payload: {
          id: 'v-10',
          instanceId: 'inst-10',
          prompt: 'Verify this',
          config: { agentCount: 3, timeout: 60000, synthesisStrategy: 'merge' },
        },
      },
    ];

    const active = projector.projectActiveVerificationRequest(events);
    expect(active).toEqual(expect.objectContaining({
      id: 'v-10',
      instanceId: 'inst-10',
      prompt: 'Verify this',
    }));
  });

  it('projects active debate lifecycle until completion', () => {
    const round = {
      roundNumber: 1,
      type: 'initial',
      contributions: [],
      consensusScore: 0.5,
      timestamp: 1200,
      durationMs: 200,
    };
    const startedPayload = {
      id: 'd-10',
      query: 'Debate this',
      config: {
        agents: 2,
        maxRounds: 3,
        convergenceThreshold: 0.8,
        synthesisModel: 'default',
        temperatureRange: [0.3, 0.9],
        timeout: 5000,
      },
      currentRound: 0,
      rounds: [],
      startTime: 1000,
      status: 'in_progress',
    };

    const active = projector.projectActiveDebate([
      { id: 'e1', type: 'debate.started', aggregateId: 'd-10', timestamp: 1000, payload: startedPayload },
      {
        id: 'e2',
        type: 'debate.round_completed',
        aggregateId: 'd-10',
        timestamp: 1200,
        payload: {
          ...startedPayload,
          currentRound: 1,
          rounds: [round],
          round,
        },
      },
      {
        id: 'e3',
        type: 'debate.paused',
        aggregateId: 'd-10',
        timestamp: 1300,
        payload: {
          ...startedPayload,
          currentRound: 1,
          rounds: [round],
          status: 'paused',
        },
      },
    ]);
    expect(active).toEqual(expect.objectContaining({
      id: 'd-10',
      currentRound: 1,
      status: 'paused',
      rounds: [round],
    }));

    const completed = projector.projectActiveDebate([
      { id: 'e1', type: 'debate.started', aggregateId: 'd-10', timestamp: 1000, payload: startedPayload },
      { id: 'e4', type: 'debate.completed', aggregateId: 'd-10', timestamp: 1400, payload: { id: 'd-10' } },
    ]);
    expect(completed).toBeNull();
  });

  it('projects completed verification results from event history', () => {
    const result = projector.projectVerificationResult([
      {
        id: 'e1',
        type: 'verification.completed',
        aggregateId: 'v-history',
        timestamp: 2_000,
        payload: {
          id: 'v-history',
          request: {
            id: 'v-history',
            instanceId: 'inst-history',
            prompt: 'Verify history projection',
            config: { agentCount: 3, timeout: 60_000, synthesisStrategy: 'merge' },
          },
          responses: [],
          analysis: {
            agreements: [],
            disagreements: [],
            uniqueInsights: [],
            responseRankings: [],
            overallConfidence: 0.7,
            outlierAgents: [],
            consensusStrength: 0.8,
          },
          synthesizedResponse: 'Projected verification result',
          synthesisMethod: 'merge',
          synthesisConfidence: 0.7,
          totalDuration: 1_000,
          totalTokens: 300,
          totalCost: 0.05,
          completedAt: 2_000,
        },
      },
    ]);

    expect(result).toEqual(expect.objectContaining({
      id: 'v-history',
      synthesizedResponse: 'Projected verification result',
    }));
  });

  it('projects completed debate results from event history', () => {
    const result = projector.projectDebateResult([
      {
        id: 'e1',
        type: 'debate.completed',
        aggregateId: 'd-history',
        timestamp: 2_000,
        payload: {
          id: 'd-history',
          query: 'Debate history projection',
          rounds: [],
          synthesis: 'Projected debate result',
          consensusReached: false,
          finalConsensusScore: 0.4,
          keyAgreements: [],
          unresolvedDisagreements: ['Need more data'],
          tokensUsed: 120,
          duration: 900,
          status: 'completed',
        },
      },
    ]);

    expect(result).toEqual(expect.objectContaining({
      id: 'd-history',
      synthesis: 'Projected debate result',
    }));
  });
});
