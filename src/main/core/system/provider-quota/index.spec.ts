import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderQuotaService } from '../provider-quota-service';
import { MimoSavedSessionStore, type MimoSavedCookie } from './mimo-saved-session-store';
import { registerDefaultQuotaProbes } from './index';
import { _resetAccountQuotaProbesForTesting } from '../../../providers/account-pool/account-quota-probes';

let service: ProviderQuotaService;
let store: MimoSavedSessionStore;
let directory: string;
let model = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
const monitor = vi.hoisted(() => ({ readProvider: vi.fn() }));
vi.mock('../provider-quota-service', async (original) => ({
  ...await original<typeof import('../provider-quota-service')>(), getProviderQuotaService: () => service,
}));
vi.mock('./mimo-saved-session-store', async (original) => ({
  ...await original<typeof import('./mimo-saved-session-store')>(), getMimoSavedSessionStore: () => store,
}));
vi.mock('./mimo-console-credentials-reader', async (original) => ({
  ...await original<typeof import('./mimo-console-credentials-reader')>(),
  MimoConsoleCredentialsReader: class {
    async read() { return { session: null, reason: 'not-found' }; }
    async readAccountSso() { return { cookieHeader: '' }; }
  },
}));
vi.mock('./usage-monitor-source', async (original) => ({
  ...await original<typeof import('./usage-monitor-source')>(), UsageMonitorSource: class { readProvider = monitor.readProvider; },
}));
vi.mock('../../../cli/cli-detection', () => ({ getCliDetectionService: () => ({ detectAll: async () => ({ detected: [{ name: 'opencode', installed: true }] }) }) }));
vi.mock('../../config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: { opencode: model } }) }) }));
vi.mock('../../../providers/account-pool/provider-account-store', () => ({ getProviderAccountStore: () => ({ listProfiles: () => [] }), onProviderAccountsChanged: () => () => { /* no subscriptions in this fixture */ } }));
const cookies: MimoSavedCookie[] = [
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', value: 'placeholder' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_slh', value: 'placeholder' },
  { domain: '.platform.xiaomimimo.com', name: 'api-platform_ph', value: 'placeholder' },
  { domain: '.xiaomimimo.com', name: 'userId', value: 'placeholder-user' },
];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mimo-quota-bootstrap-'));
  store = new MimoSavedSessionStore({ rootDir: directory, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`test-only:${text}`),
    decryptString: (data) => data.toString().slice('test-only:'.length),
  } });
  service = new ProviderQuotaService();
  model = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
  monitor.readProvider.mockReset().mockResolvedValue({
    provider: 'opencode', takenAt: 1, source: 'inferred', ok: true,
    windows: [{ kind: 'calendar-period', id: 'opencode.plan', label: 'Plan', unit: 'tokens', used: 99, limit: 100, remaining: 1, resetsAt: null }],
  });
});
afterEach(() => {
  service._resetForTesting();
  _resetAccountQuotaProbesForTesting();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('default MiMo quota registration', () => {
  it('does not replace a rejected saved login with another Chrome monitor account', async () => {
    store.save('legacy', cookies);
    vi.stubGlobal('fetch', async () => ({ status: 401, json: async () => ({ code: 401 }) }));
    registerDefaultQuotaProbes();
    expect(await service.refresh('opencode', null, { force: true })).toMatchObject({ needsReauth: true, windows: [] });
    expect(monitor.readProvider).not.toHaveBeenCalled();
  });

  it('invalidates legacy bars when the saved connection is replaced or disconnected', async () => {
    registerDefaultQuotaProbes();
    service.ingestFromAdapter('opencode', { provider: 'opencode', ok: true, windows: [{ kind: 'calendar-period', id: 'opencode.plan', label: 'Plan', unit: 'tokens', used: 99, limit: 100, remaining: 1, resetsAt: null }] });
    store.save('legacy', cookies);
    registerDefaultQuotaProbes();
    expect(service.getSnapshot('opencode')).toMatchObject({ notApplicable: true, windows: [] });
    vi.stubGlobal('fetch', async (url: string) => ({ status: 200, json: async () => url.includes('/usage')
      ? { data: { usage: { items: [{ name: 'plan_total_token', used: 25, limit: 100 }] } } } : { data: {} } }));
    expect((await service.refresh('opencode', null, { force: true }))?.windows[0]?.used).toBe(25);
    store.remove('legacy');
    registerDefaultQuotaProbes();
    expect(service.getSnapshot('opencode')).toMatchObject({ notApplicable: true, windows: [] });
  });

  it('keeps saved legacy usage hidden for other OpenCode models', async () => {
    store.save('legacy', cookies);
    model = 'opencode/other-model';
    registerDefaultQuotaProbes();
    expect(await service.refresh('opencode', null, { force: true })).toMatchObject({ notApplicable: true, windows: [] });
    expect(monitor.readProvider).not.toHaveBeenCalled();
  });
});
