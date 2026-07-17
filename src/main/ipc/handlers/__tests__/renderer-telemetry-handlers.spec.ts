import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';

type InvokeHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
type SendHandler = (event: unknown, payload?: unknown) => void;

const mocks = vi.hoisted(() => ({
  invokeHandlers: new Map<string, InvokeHandler>(),
  sendHandlers: new Map<string, SendHandler>(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      mocks.invokeHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: SendHandler) => {
      mocks.sendHandlers.set(channel, handler);
    }),
  },
  webContents: {
    fromId: () => ({ isDestroyed: () => false }),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => mocks.logger,
}));

import {
  _resetRendererHeartbeatMonitorForTesting,
  getRendererHeartbeatMonitor,
} from '../../../logging/renderer-heartbeat-monitor';
import { registerRendererTelemetryHandlers } from '../renderer-telemetry-handlers';

function makeSender(id: number): EventEmitter & { id: number } {
  const sender = new EventEmitter() as EventEmitter & { id: number };
  sender.id = id;
  return sender;
}

describe('registerRendererTelemetryHandlers', () => {
  beforeEach(() => {
    mocks.invokeHandlers.clear();
    mocks.sendHandlers.clear();
    mocks.logger.info.mockClear();
    mocks.logger.error.mockClear();
    _resetRendererHeartbeatMonitorForTesting();
    registerRendererTelemetryHandlers();
  });

  describe('LOG_MESSAGE', () => {
    it('routes a forwarded renderer error into the main logger', async () => {
      const handler = mocks.invokeHandlers.get(IPC_CHANNELS.LOG_MESSAGE);
      expect(handler).toBeDefined();

      const response = await handler!({}, {
        level: 'error',
        message: 'Uncaught Angular error',
        context: 'RendererErrorHandler',
        metadata: { stack: 'Error: boom' },
      });

      expect(response.success).toBe(true);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Uncaught Angular error',
        undefined,
        { stack: 'Error: boom', context: 'RendererErrorHandler' },
      );
    });

    it('routes non-error levels through the matching logger method', async () => {
      const handler = mocks.invokeHandlers.get(IPC_CHANNELS.LOG_MESSAGE);
      const response = await handler!({}, { level: 'info', message: 'renderer note' });

      expect(response.success).toBe(true);
      expect(mocks.logger.info).toHaveBeenCalledWith('renderer note', {});
    });

    it('rejects a malformed payload with a structured validation error', async () => {
      const handler = mocks.invokeHandlers.get(IPC_CHANNELS.LOG_MESSAGE);
      const response = await handler!({}, { level: 'fatal', message: 42 });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('RENDERER_HEARTBEAT', () => {
    it('feeds valid beats to the monitor keyed by sender id', () => {
      const handler = mocks.sendHandlers.get(IPC_CHANNELS.RENDERER_HEARTBEAT);
      expect(handler).toBeDefined();

      handler!({ sender: makeSender(3) }, { seq: 0, sentAt: Date.now() });

      expect(getRendererHeartbeatMonitor().isTracking(3)).toBe(true);
    });

    it('ignores malformed beats without throwing', () => {
      const handler = mocks.sendHandlers.get(IPC_CHANNELS.RENDERER_HEARTBEAT);

      expect(() => handler!({ sender: makeSender(4) }, { seq: 'NaN' })).not.toThrow();
      expect(getRendererHeartbeatMonitor().isTracking(4)).toBe(false);
    });

    it('stops tracking when the sender webContents is destroyed', () => {
      const handler = mocks.sendHandlers.get(IPC_CHANNELS.RENDERER_HEARTBEAT);
      const sender = makeSender(5);

      handler!({ sender }, { seq: 0, sentAt: Date.now() });
      expect(getRendererHeartbeatMonitor().isTracking(5)).toBe(true);

      sender.emit('destroyed');
      expect(getRendererHeartbeatMonitor().isTracking(5)).toBe(false);
    });
  });
});
