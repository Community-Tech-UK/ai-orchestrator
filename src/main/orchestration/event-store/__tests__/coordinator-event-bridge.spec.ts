/**
 * CoordinatorEventBridge — Unit Tests
 *
 * Verifies that coordinator events are correctly translated and forwarded
 * to the OrchestrationEventStore.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { CoordinatorEventBridge } from '../coordinator-event-bridge';
import { OrchestrationEngine } from '../../orchestration-engine';

describe('CoordinatorEventBridge', () => {
  let mockDispatcher: { dispatch: ReturnType<typeof vi.fn> };
  let bridge: CoordinatorEventBridge;

  beforeEach(() => {
    mockDispatcher = {
      dispatch: vi.fn(() => ({
        receipt: {
          commandId: 'command-1',
          status: 'accepted',
          commandType: 'verification.request',
          eventType: 'verification.requested',
          aggregateId: 'aggregate-1',
          timestamp: Date.now(),
        },
        duplicate: false,
      })),
    };
    bridge = new CoordinatorEventBridge(mockDispatcher as unknown as OrchestrationEngine);
  });

  it('wires verification:started to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:started', { id: 'v-1', instanceId: 'inst-1' });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'verification.request',
        aggregateId: 'v-1',
        payload: { id: 'v-1', instanceId: 'inst-1' },
      }),
    );
  });

  it('wires verification:completed to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:completed', { id: 'v-1', instanceId: 'inst-1', result: 'safe' });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'verification.complete',
        aggregateId: 'v-1',
      }),
    );
  });

  it('wires verification:error to event store as completed', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:error', {
      request: { id: 'v-2', instanceId: 'inst-2' },
      error: 'timeout',
    });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'verification.complete',
        aggregateId: 'v-2',
        payload: { error: 'timeout' },
      }),
    );
  });

  it('wires verification:cancelled to orchestration engine', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:cancelled', { verificationId: 'v-cancelled' });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'verification.cancel',
        aggregateId: 'v-cancelled',
        payload: { verificationId: 'v-cancelled' },
      }),
    );
  });

  it('wires debate events to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:started', { debateId: 'd-1' });
    coordinator.emit('debate:round-complete', { debateId: 'd-1', round: 1 });
    coordinator.emit('debate:completed', { debateId: 'd-1' });

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(3);
  });

  it('maps debate:started to debate.started event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:started', { debateId: 'd-1', topic: 'test' });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'debate.start',
        aggregateId: 'd-1',
      }),
    );
  });

  it('hydrates debate lifecycle payloads from coordinator state when available', () => {
    const statefulCoordinator = Object.assign(new EventEmitter(), {
      getDebate: vi.fn((debateId: string) => ({
        id: debateId,
        query: 'Stateful debate',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-stateful',
        currentRound: 0,
        rounds: [],
        startTime: 1234,
        status: 'in_progress',
      })),
    });

    bridge.wireDebateCoordinator(statefulCoordinator);
    statefulCoordinator.emit('debate:started', { debateId: 'd-stateful', query: 'Stateful debate' });

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'debate.start',
        aggregateId: 'd-stateful',
        payload: expect.objectContaining({
          id: 'd-stateful',
          query: 'Stateful debate',
          currentRound: 0,
          status: 'in_progress',
          instanceId: 'inst-stateful',
        }),
        metadata: { instanceId: 'inst-stateful' },
      }),
    );
  });

  it('maps debate:round-complete to debate.round_completed event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:round-complete', { debateId: 'd-1', round: 2 });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'debate.record-round',
        aggregateId: 'd-1',
      }),
    );
  });

  it('maps debate:completed to debate.completed event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:completed', { debateId: 'd-2', status: 'completed' });
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'debate.complete',
        aggregateId: 'd-2',
      }),
    );
  });

  it('emits debate.synthesized when the synthesis round completes', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:round-complete', {
      debateId: 'd-synth',
      round: { type: 'synthesis', index: 3 },
    });

    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandType: 'debate.record-round',
        aggregateId: 'd-synth',
      }),
    );
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandType: 'debate.record-synthesis',
        aggregateId: 'd-synth',
      }),
    );
  });

  it('maps debate pause and resume events into lifecycle entries', () => {
    const statefulCoordinator = Object.assign(new EventEmitter(), {
      getDebate: vi.fn((debateId: string) => ({
        id: debateId,
        query: 'Pause test',
        config: {
          agents: 2,
          maxRounds: 3,
          convergenceThreshold: 0.8,
          synthesisModel: 'default',
          temperatureRange: [0.3, 0.9],
          timeout: 5000,
        },
        instanceId: 'inst-pause',
        currentRound: 1,
        rounds: [],
        startTime: 1234,
        status: 'paused',
      })),
    });

    bridge.wireDebateCoordinator(statefulCoordinator);
    statefulCoordinator.emit('debate:paused', { debateId: 'd-pause' });
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandType: 'debate.pause',
        aggregateId: 'd-pause',
        payload: expect.objectContaining({
          id: 'd-pause',
          status: 'paused',
        }),
      }),
    );

    statefulCoordinator.getDebate.mockReturnValue({
      id: 'd-pause',
      query: 'Pause test',
      config: {
        agents: 2,
        maxRounds: 3,
        convergenceThreshold: 0.8,
        synthesisModel: 'default',
        temperatureRange: [0.3, 0.9],
        timeout: 5000,
      },
      instanceId: 'inst-pause',
      currentRound: 1,
      rounds: [],
      startTime: 1234,
      status: 'in_progress',
    });

    statefulCoordinator.emit('debate:resumed', { debateId: 'd-pause' });
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandType: 'debate.resume',
        aggregateId: 'd-pause',
        payload: expect.objectContaining({
          id: 'd-pause',
          status: 'in_progress',
        }),
      }),
    );
  });

  it('handles store errors gracefully', () => {
    mockDispatcher.dispatch.mockImplementation(() => { throw new Error('DB error'); });
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    // Should not throw
    expect(() => coordinator.emit('verification:started', { id: 'v-1' })).not.toThrow();
  });

  it('handles store errors on debate events gracefully', () => {
    mockDispatcher.dispatch.mockImplementation(() => { throw new Error('disk full'); });
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    expect(() => coordinator.emit('debate:started', { debateId: 'd-1' })).not.toThrow();
  });

  it('forwards metadata with verification commands', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:started', { id: 'v-3', instanceId: 'inst-3' });

    const call = mockDispatcher.dispatch.mock.calls[0][0] as Record<string, unknown>;
    expect(call['metadata']).toEqual({ instanceId: 'inst-3' });
  });

  it('maps parallel worktree events into lane and branch lifecycle entries', () => {
    const coordinator = new EventEmitter();
    bridge.wireParallelWorktreeCoordinator(coordinator);

    coordinator.emit('worktree:created', {
      executionId: 'exec-1',
      taskId: 'task-1',
      session: {
        id: 'worktree-1',
        branchName: 'codex/feature',
        worktreePath: '/tmp/worktree',
      },
    });

    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandType: 'worktree.create',
        aggregateId: 'exec-1',
        metadata: expect.objectContaining({
          executionId: 'exec-1',
          laneId: 'exec-1',
          worktreeId: 'worktree-1',
          branchName: 'codex/feature',
        }),
      }),
    );
    expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandType: 'branch.prepare',
      }),
    );
  });

  it('disposes registered listeners', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);
    bridge.dispose();

    coordinator.emit('verification:started', { id: 'v-disposed', instanceId: 'inst-1' });

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('routes coordinator events through the orchestration engine before append', async () => {
    const append = vi.fn();
    const engine = new OrchestrationEngine({
      append,
      recordCommandReceipt: vi.fn(),
      getCommandReceipt: vi.fn(),
    } as never);
    const engineBridge = new CoordinatorEventBridge(engine);
    const coordinator = new EventEmitter();
    engineBridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:started', { id: 'v-engine', instanceId: 'inst-engine' });
    await engine.drain();

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'verification.requested',
        aggregateId: 'v-engine',
        payload: { id: 'v-engine', instanceId: 'inst-engine' },
      }),
    );
  });
});
