import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';

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

function profile(provider: 'claude' | 'codex', id: string, enabled = true): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: id === 'legacy' ? 0 : 1, enabled, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
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
});

describe('ClaudeCredentialsReader for a profile config dir', () => {
  it('reads the profile keychain item and credentials file, never the default ones', async () => {
    const securityExec = vi.fn(async (_args: string[], _opts: { timeoutMs: number }) => ({ stdout: '', stderr: '', exitCode: 44 }));
    const readFile = vi.fn(async (_filePath: string): Promise<string> => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const reader = new ClaudeCredentialsReader({ platform: 'darwin', configDir: '/home/example/.claude-work', securityExec, readFile });
    expect(await reader.read()).toEqual({ credential: null, reason: 'not-found' });
    expect(securityExec.mock.calls[0]?.[0]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials-af7cd477', '-w']);
    expect(readFile).toHaveBeenCalledWith('/home/example/.claude-work/.credentials.json');
  });
});
