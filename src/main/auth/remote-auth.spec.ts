import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => settings.get(key),
    set: (key: string, value: unknown) => {
      settings.set(key, value);
    },
  }),
}));

vi.mock('../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => ({
    authToken: 'legacy-pairing-token',
  }),
}));

import { NodeIdentityStore } from '../remote-node/node-identity-store';
import { _resetRemoteAuthServiceForTesting, RemoteAuthService } from './remote-auth';

describe('RemoteAuthService', () => {
  beforeEach(() => {
    settings.clear();
    _resetRemoteAuthServiceForTesting();
    NodeIdentityStore._resetForTesting();
  });

  it('exchanges a pairing token for a persisted session token', () => {
    const service = new RemoteAuthService();
    const pairing = service.issuePairingCredential({ label: 'test-node' });

    const result = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: pairing.token,
    });

    expect(result.status).toBe('paired');
    expect(service.validateSessionToken(result.status === 'rejected' ? undefined : result.session.token, 'node-1')).toBe(true);
    expect(settings.get('remoteNodesRegisteredNodes')).toEqual(expect.any(String));
  });

  it('accepts the legacy enrollment token for the initial pairing exchange', () => {
    const service = new RemoteAuthService();

    const result = service.authenticateRegistration({
      nodeId: 'node-2',
      nodeName: 'Legacy Worker',
      token: 'legacy-pairing-token',
    });

    expect(result.status).toBe('paired');
    if (result.status !== 'rejected') {
      expect(service.validateSessionToken(result.session.token, 'node-2')).toBe(true);
    }
  });

  it('rejects reusing a session token for a different node id', () => {
    const service = new RemoteAuthService();
    const first = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: 'legacy-pairing-token',
    });

    expect(first.status).toBe('paired');
    const token = first.status === 'rejected' ? '' : first.session.token;

    const second = service.authenticateRegistration({
      nodeId: 'node-2',
      nodeName: 'Imposter',
      token,
    });

    expect(second).toEqual({
      status: 'rejected',
      reason: 'Session token belongs to node "node-1"',
    });
  });
});
