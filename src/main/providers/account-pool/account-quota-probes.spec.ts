import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';

const readerOptions = vi.hoisted(() => [] as unknown[]);

const stateRoot = { current: '' };

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../cli/adapters/adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../../cli/adapters/adapter-spawn-helpers')>('../../cli/adapters/adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});

import { ThrottledAccountQuotaProbe, buildAccountQuotaProbes } from './account-quota-probes';
import { ClaudeCredentialsReader } from '../../core/system/provider-quota/claude-credentials-reader';

vi.mock('../../core/system/provider-quota/mimo-console-credentials-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/system/provider-quota/mimo-console-credentials-reader')>();
  return {
    ...actual,
    MimoConsoleCredentialsReader: class {
      constructor(options: unknown) {
        readerOptions.push(options);
      }
      async read() {
        return { session: null, reason: 'not-found' as const };
      }
      async readAccountSso() {
        return { cookieHeader: '' };
      }
    },
  };
});

function profile(provider: 'claude' | 'codex' | 'opencode', id: string, enabled = true): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: id === 'legacy' ? 0 : 1, enabled, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}),
    ...(provider === 'opencode' && id === 'max-c' ? { chromeProfile: 'Profile 1' } : {}),
  };
}

beforeEach(() => {
  stateRoot.current = mkdtempSync(join(tmpdir(), 'account-quota-probes-'));
});

afterEach(() => {
  rmSync(stateRoot.current, { recursive: true, force: true });
});

describe('account quota probes', () => {
  it('builds one probe per non-legacy profile, disabled ones included, keyed by profile id', () => {
    const claude = buildAccountQuotaProbes('claude', [profile('claude', 'legacy'), profile('claude', 'max-b'), profile('claude', 'max-c', false)]);
    expect(claude.map((probe) => [probe.provider, probe.accountProfileId])).toEqual([['claude', 'max-b'], ['claude', 'max-c']]);
    expect(claude.map((probe) => probe.silenceAlerts)).toEqual([false, true]);
    const codex = buildAccountQuotaProbes('codex', [profile('codex', 'legacy'), profile('codex', 'pro-b'), profile('codex', 'pro-c', false)]);
    expect(codex.map((probe) => [probe.provider, probe.accountProfileId, probe.silenceAlerts])).toEqual([['codex', 'pro-b', false], ['codex', 'pro-c', true]]);
  });

  it('throttles a probe to its minimum interval', async () => {
    const clock = { now: 1_000 };
    const inner = { provider: 'claude' as const, accountProfileId: 'max-b', probe: vi.fn(async () => null) };
    const throttled = new ThrottledAccountQuotaProbe(inner, () => 120_000, () => clock.now);
    const signal = new AbortController().signal;
    await throttled.probe({ signal });
    await throttled.probe({ signal });
    expect(inner.probe).toHaveBeenCalledTimes(1);
    clock.now += 120_000;
    await throttled.probe({ signal });
    expect(inner.probe).toHaveBeenCalledTimes(2);
  });

  it('leaves the throttle window open when the inner probe throws, so retries are not swallowed', async () => {
    const clock = { now: 1_000 };
    let attempts = 0;
    const inner = {
      provider: 'opencode' as const,
      probe: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return null;
      }),
    };
    const throttled = new ThrottledAccountQuotaProbe(inner, () => 120_000, () => clock.now);
    const signal = new AbortController().signal;

    await expect(throttled.probe({ signal })).rejects.toThrow('network down');
    // A retry right after the failure must reach the probe, not a throttled null.
    await expect(throttled.probe({ signal })).resolves.toBeNull();
    expect(inner.probe).toHaveBeenCalledTimes(2);
  });

  it('runs immediately when force is set, ignoring the throttle window', async () => {
    const clock = { now: 1_000 };
    const inner = { provider: 'opencode' as const, probe: vi.fn(async () => null) };
    const throttled = new ThrottledAccountQuotaProbe(inner, () => 120_000, () => clock.now);
    const signal = new AbortController().signal;

    await throttled.probe({ signal });
    await throttled.probe({ signal, force: true });

    expect(inner.probe).toHaveBeenCalledTimes(2);
  });

  it('builds MiMo per-account probes with each account’s Chrome profile, silent while disabled', () => {
    readerOptions.length = 0;
    const probes = buildAccountQuotaProbes('opencode', [
      profile('opencode', 'legacy'),
      profile('opencode', 'max-b'),
      profile('opencode', 'max-c', false),
    ]);
    expect(probes.map((probe) => [probe.accountProfileId, probe.silenceAlerts])).toEqual([
      ['max-b', false],
      ['max-c', true],
    ]);
    // Decision 8: each account's probe reads the Chrome profile it names; the
    // account without one must never construct a Default reader.
    expect(readerOptions).toEqual([{ chromeProfile: 'Profile 1' }]);
  });

  it('accepts an explicitly associated Default profile', async () => {
    readerOptions.length = 0;
    const [probe] = buildAccountQuotaProbes('opencode', [{ ...profile('opencode', 'max-b'), chromeProfile: 'Default' }]);
    const snapshot = await probe!.probe({ signal: new AbortController().signal });
    expect(readerOptions).toEqual([{ chromeProfile: 'Default' }]);
    expect(snapshot?.notApplicable).toBeUndefined();
    expect(snapshot?.windows).toEqual([]);
  });

  it('runs MiMo account probes through the throttled wrapper', async () => {
    const [probe] = buildAccountQuotaProbes('opencode', [profile('opencode', 'max-b')]);
    expect(probe).toBeInstanceOf(ThrottledAccountQuotaProbe);
    // A missing MiMo console sign-in yields "no allowance data", never numbers.
    const snapshot = await probe!.probe({ signal: new AbortController().signal, force: true });
    expect(snapshot?.ok ?? false).toBe(false);
    expect(snapshot?.notApplicable).toBe(true);
    expect(snapshot?.windows ?? []).toEqual([]);
  });

  it('falls back to the usage monitor for an account when the native probe has no windows', async () => {
    const readProvider = vi.fn(async () => ({
      provider: 'claude' as const,
      takenAt: 1_700_000_000_000,
      source: 'inferred' as const,
      ok: true,
      windows: [{
        kind: 'rolling-window' as const,
        id: 'claude.weekly',
        label: 'Weekly (all models)',
        unit: 'messages' as const,
        used: 20,
        limit: 100,
        remaining: 80,
        resetsAt: null,
      }],
    }));
    const claude = buildAccountQuotaProbes(
      'claude',
      [profile('claude', 'max-b')],
      { readProvider },
    );
    const snap = await claude[0]!.probe({ signal: new AbortController().signal, force: true });
    expect(readProvider).toHaveBeenCalledWith('claude', 'max-b');
    expect(snap!.windows[0].used).toBe(20);
    expect(snap!.accountProfileId).toBe('max-b');
  });
});

describe('ClaudeCredentialsReader for a profile config dir', () => {
  it('reads the profile keychain item and credentials file, never the default ones', async () => {
    const securityExec = vi.fn(async (_args: string[], _opts: { timeoutMs: number }) => ({ stdout: '', stderr: '', exitCode: 44 }));
    const readFile = vi.fn(async (_filePath: string): Promise<string> => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const reader = new ClaudeCredentialsReader({
      platform: 'darwin',
      configDir: '/home/example/.claude-work',
      securityExec,
      readFile,
    });
    expect(await reader.read()).toEqual({ credential: null, reason: 'not-found' });
    expect(securityExec.mock.calls[0]?.[0]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials-af7cd477', '-w']);
    expect(readFile).toHaveBeenCalledWith('/home/example/.claude-work/.credentials.json');
  });
});
