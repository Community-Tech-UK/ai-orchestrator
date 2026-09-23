import { describe, expect, it, vi } from 'vitest';
import {
  parseOpenCodeAuthList,
  parseOpenCodeConfig,
  readOpenCodeAuthStatus,
  resolveOpenCodeAuthenticated,
} from './opencode-auth-status';

/** Captured from `opencode auth list` 1.18.29 in a throwaway home (ANSI kept). */
const EMPTY_LIST = '\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n\n';
/** Same format with one stored key and one provider env var; names only, no values. */
const ONE_CREDENTIAL = [
  '┌  Credentials ~/.local/share/opencode/auth.json',
  '│',
  '●  Xiaomi Token Plan (Europe) api',
  '│',
  '└  1 credentials',
  '',
  '┌  Environment',
  '│',
  '●  OpenRouter OPENROUTER_API_KEY',
  '│',
  '└  1 environment variable',
].join('\n');

describe('parseOpenCodeAuthList', () => {
  it('reads the credential and environment variable counts', () => {
    expect(parseOpenCodeAuthList(EMPTY_LIST)).toEqual({ credentials: 0, environmentVariables: 0 });
    expect(parseOpenCodeAuthList(ONE_CREDENTIAL)).toEqual({ credentials: 1, environmentVariables: 1 });
  });

  it('returns null for output it does not recognise', () => {
    expect(parseOpenCodeAuthList('Error: unknown command')).toBeNull();
    expect(parseOpenCodeAuthList('')).toBeNull();
  });
});

describe('resolveOpenCodeAuthenticated', () => {
  it('is signed in with any credential', () => {
    expect(resolveOpenCodeAuthenticated({ credentials: 1, environmentVariables: 0 }, 'xiaomi-token-plan-ams/mimo-v2.6-pro')).toBe(true);
    expect(resolveOpenCodeAuthenticated({ credentials: 0, environmentVariables: 2 }, 'openrouter/x')).toBe(true);
  });

  it('counts free Zen models, and no configured model, as usable without credentials', () => {
    const none = { credentials: 0, environmentVariables: 0 };
    expect(resolveOpenCodeAuthenticated(none, undefined)).toBe(true);
    expect(resolveOpenCodeAuthenticated(none, 'opencode/mimo-v2.6-flash-free')).toBe(true);
    expect(resolveOpenCodeAuthenticated(none, 'xiaomi-token-plan-ams/mimo-v2.6-pro')).toBe(false);
  });
});

describe('parseOpenCodeConfig', () => {
  it('reads the model and which backends carry a config-file key, without the key itself', () => {
    const summary = parseOpenCodeConfig(JSON.stringify({
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      provider: {
        'xiaomi-token-plan-ams': { options: { apiKey: 'placeholder-not-a-key' } },
        openrouter: { options: { apiKey: '' } },
        opencode: { options: {} },
      },
    }));
    expect(summary).toEqual({
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      providersWithConfigKey: ['xiaomi-token-plan-ams'],
    });
    expect(JSON.stringify(summary)).not.toContain('placeholder-not-a-key');
  });

  it('is empty for output that is not a config object', () => {
    expect(parseOpenCodeConfig('{"permission":{}}')).toEqual({ providersWithConfigKey: [] });
    expect(parseOpenCodeConfig('not json')).toEqual({ providersWithConfigKey: [] });
  });
});

describe('readOpenCodeAuthStatus', () => {
  it('does not read the config when a credential exists', async () => {
    const run = vi.fn(async () => ONE_CREDENTIAL);
    await expect(readOpenCodeAuthStatus(run, undefined)).resolves.toMatchObject({ authenticated: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['auth', 'list']);
  });

  it('checks OpenCode’s configured model when there are no credentials', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[0] === 'auth' ? EMPTY_LIST : '{"model":"xiaomi-token-plan-ams/mimo-v2.6-pro"}');
    await expect(readOpenCodeAuthStatus(run, undefined)).resolves.toEqual({
      authenticated: false,
      counts: { credentials: 0, environmentVariables: 0 },
      effectiveModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    });
    expect(run).toHaveBeenCalledWith(['debug', 'config']);
  });

  it('prefers the model AIO will request over OpenCode’s configured one', async () => {
    const run = vi.fn(async (args: string[]) =>
      (args[0] === 'auth' ? EMPTY_LIST : '{"model":"xiaomi-token-plan-ams/mimo-v2.6-pro"}'));
    await expect(readOpenCodeAuthStatus(run, 'opencode/big-pickle')).resolves.toMatchObject({
      authenticated: true,
      effectiveModel: 'opencode/big-pickle',
    });
  });

  it('counts a key kept in OpenCode’s config file for the selected backend', async () => {
    const config = JSON.stringify({ provider: { 'xiaomi-token-plan-ams': { options: { apiKey: 'placeholder-not-a-key' } } } });
    const run = vi.fn(async (args: string[]) => (args[0] === 'auth' ? EMPTY_LIST : config));
    await expect(readOpenCodeAuthStatus(run, 'xiaomi-token-plan-ams/mimo-v2.6-pro')).resolves.toMatchObject({ authenticated: true });
    await expect(readOpenCodeAuthStatus(run, 'openrouter/some-model')).resolves.toMatchObject({ authenticated: false });
  });

  it('is not signed in when auth list output is unrecognisable', async () => {
    await expect(readOpenCodeAuthStatus(async () => 'garbage', undefined)).resolves.toEqual({
      authenticated: false,
      counts: null,
    });
  });
});
