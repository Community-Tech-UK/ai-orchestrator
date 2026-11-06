/**
 * Persistent loop adapter spawn options: the loop run id rides along as the
 * trial key (so every Codex thread of one run lands in one trial group), and
 * the Claude RTK config is resolved from that same key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  cliType: 'claude' as string,
  createAdapter: vi.fn((_input: { cliType: string; options: Record<string, unknown> }) => ({ adapter: true })),
  getAutomationRtk: vi.fn((_key?: string) => undefined as unknown),
  rememberRtkAdapterConfig: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async () => hoisted.cliType),
}));
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: hoisted.createAdapter })),
}));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({
  attachProviderRoutes: vi.fn(async (_cli: string, options: unknown) => options),
}));
vi.mock('./automation-model-defaults', () => ({
  resolveAutomationDefaultModel: vi.fn(() => 'default-model'),
}));
vi.mock('./loop-adapter-account-scope', () => ({
  rememberLoopAdapterInvocation: vi.fn(),
}));
vi.mock('../cli/rtk/rtk-rollout', () => ({
  getAutomationRtk: hoisted.getAutomationRtk,
  rememberRtkAdapterConfig: hoisted.rememberRtkAdapterConfig,
}));

import { createPersistentLoopAdapter } from './default-loop-invoker-helpers';

function spawnOptions(): Record<string, unknown> {
  return hoisted.createAdapter.mock.calls[0]![0].options;
}

describe('createPersistentLoopAdapter trial grouping', () => {
  beforeEach(() => {
    hoisted.cliType = 'claude';
    hoisted.createAdapter.mockClear();
    hoisted.getAutomationRtk.mockReset();
    hoisted.getAutomationRtk.mockReturnValue(undefined);
    hoisted.rememberRtkAdapterConfig.mockClear();
  });

  it('passes the loop run id as the trial key and labels its source as a loop run', async () => {
    await createPersistentLoopAdapter({ provider: 'codex', workingDirectory: '/tmp/w', trialKey: 'loop-run-7' });
    expect(spawnOptions()).toMatchObject({ trialKey: 'loop-run-7', trialKeySource: 'loop-run' });
  });

  it('records no trial key source when the loop has no run id', async () => {
    await createPersistentLoopAdapter({ provider: 'codex', workingDirectory: '/tmp/w' });
    const options = spawnOptions();
    expect(options['trialKey']).toBeUndefined();
    expect(options).not.toHaveProperty('trialKeySource');
  });

  it('resolves the Claude RTK config from the same trial key and remembers it on the adapter', async () => {
    const rtk = { enabled: true, rtkArm: 'on' };
    hoisted.getAutomationRtk.mockReturnValue(rtk);
    const adapter = await createPersistentLoopAdapter({
      provider: 'claude', workingDirectory: '/tmp/w', trialKey: 'loop-run-8',
    });
    expect(hoisted.getAutomationRtk).toHaveBeenCalledWith('loop-run-8');
    expect(spawnOptions()['rtk']).toBe(rtk);
    expect(hoisted.rememberRtkAdapterConfig).toHaveBeenCalledWith(adapter, rtk);
  });

  it('leaves RTK off for non-Claude loops', async () => {
    hoisted.cliType = 'codex';
    await createPersistentLoopAdapter({ provider: 'codex', workingDirectory: '/tmp/w', trialKey: 'loop-run-9' });
    expect(hoisted.getAutomationRtk).not.toHaveBeenCalled();
    expect(spawnOptions()['rtk']).toBeUndefined();
    expect(spawnOptions()['ephemeral']).toBe(false);
  });
});
