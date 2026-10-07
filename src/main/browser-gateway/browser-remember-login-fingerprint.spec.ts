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
  loggedInMarkers: ['My Tenders', 'Current'],
};

function snapshot(text: string, textUnavailableReason?: string) {
  return vi.fn(async () => ({
    decision: 'allowed' as const,
    outcome: 'succeeded' as const,
    auditId: 'audit-1',
    data: {
      title: 'Portal',
      url: 'https://portal.example/home',
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
});
