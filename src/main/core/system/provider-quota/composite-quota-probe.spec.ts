import { describe, it, expect } from 'vitest';
import { CompositeQuotaProbe } from './composite-quota-probe';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';

function win(used: number): ProviderQuotaWindow {
  return { kind: 'rolling-window', id: 'x.w', label: 'w', unit: 'requests', used, limit: 100, remaining: 100 - used, resetsAt: null };
}

function nativeProbe(snap: ProviderQuotaSnapshot | null, accountProfileId?: string): ProviderQuotaProbe {
  return { provider: 'codex', accountProfileId, probe: async () => snap };
}

function fallback(snap: ProviderQuotaSnapshot | null) {
  return { readProvider: async () => snap };
}

const signal = () => new AbortController().signal;

const OK_WITH_WINDOWS: ProviderQuotaSnapshot = {
  provider: 'codex', takenAt: 1, source: 'cli-result', ok: true, windows: [win(10)],
};
const OK_NO_WINDOWS: ProviderQuotaSnapshot = {
  provider: 'codex', takenAt: 1, source: 'cli-result', ok: true, windows: [],
};
const STATE_JSON: ProviderQuotaSnapshot = {
  provider: 'codex', takenAt: 2, source: 'inferred', ok: true, windows: [win(55)],
};

describe('CompositeQuotaProbe', () => {
  it('returns the native snapshot when it has windows (native wins)', async () => {
    const probe = new CompositeQuotaProbe(nativeProbe(OK_WITH_WINDOWS), fallback(STATE_JSON));
    const snap = await probe.probe({ signal: signal() });
    expect(snap).toBe(OK_WITH_WINDOWS);
  });

  it('falls back to state.json when native has no windows', async () => {
    const probe = new CompositeQuotaProbe(nativeProbe(OK_NO_WINDOWS), fallback(STATE_JSON));
    const snap = await probe.probe({ signal: signal() });
    expect(snap).toBe(STATE_JSON);
  });

  it('keeps the native snapshot when state.json is absent', async () => {
    const probe = new CompositeQuotaProbe(nativeProbe(OK_NO_WINDOWS), fallback(null));
    const snap = await probe.probe({ signal: signal() });
    expect(snap).toBe(OK_NO_WINDOWS);
  });

  it('uses state.json when the native probe errors out', async () => {
    const errored: ProviderQuotaSnapshot = { provider: 'codex', takenAt: 1, source: 'cli-result', ok: false, error: 'boom', windows: [] };
    const probe = new CompositeQuotaProbe(nativeProbe(errored), fallback(STATE_JSON));
    const snap = await probe.probe({ signal: signal() });
    expect(snap).toBe(STATE_JSON);
  });

  it('survives a throwing fallback source', async () => {
    const throwingSource = { readProvider: async () => { throw new Error('io'); } };
    const probe = new CompositeQuotaProbe(nativeProbe(OK_NO_WINDOWS), throwingSource);
    const snap = await probe.probe({ signal: signal() });
    expect(snap).toBe(OK_NO_WINDOWS);
  });

  it('propagates needsReauth onto state.json windows when native flags reauth', async () => {
    const nativeReauth: ProviderQuotaSnapshot = {
      provider: 'codex', takenAt: 1, source: 'admin-api', ok: false,
      error: 'token expired', needsReauth: true, windows: [],
    };
    const probe = new CompositeQuotaProbe(nativeProbe(nativeReauth), fallback(STATE_JSON));
    const snap = await probe.probe({ signal: signal() });
    expect(snap).not.toBe(STATE_JSON);
    expect(snap!.windows).toEqual(STATE_JSON.windows);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.error).toBe('token expired');
  });

  it('asks the monitor for the wrapped account profile, not the legacy provider key', async () => {
    const calls: Array<[string, string | null | undefined]> = [];
    const nativeReauth: ProviderQuotaSnapshot = {
      provider: 'claude', takenAt: 1, source: 'admin-api', ok: false,
      error: 'expired', needsReauth: true, windows: [],
    };
    const accountWindows: ProviderQuotaSnapshot = {
      provider: 'claude', takenAt: 2, source: 'inferred', ok: true, windows: [win(20)],
    };
    const probe = new CompositeQuotaProbe(
      { provider: 'claude', accountProfileId: 'max-b', probe: async () => nativeReauth },
      {
        readProvider: async (provider, accountProfileId) => {
          calls.push([provider, accountProfileId]);
          return accountWindows;
        },
      },
    );
    expect(probe.accountProfileId).toBe('max-b');
    const snap = await probe.probe({ signal: signal() });
    expect(calls).toEqual([['claude', 'max-b']]);
    expect(snap!.windows).toEqual(accountWindows.windows);
    expect(snap!.needsReauth).toBe(true);
    expect(snap!.accountProfileId).toBe('max-b');
  });

  it('inherits the wrapped probe provider id', () => {
    const probe = new CompositeQuotaProbe(nativeProbe(OK_NO_WINDOWS), fallback(null));
    expect(probe.provider).toBe('codex');
  });
});
