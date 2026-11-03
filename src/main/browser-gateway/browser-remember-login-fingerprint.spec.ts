import { beforeEach, describe, expect, it, vi } from 'vitest';

const remember = vi.hoisted(() => vi.fn(() => ({
  scope: 'scope-1',
  scopeKind: 'node' as const,
  origin: 'https://portal.example',
  relogin: undefined,
})));

vi.mock('./browser-unattended-services', () => ({
  getBrowserLoginRecipeStore: () => ({ remember, list: vi.fn(), forget: vi.fn() }),
  getBrowserCampaignService: () => { throw new Error('unused'); },
  getBrowserEscalationService: () => { throw new Error('unused'); },
}));

import { handleUnattendedRpcMethod } from './browser-unattended-rpc-operations';

const request = {
  profileId: 'profile-1',
  targetId: 'target-1',
  origin: 'https://portal.example',
  loginUrl: 'https://portal.example/login',
  portalPath: '/',
  loggedInMarkers: ['My Tenders', 'Current'],
};

function snapshot(text: string, textUnavailableReason?: string, url = 'https://portal.example/home') {
  return vi.fn(async () => ({
    decision: 'allowed' as const,
    outcome: 'succeeded' as const,
    auditId: 'audit-1',
    data: {
      title: 'Portal',
      url,
      text,
      ...(textUnavailableReason ? { textUnavailableReason } : {}),
    },
  }));
}

describe('browser.remember_login_fingerprint live-page marker check (LT-666)', () => {
  beforeEach(() => {
    remember.mockClear();
  });

  it('refuses markers that are not on the readable page and does not store them', async () => {
    const service = { snapshot: snapshot('Hello, James. Manage Your Details') };

    await expect(handleUnattendedRpcMethod('browser.remember_login_fingerprint', request, {
      instanceId: 'inst-1',
      service,
    })).rejects.toThrow(/not on the live page.*Log out/s);

    expect(remember).not.toHaveBeenCalled();
  });

  it('refuses an unreadable page instead of storing markers from it', async () => {
    const service = { snapshot: snapshot('', 'host_permission_denied') };

    await expect(handleUnattendedRpcMethod('browser.remember_login_fingerprint', request, {
      instanceId: 'inst-1',
      service,
    })).rejects.toThrow(/host_permission_denied/);

    expect(remember).not.toHaveBeenCalled();
  });

  it('stores markers that are present on the live page', async () => {
    const service = { snapshot: snapshot('Hello, James. Log out') };
    const visible = { ...request, loggedInMarkers: ['James', 'Log out'] };

    await expect(handleUnattendedRpcMethod('browser.remember_login_fingerprint', visible, {
      instanceId: 'inst-1',
      service,
    })).resolves.toMatchObject({ remembered: true, scope: 'scope-1' });

    expect(remember).toHaveBeenCalledWith(expect.objectContaining({
      loggedInMarkers: ['James', 'Log out'],
    }));
  });

  it.each(['https://other.example/home', 'https://portal.example/cpcatapult/home'])(
    'refuses recording another portal or origin using the visible markers on %s', async (url) => {
      await expect(handleUnattendedRpcMethod('browser.remember_login_fingerprint', {
        ...request, portalPath: '/publicagroup', loginUrl: 'https://portal.example/publicagroup/home', loggedInMarkers: ['Logout'],
      }, { instanceId: 'inst-1', service: { snapshot: snapshot('Logout', undefined, url) } }))
        .rejects.toThrow(/another origin or portal/);
      expect(remember).not.toHaveBeenCalled();
    },
  );

  it('passes the observed portal path when recording a login recipe', async () => {
    await handleUnattendedRpcMethod('browser.remember_login_fingerprint', {
      ...request, loginUrl: 'https://portal.example/publicagroup/aspx/login',
      portalPath: '/publicagroup', loggedInMarkers: ['Logout'],
    }, { instanceId: 'inst-1', service: {
      snapshot: snapshot('Logout', undefined, 'https://portal.example/publicagroup/tenders/current'),
    } });
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ portalPath: '/publicagroup' }));
  });
});
