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

  it('issues an enrollment credential that outlives the rendezvous window', () => {
    let now = 1_000;
    const issuePairingCredential = vi.fn(() => ({
      token: 'one-time-pairing-token',
      createdAt: now,
      expiresAt: now + 30 * 60_000,
    }));
    const store = new PairBothSessionStore({
      auth: { issuePairingCredential },
      now: () => now,
    });
    const session = store.beginCoordinatorSession({
      machineName: 'James MacBook',
      namespace: 'default',
      listenerPort: 49321,
      coordinatorUrl: 'ws://192.168.1.2:4878',
      ttlMs: 60_000,
    });
    const workerKeys = generatePairBothKeyMaterial();
    store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));
    store.confirmWorkerCode(session.sessionId);
    store.approveCoordinator(session.sessionId);
    // Approved with only 5 seconds of the rendezvous window left.
    now = 56_000;

    store.produceEncryptedPairingPayload(session.sessionId);

    expect(issuePairingCredential).toHaveBeenCalledWith({
      label: expect.any(String),
      ttlMs: 30 * 60_000,
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

  describe('enrollment credential cleanup', () => {
    // Walks a session to the point where the credential has been minted and
    // sent, but the worker has not yet acknowledged it.
    function mintCredential(now: () => number) {
      const revokePairingCredential = vi.fn(() => true);
      const store = new PairBothSessionStore({
        auth: {
          issuePairingCredential: vi.fn(() => ({
            token: 'enrollment-token',
            createdAt: 1_000,
            expiresAt: 1_000 + 30 * 60_000,
          })),
          revokePairingCredential,
        },
        now,
      });
      const session = store.beginCoordinatorSession({
        machineName: 'James MacBook',
        namespace: 'default',
        listenerPort: 49321,
        coordinatorUrl: 'ws://192.168.1.2:4878',
        ttlMs: 5_000,
      });
      const workerKeys = generatePairBothKeyMaterial();
      store.acceptWorkerHello(session.sessionId, workerHello(session.sessionId, workerKeys.publicKey));
      store.confirmWorkerCode(session.sessionId);
      store.approveCoordinator(session.sessionId);
      store.produceEncryptedPairingPayload(session.sessionId);
      return { store, sessionId: session.sessionId, revokePairingCredential };
    }

    it('revokes the unused credential when the session is cancelled', () => {
      const { store, sessionId, revokePairingCredential } = mintCredential(() => 1_000);

      store.cancel(sessionId);
      store.cancel(sessionId);

      expect(revokePairingCredential).toHaveBeenCalledOnce();
      expect(revokePairingCredential).toHaveBeenCalledWith('enrollment-token');
    });

    it('revokes the unused credential when the session is expired by its timer', () => {
      const { store, sessionId, revokePairingCredential } = mintCredential(() => 1_000);

      store.expireSession(sessionId);
      store.expireSession(sessionId);

      expect(revokePairingCredential).toHaveBeenCalledOnce();
      expect(revokePairingCredential).toHaveBeenCalledWith('enrollment-token');
    });

    it('revokes the unused credential when the coordinator rejects after minting', () => {
      const { store, sessionId, revokePairingCredential } = mintCredential(() => 1_000);

      store.rejectCoordinator(sessionId);
      store.rejectCoordinator(sessionId);

      expect(revokePairingCredential).toHaveBeenCalledOnce();
      expect(revokePairingCredential).toHaveBeenCalledWith('enrollment-token');
    });

    it('revokes the unused credential when a request finds the session expired', () => {
      let now = 1_000;
      const { store, sessionId, revokePairingCredential } = mintCredential(() => now);

      now = 7_000;
      expect(() => store.confirmWorkerCode(sessionId)).toThrow(/expired/i);
      expect(() => store.confirmWorkerCode(sessionId)).toThrow(/expired/i);

      expect(revokePairingCredential).toHaveBeenCalledOnce();
      expect(revokePairingCredential).toHaveBeenCalledWith('enrollment-token');
    });

    it('revokes the unused credential when starting a new session prunes the expired one', () => {
      let now = 1_000;
      const { store, revokePairingCredential } = mintCredential(() => now);

      now = 7_000;
      store.beginCoordinatorSession({
        machineName: 'James MacBook',
        namespace: 'default',
        listenerPort: 49322,
        coordinatorUrl: 'ws://192.168.1.2:4878',
      });

      expect(revokePairingCredential).toHaveBeenCalledOnce();
      expect(revokePairingCredential).toHaveBeenCalledWith('enrollment-token');
    });

    it('never revokes a credential the worker has already acknowledged', () => {
      let now = 1_000;
      const { store, sessionId, revokePairingCredential } = mintCredential(() => now);
      store.markPayloadDelivered(sessionId);

      store.cancel(sessionId);
      store.rejectCoordinator(sessionId);
      store.expireSession(sessionId);
      now = 7_000;
      store.beginCoordinatorSession({
        machineName: 'James MacBook',
        namespace: 'default',
        listenerPort: 49322,
        coordinatorUrl: 'ws://192.168.1.2:4878',
      });

      expect(revokePairingCredential).not.toHaveBeenCalled();
    });

    it('does not call revoke for sessions that never minted a credential', () => {
      const revokePairingCredential = vi.fn(() => true);
      const store = new PairBothSessionStore({
        auth: { issuePairingCredential: vi.fn(), revokePairingCredential },
        now: () => 1_000,
      });
      const session = store.beginCoordinatorSession({
        machineName: 'James MacBook',
        namespace: 'default',
        listenerPort: 49321,
        coordinatorUrl: 'ws://192.168.1.2:4878',
      });

      store.cancel(session.sessionId);
      store.rejectCoordinator(session.sessionId);
      store.expireSession(session.sessionId);

      expect(revokePairingCredential).not.toHaveBeenCalled();
    });
  });
});
