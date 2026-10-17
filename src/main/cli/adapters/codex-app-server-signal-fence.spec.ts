import { afterEach, describe, expect, it, vi } from 'vitest';

const connectToAppServer = vi.hoisted(() =>
  vi.fn(async (_cwd: string, _options?: { signalFence?: boolean; disableBroker?: boolean }) => ({})));

vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, connectToAppServer };
});

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({}), get: () => undefined }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';

type Connectable = { connectAppServer(cwd: string): Promise<unknown> };

describe('Codex app-server connect honours the per-session signal fence', () => {
  afterEach(() => connectToAppServer.mockClear());

  it.each([
    { name: 'without CODEX_HOME', env: undefined },
    { name: 'with CODEX_HOME', env: { CODEX_HOME: '/tmp/aio-codex-home' } },
  ])('passes signalFence false only for a fence-off session ($name)', async ({ env }) => {
    const fenced = new CodexCliAdapter(env ? { env } : {});
    await (fenced as unknown as Connectable).connectAppServer('/tmp');
    expect(connectToAppServer.mock.lastCall?.[1]).not.toHaveProperty('signalFence');

    const unfenced = new CodexCliAdapter(env ? { env } : {});
    unfenced.disableSessionSignalFence();
    await (unfenced as unknown as Connectable).connectAppServer('/tmp');
    expect(connectToAppServer.mock.lastCall?.[1]).toMatchObject({ signalFence: false });
    // Prove each case took the branch it names.
    expect(connectToAppServer.mock.lastCall?.[1]?.disableBroker === true).toBe(env !== undefined);
  });
});
