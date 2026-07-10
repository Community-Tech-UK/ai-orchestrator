import { describe, expect, it, vi } from 'vitest';
import { PairBothSessionStore } from './pair-both-session-store';
import { generatePairBothKeyMaterial } from './pair-both-crypto';
import type { PairBothHello } from '../../shared/types/pair-both.types';

function workerHello(sessionId: string, publicKey: string): PairBothHello {
  return {
    protocolVersion: '1',
    role: 'worker',
    machineName: 'Noah PC',
    nonce: 'worker-nonce',
    publicKey,
    pairingSessionId: sessionId,
  };
}

describe('PairBothSessionStore', () => {
  it('does not issue a pairing payload before coordinator approval and worker confirmation', () => {
    const issuePairingCredential = vi.fn(() => ({
      token: 'one-time-pairing-token',
      createdAt: 1_000,
      expiresAt: 301_000,
    }));
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });
    const workerKeys = generatePairBothKeyMaterial();
    store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));

    expect(() => store.producePairingPayload(session.sessionId)).toThrow(/approval/i);
    expect(issuePairingCredential).not.toHaveBeenCalled();

    store.confirmWorkerCode(session.sessionId);
    expect(() => store.producePairingPayload(session.sessionId)).toThrow(/approval/i);
    expect(issuePairingCredential).not.toHaveBeenCalled();

    store.approveCoordinator(session.sessionId);
    const payload = store.producePairingPayload(session.sessionId);

    expect(issuePairingCredential).toHaveBeenCalledTimes(1);
    expect(payload.connectionConfig).toMatchObject({
      name: 'Noah PC',
      coordinatorUrl: 'ws://192.168.1.2:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    });
  });

  it('marks a pairing complete only after the worker acknowledges payload delivery', () => {
    const store = new PairBothSessionStore({
      auth: {
        issuePairingCredential: vi.fn(() => ({
          token: 'one-time-pairing-token',
          createdAt: 1_000,
          expiresAt: 301_000,
        })),
      },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });
    const workerKeys = generatePairBothKeyMaterial();
    store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));
    store.confirmWorkerCode(session.sessionId);
    store.approveCoordinator(session.sessionId);

    store.produceEncryptedPairingPayload(session.sessionId);

    expect(store.getState(session.sessionId)).toMatchObject({
      status: 'approved',
      payloadDelivered: false,
    });
    expect(store.markPayloadDelivered(session.sessionId)).toMatchObject({
      status: 'completed',
      payloadDelivered: true,
    });
  });

  it('revokes an issued credential when payload delivery fails before acknowledgement', () => {
    const revokePairingCredential = vi.fn(() => true);
    const store = new PairBothSessionStore({
      auth: {
        issuePairingCredential: vi.fn(() => ({
          token: 'one-time-pairing-token',
          createdAt: 1_000,
          expiresAt: 301_000,
        })),
        revokePairingCredential,
      },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });
    const workerKeys = generatePairBothKeyMaterial();
    store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));
    store.confirmWorkerCode(session.sessionId);
    store.approveCoordinator(session.sessionId);
    store.produceEncryptedPairingPayload(session.sessionId);

    const failed = store.abortPayloadDelivery(session.sessionId, 'socket closed');

    expect(revokePairingCredential).toHaveBeenCalledWith('one-time-pairing-token');
    expect(failed).toMatchObject({
      status: 'rejected',
      payloadDelivered: false,
      error: 'socket closed',
    });
  });

  it('rejects hello, confirm, and payload requests after session expiry', () => {
    let now = 1_000;
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => now,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
      ttlMs: 5_000,
    });
    now = 7_000;
    const workerKeys = generatePairBothKeyMaterial();

    expect(() => store.acceptWorkerHello(
      session.sessionId,
      workerHello(session.sessionId, workerKeys.publicKey),
    )).toThrow(/expired/i);
    expect(() => store.confirmWorkerCode(session.sessionId)).toThrow(/expired/i);
    expect(() => store.producePairingPayload(session.sessionId)).toThrow(/expired/i);
  });

  it('keeps discovery metadata free of credential-like fields', () => {
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });

    const metadata = store.getDiscoveryMetadata(session.sessionId);
    const json = JSON.stringify(metadata);

    expect(Object.keys(metadata).join(' ')).not.toMatch(/token|secret|credential|payload/i);
    expect(json).not.toContain('authToken');
    expect(json).not.toContain('recoveryToken');
    expect(json).not.toContain('transportToken');
  });

  it('does not leave a pending pairing credential when the coordinator rejects', () => {
    const issuePairingCredential = vi.fn();
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });
    const workerKeys = generatePairBothKeyMaterial();
    store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));

    store.rejectCoordinator(session.sessionId);

    expect(() => store.producePairingPayload(session.sessionId)).toThrow(/rejected/i);
    expect(issuePairingCredential).not.toHaveBeenCalled();
  });

  it('rate limits repeated worker hellos from the same remote address', () => {
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });
    const workerKeys = generatePairBothKeyMaterial();

    store.acceptWorkerHello(
      session.sessionId,
      workerHello(session.sessionId, workerKeys.publicKey),
      '192.168.1.44',
    );

    for (let i = 0; i < 5; i++) {
      const replacementKeys = generatePairBothKeyMaterial();
      expect(() => store.acceptWorkerHello(
        session.sessionId,
        workerHello(session.sessionId, replacementKeys.publicKey),
        '192.168.1.44',
      )).toThrow(/already has a worker/i);
    }

    const otherKeys = generatePairBothKeyMaterial();
    expect(() => store.acceptWorkerHello(
      session.sessionId,
      workerHello(session.sessionId, otherKeys.publicKey),
      '192.168.1.44',
    )).toThrow(/too many pairing attempts/i);
  });

  it('rate limits unknown-session worker hellos by remote address', () => {
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => 1_000,
    });
    const workerKeys = generatePairBothKeyMaterial();

    for (let i = 0; i < 5; i++) {
      expect(() => store.acceptWorkerHello(
        `missing-session-${i}`,
        workerHello(`missing-session-${i}`, workerKeys.publicKey),
        '192.168.1.55',
      )).toThrow(/not found/i);
    }

    expect(() => store.acceptWorkerHello(
      'missing-session-final',
      workerHello('missing-session-final', workerKeys.publicKey),
      '192.168.1.55',
    )).toThrow(/too many pairing attempts/i);
    expect(() => store.acceptWorkerHello(
      'missing-session-other-remote',
      workerHello('missing-session-other-remote', workerKeys.publicKey),
      '192.168.1.56',
    )).toThrow(/not found/i);
  });

  it('rate limits malformed attempts per pairing session across rotating addresses', () => {
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => 1_000,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });

    for (let i = 0; i < 5; i++) {
      store.registerMalformedRemoteAttempt(`192.168.1.${100 + i}`, session.sessionId);
    }

    expect(() => store.registerMalformedRemoteAttempt(
      '192.168.1.200',
      session.sessionId,
    )).toThrow(/too many pairing attempts/i);
  });

  it('counts every malformed public key attempt before repeating crypto work', () => {
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential: vi.fn() },
      now: () => 1_000,
    });
    const remoteAddress = '192.168.1.57';
    const begin = () => store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });

    for (let i = 0; i < 5; i++) {
      const session = begin();
      expect(() => store.acceptWorkerHello(
        session.sessionId,
        workerHello(session.sessionId, 'not-a-valid-x25519-key'),
        remoteAddress,
      )).toThrow();
      expect(store.getState(session.sessionId)?.workerHello).toBeUndefined();
    }

    const blockedSession = begin();
    expect(() => store.acceptWorkerHello(
      blockedSession.sessionId,
      workerHello(blockedSession.sessionId, 'not-a-valid-x25519-key'),
      remoteAddress,
    )).toThrow(/too many pairing attempts/i);
  });
});
