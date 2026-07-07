import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { setupCoordinatorEvents } from './cli-verification-ipc-handler';

describe('CLI verification IPC event forwarding', () => {
  let coordinator: EventEmitter;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    coordinator = new EventEmitter();
    sendToRenderer = vi.fn();
    setupCoordinatorEvents(coordinator as never, sendToRenderer);
  });

  it('forwards agent error events with renderer sessionId shape', () => {
    coordinator.emit('verification:agent-error', {
      requestId: 'verification-1',
      agentId: 'agent-1',
      error: 'provider failed',
    });

    expect(sendToRenderer).toHaveBeenCalledWith('verification:agent-error', {
      sessionId: 'verification-1',
      agentId: 'agent-1',
      error: 'provider failed',
    });
  });

  it('forwards round progress and consensus update events with renderer sessionId shape', () => {
    coordinator.emit('verification:round-progress', {
      requestId: 'verification-1',
      round: 1,
      total: 1,
    });
    coordinator.emit('verification:consensus-update', {
      requestId: 'verification-1',
      score: 0.75,
    });

    expect(sendToRenderer).toHaveBeenCalledWith('verification:round-progress', {
      sessionId: 'verification-1',
      round: 1,
      total: 1,
    });
    expect(sendToRenderer).toHaveBeenCalledWith('verification:consensus-update', {
      sessionId: 'verification-1',
      score: 0.75,
    });
  });
});
