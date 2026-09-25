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
