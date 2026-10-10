import { execFile, type ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../main/logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { materializeWorkerAccountRoute, type WorkerBindingCheck } from './worker-account-route';

const mockExecFile = vi.mocked(execFile);
const AUTH_LIST = [
  '┌  Credentials',
  '●  aio-mimo-synthetic-b api',
  '●  xiaomi-token-plan-ams api',
  '●  xiaomi-token-plan-sgp api',
  '●  xiaomi-token-plan-cn api',
  '└  4 credentials',
].join('\n');

beforeEach(() => {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((_file, _args, _options, callback) => {
    if (!callback) throw new Error('Missing fixture callback');
    queueMicrotask(() => callback(null, AUTH_LIST, ''));
    return {} as ChildProcess;
  });
});

describe('worker account route validation before binding', () => {
  it.each([
    ['unknown', 'moon'], ['missing', undefined], ['null', null], ['empty', ''],
    ['object', { region: 'ams' }], ['array', ['ams']], ['boolean', true], ['number', 1],
    ['padded', ' ams'], ['uppercase', 'AMS'], ['shell-shaped', 'ams & echo AIO_REGION_PLACEHOLDER &'],
  ])('refuses a %s region for custom and legacy profiles before the default native binding read', async (_name, region) => {
    for (const profileId of ['synthetic-b', 'legacy']) {
      await expect(materializeWorkerAccountRoute('opencode', { provider: 'opencode', profileId, region }))
        .rejects.toThrow(/Token Plan region/);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each([
    null, undefined, [], 'route-placeholder', {},
    { provider: 'gemini', profileId: 'synthetic-b' },
    { provider: 'codex', profileId: '../escape' },
    { provider: 'codex', profileId: { value: 'synthetic-b' } },
    { provider: 'codex', profileId: 'synthetic-b', expectedIdentity: {} },
    { provider: 'codex', profileId: 'synthetic-b', source: [] },
  ])('refuses malformed route metadata before even an injected binding check (%j)', async (route) => {
    const binding = vi.fn();
    await expect(materializeWorkerAccountRoute('codex', route, binding)).rejects.toThrow(/account route/);
    expect(binding).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('retains the provider-mismatch error and does not check binding', async () => {
    const binding = vi.fn();
    await expect(materializeWorkerAccountRoute('claude', { provider: 'codex', profileId: 'synthetic-b' }, binding))
      .rejects.toThrow('A codex account route was sent with a claude spawn.');
    expect(binding).not.toHaveBeenCalled();
  });

  it.each(['ams', 'sgp', 'cn'] as const)('accepts authenticated custom and legacy routes for %s with the actual default binding service', async (region) => {
    for (const profileId of ['synthetic-b', 'legacy']) {
      expect(await materializeWorkerAccountRoute('opencode', { provider: 'opencode', profileId, region, expectedIdentity: null }))
        .toEqual({ provider: 'opencode', profileId, region, source: 'persisted', executionNodeId: 'worker' });
    }
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledWith('opencode', ['auth', 'list'],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
  });

  it.each(['claude', 'codex'] as const)('retains %s route binding and identity without requiring a region', async (provider) => {
    const binding = vi.fn<WorkerBindingCheck>(async () => ({ provider, profileId: 'synthetic-b', nodeId: 'worker', state: 'authenticated', checkedAt: 0 }));
    expect(await materializeWorkerAccountRoute(provider, { provider, profileId: 'synthetic-b', expectedIdentity: 'person@example.com' }, binding))
      .toEqual({ provider, profileId: 'synthetic-b', source: 'persisted', executionNodeId: 'worker', expectedIdentity: 'person@example.com' });
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ provider, expectedIdentity: 'person@example.com' }), 'worker');
    expect(binding.mock.calls[0]?.[0]).not.toHaveProperty('region');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('does not turn a valid region into proof of a sign-in', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      if (!callback) throw new Error('Missing fixture callback');
      queueMicrotask(() => callback(null, '┌  Credentials\n└  0 credentials\n', ''));
      return {} as ChildProcess;
    });
    await expect(materializeWorkerAccountRoute('opencode', { provider: 'opencode', profileId: 'synthetic-b', region: 'ams' }))
      .rejects.toThrow(/not signed in on this node/);
    expect(mockExecFile).toHaveBeenCalledOnce();
  });
});
