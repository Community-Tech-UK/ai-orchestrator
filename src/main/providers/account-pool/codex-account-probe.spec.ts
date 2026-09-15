import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildCodexProbeEnv, codexProbeQuotaSnapshot, probeCodexAccount, type CodexProbeClient } from './codex-account-probe';

function scriptedClient(responses: Record<string, unknown>, delayMs = 0) {
  const calls: string[] = [];
  const close = vi.fn(async () => undefined);
  const client = {
    request: vi.fn(async (method: string) => {
      calls.push(method);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return responses[method];
    }),
    close,
  } as unknown as CodexProbeClient;
  return { client, calls, close };
}

describe('probeCodexAccount', () => {
  it('reads identity and rate limits, then closes', async () => {
    const { client, calls, close } = scriptedClient({
      'account/read': { account: { email: 'b@example.com', planType: 'pro' } },
      'account/rateLimits/read': {
        accountId: 'acct-b',
        ordinaryUsageAllowed: true,
        rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 } },
      },
    });
    const connector = vi.fn(async (_home: string, _env: NodeJS.ProcessEnv) => client);
    const result = await probeCodexAccount('/profiles/pro-b', { connector });
    expect(result).toEqual({
      identity: { email: 'b@example.com', planType: 'pro', accountId: 'acct-b' },
      rateLimits: expect.objectContaining({ primary: expect.objectContaining({ usedPercent: 12 }) }),
      ordinaryUsageAllowed: true,
    });
    expect(calls).toEqual(['account/read', 'account/rateLimits/read']);
    expect(close).toHaveBeenCalled();
    expect(connector.mock.calls[0]?.[1]?.['CODEX_HOME']).toBe('/profiles/pro-b');
    expect(codexProbeQuotaSnapshot(result)?.windows[0]?.id).toBe('codex.5h');
  });

  it('shares one in-flight probe per home and times out', async () => {
    const { client } = scriptedClient({ 'account/read': {}, 'account/rateLimits/read': {} }, 50);
    const connector = vi.fn(async () => client);
    const [a, b] = await Promise.all([
      probeCodexAccount('/profiles/shared', { connector }),
      probeCodexAccount('/profiles/shared', { connector }),
    ]);
    expect(a).toBe(b);
    expect(connector).toHaveBeenCalledTimes(1);

    const slow = scriptedClient({}, 200);
    await expect(probeCodexAccount('/profiles/slow', { connector: async () => slow.client, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(slow.close).toHaveBeenCalled();
  });

  it('closes an app-server that only finishes connecting after the probe timed out', async () => {
    const late = scriptedClient({ 'account/read': {}, 'account/rateLimits/read': {} });
    let finishConnecting!: () => void;
    const connected = new Promise<void>((resolve) => { finishConnecting = resolve; });
    const connector = async () => {
      await connected;
      return late.client;
    };
    await expect(probeCodexAccount('/profiles/slow-spawn', { connector, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(late.close).not.toHaveBeenCalled();
    finishConnecting();
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
  });

  it('strips ambient API keys from the probe env', () => {
    process.env['OPENAI_API_KEY'] = 'ambient-placeholder';
    try {
      expect(buildCodexProbeEnv('/h')['OPENAI_API_KEY']).toBeUndefined();
    } finally {
      delete process.env['OPENAI_API_KEY'];
    }
  });
});
