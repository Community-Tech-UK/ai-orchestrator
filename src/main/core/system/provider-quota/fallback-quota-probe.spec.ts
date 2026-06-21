import { describe, it, expect } from 'vitest';
import { FallbackQuotaProbe } from './fallback-quota-probe';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';

function win(): ProviderQuotaWindow {
  return {
    kind: 'calendar-period',
    id: 'codex.weekly',
    label: 'Weekly',
    unit: 'requests',
    used: 50,
    limit: 100,
    remaining: 50,
    resetsAt: null,
  };
}

function probe(snapshot: ProviderQuotaSnapshot | null): ProviderQuotaProbe {
  return {
    provider: 'codex',
    probe: async () => snapshot,
  };
}

const signal = () => new AbortController().signal;

describe('FallbackQuotaProbe', () => {
  it('returns the primary snapshot when it has percentage windows', async () => {
    const primary: ProviderQuotaSnapshot = {
      provider: 'codex',
      takenAt: 1,
      source: 'admin-api',
      ok: true,
      windows: [win()],
    };
    const fallback: ProviderQuotaSnapshot = {
      provider: 'codex',
      takenAt: 2,
      source: 'cli-result',
      ok: true,
      plan: 'chatgpt',
      windows: [],
    };

    const result = await new FallbackQuotaProbe(probe(primary), probe(fallback)).probe({ signal: signal() });

    expect(result).toBe(primary);
  });

  it('uses fallback login-state when primary has no windows', async () => {
    const primary: ProviderQuotaSnapshot = {
      provider: 'codex',
      takenAt: 1,
      source: 'admin-api',
      ok: false,
      error: 'no auth',
      windows: [],
    };
    const fallback: ProviderQuotaSnapshot = {
      provider: 'codex',
      takenAt: 2,
      source: 'cli-result',
      ok: true,
      plan: 'chatgpt',
      windows: [],
    };

    const result = await new FallbackQuotaProbe(probe(primary), probe(fallback)).probe({ signal: signal() });

    expect(result).toBe(fallback);
  });

  it('propagates primary needsReauth onto a signed-in fallback snapshot', async () => {
    const primary: ProviderQuotaSnapshot = {
      provider: 'antigravity', takenAt: 1, source: 'admin-api', ok: false,
      error: 'session expired and could not be refreshed', needsReauth: true, windows: [],
    };
    // Local login-state probe believes the user is signed in (no reauth flag).
    const fallback: ProviderQuotaSnapshot = {
      provider: 'antigravity', takenAt: 2, source: 'cli-result', ok: true, plan: 'personal', windows: [],
    };

    const result = await new FallbackQuotaProbe(probe(primary), probe(fallback)).probe({ signal: signal() });

    expect(result).not.toBe(fallback);
    expect(result!.ok).toBe(true);
    expect(result!.plan).toBe('personal');
    expect(result!.needsReauth).toBe(true);
  });
});
