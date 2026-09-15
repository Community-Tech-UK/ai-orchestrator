import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderQuotaStore } from './provider-quota.store';
import { QuotaIpcService } from '../services/ipc/quota-ipc.service';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';

let pushed: ((data: unknown) => void) | null = null;

const ipc = {
  quotaGetAll: vi.fn(async () => ({ success: true, data: { snapshots: { claude: null, codex: null, gemini: null, antigravity: null, copilot: null, cursor: null, grok: null } } })),
  quotaRefreshAll: vi.fn(async () => ({ success: true, data: [] })),
  quotaSetPollInterval: vi.fn(async () => ({ success: true })),
  onQuotaUpdated: vi.fn((handler: (data: unknown) => void) => {
    pushed = handler;
    return () => undefined;
  }),
  onQuotaWarning: vi.fn(() => () => undefined),
  onQuotaPacingWarning: vi.fn(() => () => undefined),
  onQuotaExhausted: vi.fn(() => () => undefined),
};

function snapshot(overrides: Partial<ProviderQuotaSnapshot>): ProviderQuotaSnapshot {
  return { provider: 'claude', takenAt: 1, source: 'header', ok: true, windows: [], ...overrides };
}

beforeEach(() => {
  pushed = null;
  TestBed.configureTestingModule({ providers: [{ provide: QuotaIpcService, useValue: ipc }] });
});

describe('ProviderQuotaStore account snapshots', () => {
  it('keeps account snapshots apart from the provider-level snapshot', async () => {
    const store = TestBed.inject(ProviderQuotaStore);
    await store.initialize();
    pushed?.(snapshot({ plan: 'legacy' }));
    pushed?.(snapshot({ plan: 'max-b', accountProfileId: 'max-b' }));
    pushed?.(snapshot({ plan: 'max-b-newer', accountProfileId: 'max-b' }));
    expect(store.snapshots().claude?.plan).toBe('legacy');
    expect(store.accountSnapshots().map((entry) => entry.plan)).toEqual(['max-b-newer']);
  });

  it('treats a hotter pool account as the most constrained window', async () => {
    const store = TestBed.inject(ProviderQuotaStore);
    await store.initialize();
    const window = (used: number) => ({
      kind: 'rolling-window' as const,
      id: 'claude.weekly',
      label: 'Weekly',
      unit: 'percent' as const,
      used,
      limit: 100,
      remaining: 100 - used,
      resetsAt: null,
    });
    pushed?.(snapshot({ plan: 'legacy', windows: [window(10)] }));
    pushed?.(snapshot({ plan: 'max-b', accountProfileId: 'max-b', windows: [window(95)] }));
    expect(store.mostConstrainedWindow()).toMatchObject({
      provider: 'claude',
      accountProfileId: 'max-b',
      window: expect.objectContaining({ used: 95 }),
    });
  });
});
