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

describe('CoordinatorEventBridge', () => {
  let mockStore: { append: ReturnType<typeof vi.fn> };
  let bridge: CoordinatorEventBridge;

  beforeEach(() => {
    mockStore = {
      append: vi.fn(),
    };
    bridge = new CoordinatorEventBridge(mockStore as unknown as import('../orchestration-event-store').OrchestrationEventStore);
  });

  it('wires verification:started to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:started', { id: 'v-1', instanceId: 'inst-1' });
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'verification.requested',
        aggregateId: 'v-1',
      }),
    );
  });

  it('wires verification:completed to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:completed', { id: 'v-1', instanceId: 'inst-1', result: 'safe' });
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'verification.completed',
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
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'verification.completed',
        aggregateId: 'v-2',
        payload: { error: 'timeout' },
      }),
    );
  });

  it('wires debate events to event store', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:started', { debateId: 'd-1' });
    coordinator.emit('debate:round-complete', { debateId: 'd-1', round: 1 });
    coordinator.emit('debate:completed', { debateId: 'd-1' });

    expect(mockStore.append).toHaveBeenCalledTimes(3);
  });

  it('maps debate:started to debate.started event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:started', { debateId: 'd-1', topic: 'test' });
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debate.started',
        aggregateId: 'd-1',
      }),
    );
  });

  it('maps debate:round-complete to debate.round_completed event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:round-complete', { debateId: 'd-1', round: 2 });
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debate.round_completed',
        aggregateId: 'd-1',
      }),
    );
  });

  it('maps debate:completed to debate.completed event type', () => {
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    coordinator.emit('debate:completed', { debateId: 'd-2', status: 'completed' });
    expect(mockStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debate.completed',
        aggregateId: 'd-2',
      }),
    );
  });

  it('handles store errors gracefully', () => {
    mockStore.append.mockImplementation(() => { throw new Error('DB error'); });
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    // Should not throw
    expect(() => coordinator.emit('verification:started', { id: 'v-1' })).not.toThrow();
  });

  it('handles store errors on debate events gracefully', () => {
    mockStore.append.mockImplementation(() => { throw new Error('disk full'); });
    const coordinator = new EventEmitter();
    bridge.wireDebateCoordinator(coordinator);

    expect(() => coordinator.emit('debate:started', { debateId: 'd-1' })).not.toThrow();
  });

  it('appends event with id, timestamp, and metadata', () => {
    const coordinator = new EventEmitter();
    bridge.wireVerifyCoordinator(coordinator);

    coordinator.emit('verification:started', { id: 'v-3', instanceId: 'inst-3' });

    const call = mockStore.append.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof call['id']).toBe('string');
    expect(typeof call['timestamp']).toBe('number');
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

    expect(mockStore.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'worktree.created',
        aggregateId: 'exec-1',
        metadata: expect.objectContaining({
          executionId: 'exec-1',
          laneId: 'exec-1',
          worktreeId: 'worktree-1',
          branchName: 'codex/feature',
        }),
      }),
    );
    expect(mockStore.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'branch.prepared',
      }),
    );
  });
});
