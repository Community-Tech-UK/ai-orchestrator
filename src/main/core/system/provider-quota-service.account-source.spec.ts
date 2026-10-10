import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';
import { ProviderQuotaService, type ProviderQuotaProbe } from './provider-quota-service';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const services: ProviderQuotaService[] = [];
afterEach(() => services.splice(0).forEach((service) => service._resetForTesting()));
function fixture() {
  const service = new ProviderQuotaService();
  services.push(service);
  return service;
}
const snapshot: ProviderQuotaSnapshot = { provider: 'opencode', takenAt: 1000, source: 'admin-api', ok: true,
  windows: [{ id: 'opencode.plan', label: 'Plan', kind: 'calendar-period', unit: 'tokens',
    used: 95, limit: 100, remaining: 5, resetsAt: null }] };
function probe(chromeProfile: string, run = async () => snapshot): ProviderQuotaProbe {
  return { provider: 'opencode', accountProfileId: 'a', quotaSource: chromeProfile, probe: run };
}
describe('account quota source replacement', () => {
  it('clears figures immediately when a Chrome association changes and never retains them on failure', async () => {
    const service = fixture();
    service.registerProbe(probe('Default'));
    await service.refresh('opencode', 'a');
    const pushed: ProviderQuotaSnapshot[] = [];
    service.on('quota-updated', (event) => pushed.push(event));
    service.replaceAccountProbes('opencode', [probe('Profile 1', async () => ({ ...snapshot, ok: false, windows: [] }))]);
    expect(service.getSnapshot('opencode', 'a')?.windows).toEqual([]);
    expect(pushed[0]).toMatchObject({ accountProfileId: 'a', notApplicable: true, windows: [] });
    await service.refresh('opencode', 'a');
    expect(service.getSnapshot('opencode', 'a')?.windows).toEqual([]);
  });
  it('does not suppress threshold alerts after changing to another Chrome account', async () => {
    const service = fixture();
    const warnings: number[] = [];
    service.on('quota-warning', (event) => warnings.push(event.threshold));
    service.registerProbe(probe('Default'));
    await service.refresh('opencode', 'a');
    expect(warnings.filter((threshold) => threshold === 90)).toHaveLength(1);
    service.replaceAccountProbes('opencode', [probe('Profile 1')]);
    await service.refresh('opencode', 'a');
    expect(warnings.filter((threshold) => threshold === 90)).toHaveLength(2);
  });

  it('retains current figures when only probe objects change for the same association', async () => {
    const service = fixture();
    service.registerProbe(probe('Default'));
    await service.refresh('opencode', 'a');
    service.replaceAccountProbes('opencode', [probe('Default')]);
    expect(service.getSnapshot('opencode', 'a')?.windows[0].used).toBe(95);
  });
  it('discards a late result after association replacement', async () => {
    const service = fixture();
    let finish!: (snapshot: ProviderQuotaSnapshot) => void;
    service.registerProbe(probe('Default', () => new Promise((resolve) => { finish = resolve; })));
    const pending = service.refresh('opencode', 'a');
    service.replaceAccountProbes('opencode', [probe('Profile 1')]);
    finish(snapshot);
    await pending;
    expect(service.getSnapshot('opencode', 'a')?.windows).toEqual([]);
  });
  it('clears removed MiMo accounts and rejects their pending results', async () => {
    const service = fixture();
    let finish!: (snapshot: ProviderQuotaSnapshot) => void;
    service.registerProbe(probe('Default', () => new Promise((resolve) => { finish = resolve; })));
    const pending = service.refresh('opencode', 'a');
    service.replaceAccountProbes('opencode', []);
    finish(snapshot);
    await pending;
    expect(service.getSnapshot('opencode', 'a')?.windows ?? []).toEqual([]);
  });
});
