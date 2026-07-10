import * as os from 'node:os';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RemotePairingCredential } from '../auth/remote-auth';
import {
  buildPairBothTranscript,
  createPairBothNonce,
  decryptPairBothPayload,
  derivePairBothCodeForHellos,
  derivePairBothPayloadKeyForHellos,
  generatePairBothKeyMaterial,
  hashPairBothTranscript,
  PAIR_BOTH_PROTOCOL_VERSION,
  type PairBothKeyMaterial,
} from './pair-both-crypto';
import {
  parsePairBothWireMessage,
  type PairBothWireMessage,
} from './pair-both-wire-schema';
import {
  closeServer,
  closeSocket,
  createDeferred,
  isPairingRateLimitError,
  sendPairBothMessage as sendMessage,
  waitForServerListening,
  type Deferred,
} from './pair-both-rendezvous-helpers';
import { PairBothSessionStore } from './pair-both-session-store';
import {
  DEFAULT_CONFIG_PATH,
  type WorkerConfig,
} from '../../worker-agent/worker-config';
import {
  parsePairingConfigInput,
  writePairedWorkerConfig,
} from '../../worker-agent/cli/pairing-config';
import type {
  PairBothCandidate,
  PairBothEncryptedPayload,
  PairBothHello,
  PairBothSessionState,
  PairBothTranscript,
} from '../../shared/types/pair-both.types';

const PAIR_BOTH_WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const PAIR_BOTH_CONFIRM_TIMEOUT_MS = 15_000;
const PAIR_BOTH_WORKER_HANDSHAKE_TIMEOUT_MS = 15_000;
const PAIR_BOTH_WORKER_RESULT_TIMEOUT_MS = 5 * 60_000;

interface PairBothAuthPort {
  issuePairingCredential(options: { label?: string; ttlMs?: number }): RemotePairingCredential;
  revokePairingCredential?(token: string): boolean;
}

export interface PairBothRendezvousServiceOptions {
  auth: PairBothAuthPort;
  machineName?: string;
  workerConfigPath?: string;
  now?: () => number;
  workerHandshakeTimeoutMs?: number;
  workerResultTimeoutMs?: number;
}

export interface StartCoordinatorPairingInput {
  host: string;
  namespace: string;
  coordinatorUrl: string;
  ttlMs?: number;
}

export interface PairBothWorkerPairingState {
  sessionId: string;
  status: 'confirming';
  shortCode: string;
  candidate: PairBothCandidate;
  coordinatorHello: PairBothHello;
  workerHello: PairBothHello;
}

export class PairBothRendezvousService {
  private readonly store: PairBothSessionStore;
  private readonly machineName: string;
  private readonly workerConfigPath: string;
  private readonly now: () => number;
  private readonly workerHandshakeTimeoutMs: number;
  private readonly workerResultTimeoutMs: number;
  private coordinatorServer: WebSocketServer | null = null;
  private coordinatorExpiryTimer: NodeJS.Timeout | null = null;
  private coordinatorSocket: WebSocket | null = null;
  private coordinatorState: PairBothSessionState | null = null;
  private workerSocket: WebSocket | null = null;
  private workerCandidate: PairBothCandidate | null = null;
  private workerHello: PairBothHello | null = null;
  private workerKeyMaterial: PairBothKeyMaterial | null = null;
  private workerTranscript: PairBothTranscript | null = null;
  private workerResult: WorkerConfig | null = null;
  private workerResultDeferred: Deferred<WorkerConfig> | null = null;
  private workerConfirmAck: Deferred<void> | null = null;
  private workerConfirmationAcknowledged = false;
  private workerHandshakeTimer: NodeJS.Timeout | null = null;
  private workerResultTimer: NodeJS.Timeout | null = null;

  constructor(options: PairBothRendezvousServiceOptions) {
    this.machineName = options.machineName ?? os.hostname();
    this.workerConfigPath = options.workerConfigPath ?? DEFAULT_CONFIG_PATH;
    this.now = options.now ?? Date.now;
    this.workerHandshakeTimeoutMs = Math.max(
      1,
      options.workerHandshakeTimeoutMs ?? PAIR_BOTH_WORKER_HANDSHAKE_TIMEOUT_MS,
    );
    this.workerResultTimeoutMs = Math.max(
      1,
      options.workerResultTimeoutMs ?? PAIR_BOTH_WORKER_RESULT_TIMEOUT_MS,
    );
    this.store = new PairBothSessionStore({
      auth: options.auth,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async startCoordinatorPairing(
    input: StartCoordinatorPairingInput,
  ): Promise<PairBothSessionState> {
    await this.stopCoordinatorServer();
    const server = new WebSocketServer({
      host: input.host,
      port: 0,
      maxPayload: PAIR_BOTH_WS_MAX_PAYLOAD_BYTES,
    });
    await waitForServerListening(server);
    this.coordinatorServer = server;
    server.on('connection', (socket, request) => this.handleCoordinatorConnection(socket, request));

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Pair-both listener did not expose a TCP port');
    }

    this.coordinatorState = this.store.beginCoordinatorSession({
      machineName: this.machineName,
      namespace: input.namespace,
      listenerPort: (address as AddressInfo).port,
      coordinatorUrl: input.coordinatorUrl,
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    });
    const sessionId = this.coordinatorState.sessionId;
    this.coordinatorExpiryTimer = setTimeout(() => {
      if (this.coordinatorState?.sessionId !== sessionId) {
        return;
      }
      this.coordinatorState = this.store.expireSession(sessionId);
      void this.stopCoordinatorServer().catch(() => {
        if (this.coordinatorState?.sessionId === sessionId) {
          this.coordinatorState = {
            ...this.coordinatorState,
            error: 'Pairing session expired; listener cleanup failed',
          };
        }
      });
    }, Math.max(1, this.coordinatorState.expiresAt - this.now()));
    return this.coordinatorState;
  }

  getLocalCandidate(sessionId: string, host: string): PairBothCandidate {
    const metadata = this.store.getDiscoveryMetadata(sessionId);
    return {
      ...metadata,
      id: `pair-both:${sessionId}:${host}:${metadata.port}`,
      host,
      addresses: [host],
    };
  }

  getCoordinatorState(): PairBothSessionState | null {
    return this.coordinatorState;
  }

  async connectWorkerToCandidate(
    candidate: PairBothCandidate,
  ): Promise<PairBothWorkerPairingState> {
    await this.closeWorkerSocket();
    if (candidate.expiresAt <= this.now()) {
      throw new Error('Pair-both candidate has expired');
    }
    this.workerCandidate = candidate;
    this.workerResult = null;
    this.workerResultDeferred = createDeferred<WorkerConfig>();
    void this.workerResultDeferred.promise.catch(() => undefined);
    this.workerConfirmationAcknowledged = false;
    this.workerKeyMaterial = generatePairBothKeyMaterial();
    this.workerHello = {
      protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
      role: 'worker',
      machineName: this.machineName,
      nonce: createPairBothNonce(),
      publicKey: this.workerKeyMaterial.publicKey,
      pairingSessionId: candidate.pairingSessionId,
    };

    const socket = new WebSocket(
      `ws://${candidate.host}:${candidate.port}`,
      { maxPayload: PAIR_BOTH_WS_MAX_PAYLOAD_BYTES },
    );
    this.workerSocket = socket;

    return new Promise<PairBothWorkerPairingState>((resolve, reject) => {
      let settled = false;
      const rejectIfPending = (error: unknown): void => {
        this.clearWorkerHandshakeTimer();
        this.workerResultDeferred?.reject(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1008, 'Pairing protocol failed');
        }
      };

      const handshakeDelayMs = Math.max(
        1,
        Math.min(this.workerHandshakeTimeoutMs, candidate.expiresAt - this.now()),
      );
      this.workerHandshakeTimer = setTimeout(() => {
        rejectIfPending(new Error('Pair-both worker handshake timed out'));
      }, handshakeDelayMs);

      socket.once('open', () => {
        sendMessage(socket, { type: 'worker.hello', hello: this.requireWorkerHello() });
      });
      socket.on('message', (data) => {
        try {
          const message = parsePairBothWireMessage(data);
          if (message.type === 'coordinator.hello') {
            const state = this.acceptCoordinatorHello(candidate, message);
            this.clearWorkerHandshakeTimer();
            this.scheduleWorkerResultTimeout(candidate);
            if (!settled) {
              settled = true;
              resolve(state);
            }
            return;
          }
          void this.handleWorkerMessage(message).catch(rejectIfPending);
        } catch (error) {
          rejectIfPending(error);
        }
      });
      socket.once('error', rejectIfPending);
      socket.once('close', () => {
        this.clearWorkerHandshakeTimer();
        this.clearWorkerResultTimer();
        this.workerConfirmAck?.reject(
          new Error('Pair-both worker socket closed before confirmation was acknowledged'),
        );
        this.workerConfirmAck = null;
        if (!this.workerResult) {
          rejectIfPending(new Error('Pair-both worker socket closed before pairing completed'));
        }
      });
    });
  }

  async confirmWorkerCode(): Promise<void> {
    const socket = this.requireOpenWorkerSocket();
    const workerHello = this.requireWorkerHello();
    this.requireWorkerTranscript();
    if (this.workerConfirmationAcknowledged) {
      return;
    }
    if (this.workerConfirmAck) {
      return this.workerConfirmAck.promise;
    }
    this.workerConfirmAck = createDeferred<void>();
    sendMessage(socket, {
      type: 'worker.confirmed',
      sessionId: workerHello.pairingSessionId,
    });
    const pendingAck = this.workerConfirmAck;
    const timeout = setTimeout(() => {
      pendingAck.reject(new Error('Pair-both confirmation acknowledgement timed out'));
    }, PAIR_BOTH_CONFIRM_TIMEOUT_MS);
    return pendingAck.promise.finally(() => {
      clearTimeout(timeout);
      if (this.workerConfirmAck === pendingAck) {
        this.workerConfirmAck = null;
      }
    });
  }

  async approveCoordinatorPairing(sessionId: string): Promise<PairBothSessionState> {
    this.coordinatorState = this.store.approveCoordinator(sessionId);
    if (this.coordinatorState.workerConfirmed) {
      return this.deliverEncryptedPairingPayload(sessionId);
    }
    return this.coordinatorState;
  }

  rejectCoordinatorPairing(sessionId: string): PairBothSessionState {
    this.coordinatorState = this.store.rejectCoordinator(sessionId);
    if (this.coordinatorSocket?.readyState === WebSocket.OPEN) {
      sendMessage(this.coordinatorSocket, {
        type: 'error',
        message: 'Coordinator rejected the pairing request',
      });
    }
    return this.coordinatorState;
  }

  async waitForWorkerPairingResult(): Promise<WorkerConfig> {
    if (this.workerResult) {
      return this.workerResult;
    }
    if (!this.workerResultDeferred) {
      throw new Error('Worker pairing has not started');
    }
    return this.workerResultDeferred.promise;
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.stopCoordinatorServer(),
      this.closeWorkerSocket(),
    ]);
  }

  private handleCoordinatorConnection(socket: WebSocket, request?: IncomingMessage): void {
    const remoteAddress = request?.socket.remoteAddress;
    socket.on('message', (data) => {
      try {
        let message: PairBothWireMessage;
        try {
          message = parsePairBothWireMessage(data);
        } catch (error) {
          this.store.registerMalformedRemoteAttempt(
            remoteAddress,
            this.coordinatorState?.sessionId,
          );
          throw error;
        }
        if (message.type === 'worker.hello') {
          this.handleWorkerHello(socket, message.hello, remoteAddress);
          return;
        }
        if (message.type === 'worker.confirmed') {
          this.assertBoundCoordinatorSocket(socket, message.sessionId);
          this.coordinatorState = this.store.confirmWorkerCode(message.sessionId);
          sendMessage(socket, {
            type: 'worker.confirmed.ack',
            sessionId: message.sessionId,
          });
          if (this.coordinatorState.coordinatorApproved) {
            this.deliverEncryptedPairingPayload(message.sessionId, socket);
          }
          return;
        }
        if (message.type === 'pairing.payload.ack') {
          this.assertBoundCoordinatorSocket(socket, message.sessionId);
          this.coordinatorState = this.store.markPayloadDelivered(message.sessionId);
          void this.stopCoordinatorServer().catch(() => {
            if (this.coordinatorState?.sessionId === message.sessionId) {
              this.coordinatorState = {
                ...this.coordinatorState,
                error: 'Pairing completed; listener cleanup failed',
              };
            }
          });
        }
      } catch (error) {
        if (isPairingRateLimitError(error)) {
          socket.close(1008, 'Pairing rate limit exceeded');
          return;
        }
        sendMessage(socket, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Pair-both request failed',
        });
      }
    });
    socket.once('close', () => {
      if (this.coordinatorSocket === socket) {
        this.coordinatorSocket = null;
        if (
          this.coordinatorState?.status === 'approved'
          && !this.coordinatorState.payloadDelivered
        ) {
          this.coordinatorState = this.store.abortPayloadDelivery(
            this.coordinatorState.sessionId,
            'Pairing payload delivery failed before worker acknowledgement',
          );
        }
      }
    });
  }

  private handleWorkerHello(
    socket: WebSocket,
    hello: PairBothHello,
    remoteAddress?: string,
  ): void {
    if (this.coordinatorSocket && this.coordinatorSocket !== socket) {
      throw new Error('Pair-both session already has a worker connection');
    }
    const activeSessionId = this.coordinatorState?.sessionId;
    if (!activeSessionId) {
      throw new Error('Pair-both coordinator session is not active');
    }
    this.coordinatorState = this.store.acceptWorkerHello(
      activeSessionId,
      hello,
      remoteAddress,
    );
    this.coordinatorSocket = socket;
    sendMessage(socket, {
      type: 'coordinator.hello',
      hello: this.coordinatorState.coordinatorHello,
      shortCode: this.requireCoordinatorCode(),
    });
  }

  private acceptCoordinatorHello(
    candidate: PairBothCandidate,
    message: Extract<PairBothWireMessage, { type: 'coordinator.hello' }>,
  ): PairBothWorkerPairingState {
    if (message.hello.pairingSessionId !== candidate.pairingSessionId) {
      throw new Error('Coordinator hello does not match the selected pairing session');
    }
    if (message.hello.publicKey !== candidate.coordinatorPublicKey) {
      throw new Error('Coordinator public key does not match discovery metadata');
    }
    if (message.hello.protocolVersion !== candidate.protocolVersion) {
      throw new Error('Coordinator protocol version does not match discovery metadata');
    }

    const workerHello = this.requireWorkerHello();
    const keyMaterial = this.requireWorkerKeyMaterial();
    const transcript = buildPairBothTranscript({
      protocolVersion: message.hello.protocolVersion,
      pairingSessionId: candidate.pairingSessionId,
      coordinator: message.hello,
      worker: workerHello,
    });
    const shortCode = derivePairBothCodeForHellos({
      privateKey: keyMaterial.privateKey,
      peerPublicKey: message.hello.publicKey,
      transcript,
    });
    if (shortCode !== message.shortCode) {
      throw new Error('Pair-both verification code mismatch');
    }
    this.workerTranscript = transcript;
    return {
      sessionId: candidate.pairingSessionId,
      status: 'confirming',
      shortCode,
      candidate,
      coordinatorHello: message.hello,
      workerHello,
    };
  }

  private async handleWorkerMessage(message: PairBothWireMessage): Promise<void> {
    if (message.type === 'worker.confirmed.ack') {
      this.assertBoundWorkerSession(message.sessionId);
      if (!this.workerConfirmAck) {
        throw new Error('Pair-both confirmation acknowledgement was not requested');
      }
      this.workerConfirmationAcknowledged = true;
      this.workerConfirmAck.resolve();
      this.workerConfirmAck = null;
      return;
    }
    if (message.type === 'pairing.payload') {
      this.assertBoundWorkerSession(message.sessionId);
      if (!this.workerConfirmationAcknowledged) {
        throw new Error('Pair-both payload arrived before worker confirmation acknowledgement');
      }
      await this.applyEncryptedPayload(message.sessionId, message.encryptedPayload);
      return;
    }
    if (message.type === 'error') {
      throw new Error(message.message);
    }
  }

  private async applyEncryptedPayload(
    sessionId: string,
    payload: PairBothEncryptedPayload,
  ): Promise<void> {
    this.assertBoundWorkerSession(sessionId);
    if (!this.workerConfirmationAcknowledged) {
      throw new Error('Pair-both payload cannot be applied before worker confirmation');
    }
    const keyMaterial = this.requireWorkerKeyMaterial();
    const transcript = this.requireWorkerTranscript();
    const sessionKey = derivePairBothPayloadKeyForHellos({
      privateKey: keyMaterial.privateKey,
      peerPublicKey: transcript.coordinator.publicKey,
      transcript,
    });
    const decrypted = decryptPairBothPayload(
      payload,
      sessionKey,
      hashPairBothTranscript(transcript),
    );
    const parsed = parsePairingConfigInput(JSON.stringify(decrypted));
    this.workerResult = writePairedWorkerConfig(this.workerConfigPath, parsed);
    this.clearWorkerResultTimer();
    sendMessage(this.requireOpenWorkerSocket(), {
      type: 'pairing.payload.ack',
      sessionId,
    });
    this.workerResultDeferred?.resolve(this.workerResult);
  }

  private deliverEncryptedPairingPayload(
    sessionId: string,
    socket = this.requireOpenCoordinatorSocket(),
  ): PairBothSessionState {
    const result = this.store.produceEncryptedPairingPayload(sessionId);
    if (!result.encryptedPayload) {
      throw new Error('Encrypted pairing payload was not produced');
    }
    sendMessage(socket, {
      type: 'pairing.payload',
      sessionId,
      encryptedPayload: result.encryptedPayload,
    });
    const latest = this.store.getState(sessionId);
    if (!latest) {
      throw new Error('Pairing session disappeared after payload delivery');
    }
    this.coordinatorState = latest;
    return latest;
  }

  private requireOpenCoordinatorSocket(): WebSocket {
    const socket = this.coordinatorSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('No worker is connected for pair-both approval');
    }
    return socket;
  }

  private assertBoundCoordinatorSocket(socket: WebSocket, sessionId: string): void {
    if (
      this.coordinatorSocket !== socket
      || this.coordinatorState?.sessionId !== sessionId
      || this.coordinatorState.workerHello?.pairingSessionId !== sessionId
    ) {
      throw new Error('Pair-both message is not bound to the accepted worker session');
    }
  }

  private assertBoundWorkerSession(sessionId: string): void {
    if (
      this.workerCandidate?.pairingSessionId !== sessionId
      || this.workerHello?.pairingSessionId !== sessionId
      || this.workerTranscript?.pairingSessionId !== sessionId
    ) {
      throw new Error('Pair-both message is not bound to the selected worker session');
    }
  }

  private requireOpenWorkerSocket(): WebSocket {
    const socket = this.workerSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Worker is not connected to a coordinator pairing session');
    }
    return socket;
  }

  private requireCoordinatorCode(): string {
    if (!this.coordinatorState?.shortCode) {
      throw new Error('Pair-both verification code is not available');
    }
    return this.coordinatorState.shortCode;
  }

  private requireWorkerHello(): PairBothHello {
    if (!this.workerHello) {
      throw new Error('Worker pairing hello is not available');
    }
    return this.workerHello;
  }

  private requireWorkerKeyMaterial(): PairBothKeyMaterial {
    if (!this.workerKeyMaterial) {
      throw new Error('Worker pairing key material is not available');
    }
    return this.workerKeyMaterial;
  }

  private requireWorkerTranscript(): PairBothTranscript {
    if (!this.workerTranscript) {
      throw new Error('Worker pairing transcript is not available');
    }
    return this.workerTranscript;
  }

  private scheduleWorkerResultTimeout(candidate: PairBothCandidate): void {
    this.clearWorkerResultTimer();
    const delayMs = Math.max(
      1,
      Math.min(this.workerResultTimeoutMs, candidate.expiresAt - this.now()),
    );
    this.workerResultTimer = setTimeout(() => {
      const error = new Error(
        this.now() >= candidate.expiresAt
          ? 'Pair-both candidate expired before pairing completed'
          : 'Pair-both worker pairing result timed out',
      );
      this.workerResultDeferred?.reject(error);
      this.workerConfirmAck?.reject(error);
      this.workerConfirmAck = null;
      const socket = this.workerSocket;
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.close(1008, 'Pairing timed out');
      }
    }, delayMs);
  }

  private clearWorkerHandshakeTimer(): void {
    if (this.workerHandshakeTimer) {
      clearTimeout(this.workerHandshakeTimer);
      this.workerHandshakeTimer = null;
    }
  }

  private clearWorkerResultTimer(): void {
    if (this.workerResultTimer) {
      clearTimeout(this.workerResultTimer);
      this.workerResultTimer = null;
    }
  }

  private async stopCoordinatorServer(): Promise<void> {
    if (this.coordinatorExpiryTimer) {
      clearTimeout(this.coordinatorExpiryTimer);
      this.coordinatorExpiryTimer = null;
    }
    const server = this.coordinatorServer;
    const socket = this.coordinatorSocket;
    if (
      this.coordinatorState?.status === 'approved'
      && !this.coordinatorState.payloadDelivered
    ) {
      this.coordinatorState = this.store.abortPayloadDelivery(
        this.coordinatorState.sessionId,
        'Pairing stopped before worker acknowledged payload delivery',
      );
    }
    this.coordinatorServer = null;
    this.coordinatorSocket = null;
    if (server) {
      for (const client of server.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close();
        }
      }
    } else if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    if (!server) {
      return;
    }
    await closeServer(server);
  }

  private async closeWorkerSocket(): Promise<void> {
    this.clearWorkerHandshakeTimer();
    this.clearWorkerResultTimer();
    const socket = this.workerSocket;
    if (!this.workerResult) {
      this.workerResultDeferred?.reject(new Error('Pair-both worker pairing stopped'));
    }
    this.workerSocket = null;
    this.workerCandidate = null;
    this.workerHello = null;
    this.workerKeyMaterial = null;
    this.workerTranscript = null;
    this.workerConfirmAck = null;
    this.workerConfirmationAcknowledged = false;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await closeSocket(socket);
  }
}
