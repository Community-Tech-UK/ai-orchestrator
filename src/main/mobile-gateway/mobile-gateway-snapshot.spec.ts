import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Instance } from '../../shared/types/instance.types';
import { MobileGatewaySnapshotService } from './mobile-gateway-snapshot';

function instance(index: number): Instance {
  return {
    id: `instance-${index}`,
    displayName: `Agent ${index}`,
    status: index % 2 ? 'busy' : 'idle',
    provider: 'codex',
    currentModel: 'gpt-5.4',
    workingDirectory: `/Users/test/project-${index}`,
    createdAt: 1_000 + index,
    lastActivity: 2_000 + index,
    parentId: null,
  } as Instance;
}

describe('MobileGatewaySnapshotService measurement', () => {
  it('keeps a coalesced 10-session steady-state snapshot below the delta threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const send = vi.fn();
    const client = { readyState: WebSocket.OPEN, send } as never;
    const debug = vi.fn();
    const service = new MobileGatewaySnapshotService({
      clients: new Set([client]), isRunning: () => true,
      getInstances: () => Array.from({ length: 10 }, (_, index) => instance(index)),
      getPrompts: () => [],
      getPauseState: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
      getActiveLoops: () => [], hasUnreadCompletion: () => false,
      getQueuedMessages: () => undefined, debug,
      profileOfClient: () => 'owner', profileOfInstance: () => 'owner',
    });

    for (let index = 0; index < 10; index += 1) service.scheduleBroadcast();
    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('Mobile snapshot broadcast', expect.objectContaining({
      instanceCount: 10,
      broadcastsPerSecond: 1,
    }));
    const measurement = debug.mock.calls[0]![1] as { bytes: number };
    expect(measurement.bytes).toBeLessThan(32 * 1024);
    // Durable evidence for the plan's measure-first gate.
    expect(measurement.bytes).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

describe('MobileGatewaySnapshotService per-person delivery', () => {
  function setup() {
    const ownerSend = vi.fn();
    const memberSend = vi.fn();
    const owner = { readyState: WebSocket.OPEN, send: ownerSend } as never;
    const member = { readyState: WebSocket.OPEN, send: memberSend } as never;
    const sessions: Record<string, string> = { 'owner-session': 'owner', 'member-session': 'member' };
    const service = new MobileGatewaySnapshotService({
      clients: new Set([owner, member]), isRunning: () => true,
      getInstances: () => [], getPrompts: () => [],
      getPauseState: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
      getActiveLoops: () => [], hasUnreadCompletion: () => false, getQueuedMessages: () => undefined,
      profileOfClient: (client) => (client === owner ? 'owner' : 'member'),
      profileOfInstance: (instanceId) => sessions[instanceId] ?? 'owner',
    });
    const received = (send: ReturnType<typeof vi.fn>) =>
      send.mock.calls.map(([raw]) => (JSON.parse(raw as string) as { type: string }).type);
    return { service, ownerSend, memberSend, received };
  }

  it('keeps Harness-wide state and browser approvals for the owner alone', () => {
    const { service, ownerSend, memberSend, received } = setup();

    service.broadcast({ type: 'quota-state', data: {} as never });
    service.broadcast({ type: 'loop-state', data: { runId: 'run', run: null } });
    service.broadcast({ type: 'plan-queue-state', data: { runId: 'run', run: null } });
    service.broadcast({ type: 'permission-cleared', data: { requestId: 'browser-request' } });
    service.broadcast({
      type: 'permission-prompt',
      data: {
        id: 'b', requestId: 'b', instanceId: 'member-session', kind: 'browser',
        title: 'Browser', message: 'Allow?', createdAt: 1,
      },
    });

    expect(received(ownerSend)).toEqual([
      'quota-state', 'loop-state', 'plan-queue-state', 'permission-cleared', 'permission-prompt',
    ]);
    expect(memberSend).not.toHaveBeenCalled();
  });

  it("sends session events only to the session's person and the pause state to everyone", () => {
    const { service, ownerSend, memberSend, received } = setup();
    const output = (instanceId: string) => ({
      type: 'instance-output' as const,
      data: { instanceId, seq: 1, message: { id: 'm', type: 'assistant' as const, content: 'hi', timestamp: 1 } as never },
    });

    service.broadcast(output('owner-session'));
    service.broadcast(output('member-session'));
    service.broadcast({ type: 'permission-cleared', data: { requestId: 'r', instanceId: 'member-session' } });
    service.broadcast({ type: 'instance-state', data: [{ id: 'owner-session' }, { id: 'member-session' }] as never });
    service.broadcast({ type: 'pause-state', data: { isPaused: true, reasons: ['user'], pausedAt: 1, lastChange: 1 } });

    expect(received(ownerSend)).toEqual(['instance-output', 'instance-state', 'pause-state']);
    expect(received(memberSend)).toEqual(['instance-output', 'permission-cleared', 'instance-state', 'pause-state']);
    const ids = (send: ReturnType<typeof vi.fn>, type: string) => send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string; data: unknown })
      .filter((event) => event.type === type)
      .map((event) => JSON.stringify(event.data));
    expect(ids(memberSend, 'instance-output')[0]).toContain('member-session');
    expect(ids(memberSend, 'instance-state')).toEqual([JSON.stringify([{ id: 'member-session' }])]);
    expect(ids(ownerSend, 'instance-state')).toEqual([JSON.stringify([{ id: 'owner-session' }])]);
  });
});
