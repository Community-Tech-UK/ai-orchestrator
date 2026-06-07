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
  getRemoteNodeConfig: () => ({}),
}));

import { NodeIdentityStore } from '../remote-node/node-identity-store';
import { _resetRemoteAuthServiceForTesting, RemoteAuthService } from './remote-auth';

describe('RemoteAuthService', () => {
  beforeEach(() => {
    settings.clear();
    settings.set('remoteNodesEnrollmentToken', 'legacy-pairing-token');
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

  it('issues a same-node recovery token when a node is paired', () => {
    const service = new RemoteAuthService();
    const pairing = service.issuePairingCredential({ label: 'recoverable-node' });

    const result = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: pairing.token,
    });

    expect(result.status).toBe('paired');
    if (result.status !== 'rejected') {
      expect(result.session.recoveryToken).toMatch(/^[0-9a-f]{64}$/);
    }

    const persisted = JSON.parse(settings.get('remoteNodesRegisteredNodes') as string) as Record<
      string,
      { recoveryToken?: string }
    >;
    expect(persisted['node-1'].recoveryToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates a stale session token when the same node presents its recovery token', () => {
    const service = new RemoteAuthService();
    const pairing = service.issuePairingCredential({ label: 'recoverable-node' });
    const paired = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: pairing.token,
    });

    expect(paired.status).toBe('paired');
    if (paired.status === 'rejected') {
      throw new Error('expected initial pairing to succeed');
    }

    const recovered = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: 'stale-session-token',
      recoveryToken: paired.session.recoveryToken,
    });

    expect(recovered.status).toBe('recovered');
    if (recovered.status !== 'rejected') {
      expect(recovered.session.token).not.toBe(paired.session.token);
      expect(recovered.session.recoveryToken).toBe(paired.session.recoveryToken);
      expect(service.validateSessionToken(recovered.session.token, 'node-1')).toBe(true);
      expect(service.validateSessionToken(paired.session.token, 'node-1')).toBe(false);
    }
  });

  it('rejects recovery tokens presented for a different node id', () => {
    const service = new RemoteAuthService();
    const pairing = service.issuePairingCredential({ label: 'recoverable-node' });
    const paired = service.authenticateRegistration({
      nodeId: 'node-1',
      nodeName: 'Worker',
      token: pairing.token,
    });

    expect(paired.status).toBe('paired');
    if (paired.status === 'rejected') {
      throw new Error('expected initial pairing to succeed');
    }

    const recovered = service.authenticateRegistration({
      nodeId: 'node-2',
      nodeName: 'Imposter',
      token: 'stale-session-token',
      recoveryToken: paired.session.recoveryToken,
    });

    expect(recovered).toEqual({
      status: 'rejected',
      reason: 'Recovery token belongs to node "node-1"',
    });
  });

  it('accepts a persisted manual pairing token as a one-time pairing credential', () => {
    const service = new RemoteAuthService();

    const result = service.authenticateRegistration({
      nodeId: 'node-2',
      nodeName: 'Manual Worker',
      token: 'legacy-pairing-token',
    });

    expect(result.status).toBe('paired');
    if (result.status !== 'rejected') {
      expect(service.validateSessionToken(result.session.token, 'node-2')).toBe(true);
      expect(result.session.pairingLabel).toBe('Manual pairing token');
    }
    expect(settings.get('remoteNodesEnrollmentToken')).toBe('');
  });

  it('lists and revokes pending one-time pairing credentials', () => {
    const service = new RemoteAuthService();
    const first = service.issuePairingCredential({ label: 'Laptop', ttlMs: 5 * 60_000 });
    const second = service.issuePairingCredential({ label: 'Desktop', ttlMs: 10 * 60_000 });

    expect(service.listPendingPairings()).toEqual([
      expect.objectContaining({ token: first.token, label: 'Laptop' }),
      expect.objectContaining({ token: second.token, label: 'Desktop' }),
    ]);

    expect(service.revokePairingCredential(first.token)).toBe(true);
    expect(service.listPendingPairings()).toEqual([
      expect.objectContaining({ token: second.token, label: 'Desktop' }),
    ]);
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
