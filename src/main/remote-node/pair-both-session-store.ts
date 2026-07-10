import { randomUUID } from 'node:crypto';
import type { RemotePairingCredential } from '../auth/remote-auth';
import {
  buildPairBothTranscript,
  createPairBothNonce,
  derivePairBothCodeForHellos,
  derivePairBothPayloadKeyForHellos,
  encryptPairBothPayload,
  generatePairBothKeyMaterial,
  hashPairBothTranscript,
  PAIR_BOTH_PROTOCOL,
  PAIR_BOTH_PROTOCOL_VERSION,
  type PairBothKeyMaterial,
} from './pair-both-crypto';
import type {
  PairBothConnectionConfig,
  PairBothDiscoveryMetadata,
  PairBothHello,
  PairBothPayloadResult,
  PairBothSessionState,
} from '../../shared/types/pair-both.types';

const DEFAULT_PAIR_BOTH_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CONCURRENT_INSTANCES = 10;
const MAX_FAILED_ATTEMPTS_PER_REMOTE = 5;
const FAILED_ATTEMPT_WINDOW_MS = 60_000;

interface PairBothAuthPort {
  issuePairingCredential(options: { label?: string; ttlMs?: number }): RemotePairingCredential;
  revokePairingCredential?(token: string): boolean;
}

interface PairBothSessionRecord extends PairBothSessionState {
  keyMaterial: PairBothKeyMaterial;
  pairingCredentialToken?: string;
}

interface FailedAttemptState {
  count: number;
  windowStartedAt: number;
}

export interface PairBothSessionStoreOptions {
  auth: PairBothAuthPort;
  now?: () => number;
}

export interface BeginPairBothCoordinatorSessionInput {
  machineName: string;
  namespace: string;
  listenerPort: number;
  coordinatorUrl: string;
  ttlMs?: number;
}

export class PairBothSessionStore {
  private readonly sessions = new Map<string, PairBothSessionRecord>();
  private readonly failedAttemptsByRemote = new Map<string, FailedAttemptState>();
  private readonly failedAttemptsBySession = new Map<string, FailedAttemptState>();
  private readonly now: () => number;

  constructor(private readonly options: PairBothSessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  beginCoordinatorSession(input: BeginPairBothCoordinatorSessionInput): PairBothSessionState {
    this.pruneExpired();
    const sessionId = randomUUID();
    const keyMaterial = generatePairBothKeyMaterial();
    const coordinatorHello: PairBothHello = {
      protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
      role: 'coordinator',
      machineName: input.machineName,
      nonce: createPairBothNonce(),
      publicKey: keyMaterial.publicKey,
      pairingSessionId: sessionId,
    };
    const record: PairBothSessionRecord = {
      sessionId,
      status: 'waiting',
      protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
      machineName: input.machineName,
      namespace: input.namespace,
      listenerPort: input.listenerPort,
      coordinatorUrl: input.coordinatorUrl,
      expiresAt: this.now() + Math.max(1_000, input.ttlMs ?? DEFAULT_PAIR_BOTH_TTL_MS),
      coordinatorHello,
      workerConfirmed: false,
      coordinatorApproved: false,
      payloadDelivered: false,
      keyMaterial,
    };
    this.sessions.set(sessionId, record);
    return this.toState(record);
  }

  acceptWorkerHello(
    sessionId: string,
    hello: PairBothHello,
    remoteAddress?: string,
  ): PairBothSessionState {
    this.pruneFailedRemoteAttempts();
    const rateLimitKey = remoteAddress?.trim() || undefined;
    this.assertAttemptAllowed(rateLimitKey, sessionId);
    try {
      const record = this.requireActive(sessionId);
      if (hello.pairingSessionId !== sessionId) {
        throw new Error('Worker hello does not match this pairing session');
      }
      if (hello.role !== 'worker') {
        throw new Error('Pair-both session expected a worker hello');
      }
      if (record.workerHello) {
        throw new Error('Pair-both session already has a worker hello');
      }

      const transcript = buildPairBothTranscript({
        protocolVersion: record.protocolVersion,
        pairingSessionId: record.sessionId,
        coordinator: record.coordinatorHello,
        worker: hello,
      });
      let shortCode: string;
      try {
        shortCode = derivePairBothCodeForHellos({
          privateKey: record.keyMaterial.privateKey,
          peerPublicKey: hello.publicKey,
          transcript,
        });
      } catch {
        throw new Error('Invalid worker public key');
      }
      record.workerHello = hello;
      record.shortCode = shortCode;
      record.status = 'confirming';
      this.clearFailedAttempts(rateLimitKey, sessionId);
      return this.toState(record);
    } catch (error) {
      this.recordFailedAttempt(rateLimitKey, sessionId);
      throw error;
    }
  }

  registerMalformedRemoteAttempt(remoteAddress?: string, sessionId?: string): void {
    this.pruneFailedRemoteAttempts();
    const rateLimitKey = remoteAddress?.trim() || undefined;
    const sessionLimitKey = sessionId?.trim() || undefined;
    this.assertAttemptAllowed(rateLimitKey, sessionLimitKey);
    this.recordFailedAttempt(rateLimitKey, sessionLimitKey);
  }

  confirmWorkerCode(sessionId: string): PairBothSessionState {
    const record = this.requireActive(sessionId);
    if (!record.workerHello || !record.shortCode) {
      throw new Error('Cannot confirm before worker hello');
    }
    record.workerConfirmed = true;
    if (record.coordinatorApproved) {
      record.status = 'approved';
    }
    return this.toState(record);
  }

  approveCoordinator(sessionId: string): PairBothSessionState {
    const record = this.requireActive(sessionId);
    if (!record.workerHello || !record.shortCode) {
      throw new Error('Cannot approve before worker hello');
    }
    record.coordinatorApproved = true;
    record.status = record.workerConfirmed ? 'approved' : 'confirming';
    return this.toState(record);
  }

  rejectCoordinator(sessionId: string): PairBothSessionState {
    const record = this.requireSession(sessionId);
    record.status = 'rejected';
    record.error = 'Coordinator rejected the pairing request';
    return this.toState(record);
  }

  cancel(sessionId: string): PairBothSessionState {
    const record = this.requireSession(sessionId);
    record.status = 'cancelled';
    record.error = 'Pairing was cancelled';
    return this.toState(record);
  }

  getState(sessionId: string): PairBothSessionState | null {
    const record = this.sessions.get(sessionId);
    return record ? this.toState(record) : null;
  }

  getDiscoveryMetadata(sessionId: string): PairBothDiscoveryMetadata {
    const record = this.requireActive(sessionId);
    return {
      product: 'Harness',
      protocol: PAIR_BOTH_PROTOCOL,
      protocolVersion: record.protocolVersion,
      pairingSessionId: record.sessionId,
      friendlyName: record.machineName,
      namespace: record.namespace,
      port: record.listenerPort,
      coordinatorPublicKey: record.coordinatorHello.publicKey,
      expiresAt: record.expiresAt,
    };
  }

  producePairingPayload(sessionId: string): PairBothPayloadResult {
    const record = this.requireActive(sessionId);
    if (record.status === 'rejected') {
      throw new Error('Cannot produce pairing payload for a rejected session');
    }
    if (!record.workerHello) {
      throw new Error('Cannot produce pairing payload before worker hello');
    }
    if (!record.workerConfirmed || !record.coordinatorApproved) {
      throw new Error('Cannot produce pairing payload before worker confirmation and coordinator approval');
    }
    if (record.payloadDelivered) {
      throw new Error('Pairing payload has already been delivered');
    }

    if (!record.pairingCredentialToken) {
      const ttlMs = Math.max(1_000, record.expiresAt - this.now());
      const credential = this.options.auth.issuePairingCredential({
        label: record.workerHello.machineName,
        ttlMs,
      });
      record.pairingCredentialToken = credential.token;
    }

    const connectionConfig: PairBothConnectionConfig = {
      name: record.workerHello.machineName,
      authToken: record.pairingCredentialToken,
      coordinatorUrl: record.coordinatorUrl,
      namespace: record.namespace,
      maxConcurrentInstances: DEFAULT_MAX_CONCURRENT_INSTANCES,
      workingDirectories: [],
    };

    return {
      sessionId,
      connectionConfig,
    };
  }

  markPayloadDelivered(sessionId: string): PairBothSessionState {
    const record = this.requireSession(sessionId);
    if (record.payloadDelivered && record.status === 'completed') {
      return this.toState(record);
    }
    if (
      record.status !== 'approved'
      || !record.pairingCredentialToken
      || !record.workerConfirmed
      || !record.coordinatorApproved
    ) {
      throw new Error('Cannot complete pairing before encrypted payload delivery');
    }
    record.payloadDelivered = true;
    record.status = 'completed';
    return this.toState(record);
  }

  abortPayloadDelivery(sessionId: string, reason: string): PairBothSessionState {
    const record = this.requireSession(sessionId);
    if (record.payloadDelivered || record.status === 'completed') {
      return this.toState(record);
    }
    if (record.pairingCredentialToken) {
      this.options.auth.revokePairingCredential?.(record.pairingCredentialToken);
      record.pairingCredentialToken = undefined;
    }
    record.status = 'rejected';
    record.error = reason;
    return this.toState(record);
  }

  expireSession(sessionId: string): PairBothSessionState {
    const record = this.requireSession(sessionId);
    if (
      record.status === 'completed'
      || record.status === 'rejected'
      || record.status === 'cancelled'
    ) {
      return this.toState(record);
    }
    if (record.pairingCredentialToken) {
      this.options.auth.revokePairingCredential?.(record.pairingCredentialToken);
      record.pairingCredentialToken = undefined;
    }
    record.status = 'expired';
    record.error = 'Pairing session expired';
    return this.toState(record);
  }

  produceEncryptedPairingPayload(sessionId: string): PairBothPayloadResult {
    const record = this.requireActive(sessionId);
    if (!record.workerHello) {
      throw new Error('Cannot produce pairing payload before worker hello');
    }

    const transcript = buildPairBothTranscript({
      protocolVersion: record.protocolVersion,
      pairingSessionId: record.sessionId,
      coordinator: record.coordinatorHello,
      worker: record.workerHello,
    });
    const sessionKey = derivePairBothPayloadKeyForHellos({
      privateKey: record.keyMaterial.privateKey,
      peerPublicKey: record.workerHello.publicKey,
      transcript,
    });
    const transcriptHash = hashPairBothTranscript(transcript);
    const result = this.producePairingPayload(sessionId);

    return {
      ...result,
      encryptedPayload: encryptPairBothPayload(
        result.connectionConfig,
        sessionKey,
        transcriptHash,
      ),
    };
  }

  private requireActive(sessionId: string): PairBothSessionRecord {
    const record = this.requireSession(sessionId);
    if (record.expiresAt <= this.now()) {
      record.status = 'expired';
      record.error = 'Pairing session expired';
      throw new Error('Pairing session expired');
    }
    if (record.status === 'cancelled') {
      throw new Error('Pairing session was cancelled');
    }
    if (record.status === 'rejected') {
      throw new Error('Pairing session was rejected');
    }
    return record;
  }

  private requireSession(sessionId: string): PairBothSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error('Pairing session not found');
    }
    return record;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const record of this.sessions.values()) {
      if (record.expiresAt <= now && record.status !== 'completed') {
        record.status = 'expired';
        record.error = 'Pairing session expired';
      }
    }
  }

  private assertAttemptAllowed(
    remoteAddress: string | undefined,
    sessionId: string | undefined,
  ): void {
    const remoteAttempts = remoteAddress
      ? this.currentFailedAttempts(this.failedAttemptsByRemote, remoteAddress)
      : 0;
    const sessionAttempts = sessionId
      ? this.currentFailedAttempts(this.failedAttemptsBySession, sessionId)
      : 0;
    if (
      remoteAttempts >= MAX_FAILED_ATTEMPTS_PER_REMOTE
      || sessionAttempts >= MAX_FAILED_ATTEMPTS_PER_REMOTE
    ) {
      throw new Error('Too many pairing attempts from this computer. Wait a moment and try QR or paste pairing again.');
    }
  }

  private recordFailedAttempt(
    remoteAddress: string | undefined,
    sessionId: string | undefined,
  ): void {
    if (remoteAddress) {
      this.incrementFailedAttempts(this.failedAttemptsByRemote, remoteAddress);
    }
    if (sessionId) {
      this.incrementFailedAttempts(this.failedAttemptsBySession, sessionId);
    }
  }

  private incrementFailedAttempts(
    attempts: Map<string, FailedAttemptState>,
    key: string,
  ): void {
    const current = attempts.get(key);
    const windowStartedAt = current && this.now() - current.windowStartedAt < FAILED_ATTEMPT_WINDOW_MS
      ? current.windowStartedAt
      : this.now();
    attempts.set(
      key,
      {
        count: windowStartedAt === current?.windowStartedAt ? current.count + 1 : 1,
        windowStartedAt,
      },
    );
  }

  private currentFailedAttempts(
    attempts: Map<string, FailedAttemptState>,
    key: string,
  ): number {
    const current = attempts.get(key);
    if (!current) {
      return 0;
    }
    if (this.now() - current.windowStartedAt >= FAILED_ATTEMPT_WINDOW_MS) {
      attempts.delete(key);
      return 0;
    }
    return current.count;
  }

  private pruneFailedRemoteAttempts(): void {
    const now = this.now();
    for (const attemptMap of [this.failedAttemptsByRemote, this.failedAttemptsBySession]) {
      for (const [key, attempts] of attemptMap) {
        if (now - attempts.windowStartedAt >= FAILED_ATTEMPT_WINDOW_MS) {
          attemptMap.delete(key);
        }
      }
    }
  }

  private clearFailedAttempts(
    remoteAddress: string | undefined,
    sessionId: string | undefined,
  ): void {
    if (remoteAddress) {
      this.failedAttemptsByRemote.delete(remoteAddress);
    }
    if (sessionId) {
      this.failedAttemptsBySession.delete(sessionId);
    }
  }

  private toState(record: PairBothSessionRecord): PairBothSessionState {
    return {
      sessionId: record.sessionId,
      status: record.status,
      protocolVersion: record.protocolVersion,
      machineName: record.machineName,
      namespace: record.namespace,
      listenerPort: record.listenerPort,
      coordinatorUrl: record.coordinatorUrl,
      expiresAt: record.expiresAt,
      coordinatorHello: record.coordinatorHello,
      ...(record.workerHello ? { workerHello: record.workerHello } : {}),
      ...(record.shortCode ? { shortCode: record.shortCode } : {}),
      workerConfirmed: record.workerConfirmed,
      coordinatorApproved: record.coordinatorApproved,
      payloadDelivered: record.payloadDelivered,
      ...(record.error ? { error: record.error } : {}),
    };
  }
}
