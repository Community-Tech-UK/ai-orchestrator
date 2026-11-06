import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { UsageInsightResponse } from '../../../shared/usage-insight/usage-insight.types';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) },
  app: { getPath: () => '/fixture-user-data' },
}));

import { _resetUsageInsightServiceForTesting } from '../../usage-insight/usage-insight-runtime';
import type { UsageInsightService } from '../../usage-insight/usage-insight-service';
import { registerUsageInsightHandlers } from './usage-insight-handlers';

const scanning: UsageInsightResponse = {
  status: 'scanning',
  progress: { filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 100 },
};

function call(payload?: unknown) {
  return handlers.get(IPC_CHANNELS.USAGE_INSIGHT_GET)!({}, payload);
}

describe('usage insight IPC', () => {
  beforeEach(() => handlers.clear());
  afterEach(() => _resetUsageInsightServiceForTesting());

  describe('with a fake service', () => {
    const getResponse = vi.fn((): UsageInsightResponse => scanning);
    beforeEach(() => {
      getResponse.mockClear();
      registerUsageInsightHandlers({ service: { getResponse } as unknown as UsageInsightService });
    });

    it('registers the one channel', () => {
      expect([...handlers.keys()]).toEqual([IPC_CHANNELS.USAGE_INSIGHT_GET]);
      expect(IPC_CHANNELS.USAGE_INSIGHT_GET).toBe('usage-insight:get');
    });

    it('returns what the service says', async () => {
      expect(await call({})).toEqual({ success: true, data: scanning });
    });

    it('treats no payload as "every session"', async () => {
      await call(undefined);
      expect(getResponse).toHaveBeenCalledWith({});
    });

    it('passes the session and the refresh request on', async () => {
      await call({ instanceId: 'inst-1', refresh: true });
      expect(getResponse).toHaveBeenCalledWith({ instanceId: 'inst-1', refresh: true });
    });

    it.each([
      ['an unexpected field', { instanceId: 'a', path: '/etc/passwd' }],
      ['an empty session id', { instanceId: '' }],
      ['a very long session id', { instanceId: 'x'.repeat(101) }],
      ['a refresh flag that is not true or false', { refresh: 'yes' }],
      ['a payload that is not an object', 'inst-1'],
    ])('rejects %s without asking the service', async (_name, payload) => {
      const response = await call(payload);
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_FAILED');
      expect(getResponse).not.toHaveBeenCalled();
    });
  });

  it('refuses a sender that is not the app window', async () => {
    const getResponse = vi.fn();
    registerUsageInsightHandlers({
      service: { getResponse } as unknown as UsageInsightService,
      ensureTrustedSender: () => ({ success: false, error: { code: 'UNTRUSTED_SENDER', message: 'no', timestamp: 1 } }),
    });
    expect((await call({})).error?.code).toBe('UNTRUSTED_SENDER');
    expect(getResponse).not.toHaveBeenCalled();
  });

  describe('with the app-wide service', () => {
    const instances: Record<string, { provider: string; sessionId: string; executionLocation?: { type: string } }> = {
      'inst-codex': { provider: 'codex', sessionId: 'thread-1', executionLocation: { type: 'local' } },
      'inst-far': { provider: 'claude', sessionId: 'sess-far', executionLocation: { type: 'remote' } },
    };
    beforeEach(() => registerUsageInsightHandlers({ instanceManager: { getInstance: (id: string) => instances[id] } as never }));

    it('looks sessions up through the instance manager', async () => {
      expect((await call({ instanceId: 'no-such-session' })).data).toEqual({ status: 'unsupported', reason: 'unknown-instance' });
      expect((await call({ instanceId: 'inst-codex' })).data).toEqual({ status: 'unsupported', reason: 'not-claude' });
    });

    it('knows a session on another computer is not here to read', async () => {
      expect((await call({ instanceId: 'inst-far' })).data).toEqual({ status: 'unsupported', reason: 'remote' });
    });
  });
});
