import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOpenCodeEffectiveBudgetConfig } from './opencode-effective-budget-config';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), jail: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn, default: { ...actual, spawn: mocks.spawn } };
});
vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: mocks.kill }));
vi.mock('../../sandbox/seatbelt', () => ({ resolveHardenedSpawn: mocks.jail }));
vi.mock('../../security/env-filter', () => ({ getSafeEnvForTrustedProcess: () => ({ PATH: process.env['PATH'], CLAUDECODE: 'LOCAL_TEST_PLACEHOLDER' }) }));

describe('private native OpenCode config probe', () => {
  let proc: EventEmitter & { pid: number; stdout: EventEmitter };
  const params = { workingDirectory: '/tmp', env: { OPENCODE_CONFIG_CONTENT: '{}' }, model: 'xiaomi-token-plan/mimo-v2.6-pro' };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    proc = Object.assign(new EventEmitter(), { pid: 123456789, stdout: new EventEmitter() });
    mocks.spawn.mockReturnValue(proc);
    mocks.jail.mockImplementation(({ command, args }) => ({ command, args }));
  });
  afterEach(() => vi.useRealTimers());
  it('returns only selected numeric limits from effective native config', async () => {
    const result = readOpenCodeEffectiveBudgetConfig(params);
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      instructions: ['LOCAL_PRIVATE_BODY_PLACEHOLDER'], provider: { 'xiaomi-token-plan': {
        options: { apiKey: 'LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER' }, models: { 'mimo-v2.6-pro': {
          options: { max_completion_tokens: 1024, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' },
          limit: { context: 800000, output: 4096 },
        } },
      } },
    })));
    proc.emit('close', 0);
    expect(await result).toEqual({ agent: {}, permission: {}, provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      options: { max_completion_tokens: 1024 }, limit: { context: 800000, output: 4096 },
    } } } } });
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: '/tmp', stdio: ['ignore', 'pipe', 'ignore'], env: params.env });
    expect(mocks.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('CLAUDECODE');
  });
  it('retains only numeric agent/variant limits, safe scope identifiers and permission precedence actions', async () => {
    const result = readOpenCodeEffectiveBudgetConfig(params);
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      plugin: ['LOCAL_PRIVATE_BODY_PLACEHOLDER'], small_model: 'other-provider/vendor/other-model',
      permission: { '*': 'allow', read: { '/LOCAL_PRIVATE_BODY_PLACEHOLDER': 'deny' } },
      agent: { build: { model: 'other-provider/vendor/other-model', mode: 'primary', max_completion_tokens: 256,
        options: { max_completion_tokens: 32768, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' },
        permission: { 'doom_loop*': 'allow' }, prompt: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' } },
      provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { variants: { high: {
        max_completion_tokens: 32768, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER',
      } } } } } },
    })));
    proc.emit('close', 0);
    const projected = await result;
    expect(projected).toMatchObject({ plugin: [true], small_model: 'other-provider/vendor/other-model',
      permission: { '*': 'allow', read: 'patterned' },
      agent: { build: { model: 'other-provider/vendor/other-model', mode: 'primary', max_completion_tokens: 256,
        options: { max_completion_tokens: 256 }, permission: { 'doom_loop*': 'allow' } } },
      provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': { variants: { high: { max_completion_tokens: 32768 } } } } } },
    });
    expect(JSON.stringify(projected)).not.toContain('LOCAL_PRIVATE_BODY_PLACEHOLDER');
  });
  it('uses configured hardened roots for the auxiliary command', async () => {
    const result = readOpenCodeEffectiveBudgetConfig({ ...params, writableRoots: ['/tmp/granted'] });
    proc.stdout.emit('data', Buffer.from('{}'));
    proc.emit('close', 0);
    await result;
    expect(mocks.jail).toHaveBeenCalledWith({ hardened: true, command: 'opencode', args: ['debug', 'config'], writableRoots: ['/tmp/granted'] });
  });
  it.each(['invalid-json', 'exit', 'spawn', 'stream', 'oversized', 'timeout', 'jail'])('fails closed without leaking native output on %s', async (kind) => {
    if (kind === 'jail') mocks.jail.mockImplementation(() => { throw new Error('LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER'); });
    const result = readOpenCodeEffectiveBudgetConfig(params);
    const assertion = expect(result).rejects.toThrow(/^Unable to resolve OpenCode model limits safely; refusing to replace native configuration\.$/);
    if (kind === 'invalid-json') { proc.stdout.emit('data', Buffer.from('LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER')); proc.emit('close', 0); }
    if (kind === 'exit') proc.emit('close', 1);
    if (kind === 'spawn') proc.emit('error', new Error('LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER'));
    if (kind === 'stream') proc.stdout.emit('error', new Error('LOCAL_PRIVATE_CREDENTIAL_PLACEHOLDER'));
    if (kind === 'oversized') proc.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    if (kind !== 'jail') expect(mocks.kill).toHaveBeenCalledWith(proc.pid, 'SIGKILL');
  });
});
