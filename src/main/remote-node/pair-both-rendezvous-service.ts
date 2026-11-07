import * as os from 'node:os';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { getLogger } from '../logging/logger';
import { stripIpv4MappedPrefix } from '../../shared/remote-node/host-address';
import {
  createPairBothNonce,
  generatePairBothKeyMaterial,
  PAIR_BOTH_PROTOCOL_VERSION,
  type PairBothKeyMaterial,
} from './pair-both-crypto';
import {
  parsePairBothWireMessage,
  type PairBothWireMessage,
} from './pair-both-wire-schema';
import {
  capForLog,
  closeServer,
  closeServerClients,
  closeSocket,
  createDeferred,
  isPairingRateLimitError,
  sendPairBothMessage as sendMessage,
  listenPairBothServer,
  type Deferred,
} from './pair-both-rendezvous-helpers';
import { PairBothSessionStore } from './pair-both-session-store';
import {
  MAX_CANDIDATE_ADDRESSES,
  PAIR_BOTH_ADDRESS_TIMEOUT_MS,
  PAIR_BOTH_CONFIRM_TIMEOUT_MS,
  PAIR_BOTH_WORKER_HANDSHAKE_TIMEOUT_MS,
  PAIR_BOTH_WORKER_RESULT_TIMEOUT_MS,
  PAIR_BOTH_WS_MAX_PAYLOAD_BYTES,
  type PairBothRendezvousServiceOptions,
  type PairBothWorkerPairingState,
  type StartCoordinatorPairingInput,
} from './pair-both-rendezvous.types';
import { pairBothLog } from './pair-both-logging';
import {
  decryptPairingPayload,
  dialPairBothCandidate,
  verifyCoordinatorHello,
} from './pair-both-worker-side';
import {
  DEFAULT_CONFIG_PATH,
  type WorkerConfig,
} from '../../worker-agent/worker-config';
import { writePairedWorkerConfig } from '../../worker-agent/cli/pairing-config';
import type {
  PairBothCandidate,
  PairBothEncryptedPayload,
  PairBothHello,
  PairBothSessionState,
  PairBothTranscript,
} from '../../shared/types/pair-both.types';

const logger = getLogger('PairBoth');

export class PairBothRendezvousService {
  private readonly store: PairBothSessionStore;
  private readonly machineName: string;
  private readonly workerConfigPath: string;
  private readonly beforeWorkerConfigWrite: () => Promise<unknown> | unknown;
  private readonly now: () => number;
  private readonly workerHandshakeTimeoutMs: number;
  private readonly workerResultTimeoutMs: number;
  private readonly addressTimeoutMs: number;
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
    this.beforeWorkerConfigWrite = options.beforeWorkerConfigWrite ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.workerHandshakeTimeoutMs = Math.max(
      1,
      options.workerHandshakeTimeoutMs ?? PAIR_BOTH_WORKER_HANDSHAKE_TIMEOUT_MS,
    );
    this.workerResultTimeoutMs = Math.max(
      1,
      options.workerResultTimeoutMs ?? PAIR_BOTH_WORKER_RESULT_TIMEOUT_MS,
    );
    this.addressTimeoutMs = Math.max(1, options.addressTimeoutMs ?? PAIR_BOTH_ADDRESS_TIMEOUT_MS);
    this.store = new PairBothSessionStore({
      auth: options.auth,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async startCoordinatorPairing(
    input: StartCoordinatorPairingInput,
  ): Promise<PairBothSessionState> {
    await this.stopCoordinatorServer('replaced by a new pairing session');
    const server = await listenPairBothServer(input.host, PAIR_BOTH_WS_MAX_PAYLOAD_BYTES);
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
      ...(input.coordinatorUrls?.length ? { coordinatorUrls: input.coordinatorUrls } : {}),
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    });
    const sessionId = this.coordinatorState.sessionId;
    pairBothLog.info('Pair-both session started', this.coordinatorState, {
      namespace: this.coordinatorState.namespace,
      machineName: capForLog(this.machineName),
      listenerPort: this.coordinatorState.listenerPort,
      listenerAddress: address.address,
      expiresAt: new Date(this.coordinatorState.expiresAt).toISOString(),
    });
    this.coordinatorExpiryTimer = setTimeout(() => {
      if (this.coordinatorState?.sessionId !== sessionId) {
        return;
      }
      this.coordinatorState = this.store.expireSession(sessionId);
      void this.stopCoordinatorServer('expired').catch(() => {
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

  /**
   * The offer for the other computer. `hosts` is every address this computer
   * answers on, best first; the first is the main one and the joining side
   * tries them all in order.
   */
  getLocalCandidate(sessionId: string, hosts: string[]): PairBothCandidate {
    const addresses = [...new Set(hosts)].slice(0, MAX_CANDIDATE_ADDRESSES);
    const host = addresses[0];
    if (!host) {
      throw new Error('Pair-both needs at least one address to offer');
    }
    const metadata = this.store.getDiscoveryMetadata(sessionId);
    pairBothLog.info('Pair-both offer ready', this.coordinatorState, { port: metadata.port, addresses });
    return {
      ...metadata,
      id: `pair-both:${sessionId}:${host}:${metadata.port}`,
      host,
      addresses,
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

    const socket = await dialPairBothCandidate(candidate, {
      maxPayload: PAIR_BOTH_WS_MAX_PAYLOAD_BYTES,
      perAddressTimeoutMs: this.addressTimeoutMs,
      now: this.now,
    }).catch((error: unknown) => {
      this.workerResultDeferred?.reject(error);
      throw error;
    });
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
        logger.warn('Pair-both worker handshake timed out', { sessionId: candidate.pairingSessionId });
        rejectIfPending(new Error('Pair-both worker handshake timed out'));
      }, handshakeDelayMs);

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
      socket.once('close', (code, reason) => {
        pairBothLog.closed('Pair-both worker socket closed', null, code, reason, {
          sessionId: candidate.pairingSessionId,
          paired: this.workerResult !== null,
        });
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
      // The socket is already open: the hello goes out as soon as handlers are in place.
      try {
        sendMessage(socket, { type: 'worker.hello', hello: this.requireWorkerHello() });
      } catch (error) {
        rejectIfPending(error);
      }
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
    sendMessage(socket, { type: 'worker.confirmed', sessionId: workerHello.pairingSessionId });
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
    pairBothLog.info('Pair-both approved on this computer', this.coordinatorState, {
      workerConfirmed: this.coordinatorState.workerConfirmed,
    });
    if (this.coordinatorState.workerConfirmed) {
      return this.deliverEncryptedPairingPayload(sessionId);
    }
    return this.coordinatorState;
  }

  rejectCoordinatorPairing(sessionId: string): PairBothSessionState {
    this.coordinatorState = this.store.rejectCoordinator(sessionId);
    pairBothLog.info('Pair-both rejected on this computer', this.coordinatorState);
    if (this.coordinatorSocket?.readyState === WebSocket.OPEN) {
      sendMessage(this.coordinatorSocket, { type: 'error', message: 'Coordinator rejected the pairing request' });
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
      this.stopCoordinatorServer('stopped by the user'),
      this.closeWorkerSocket(),
    ]);
  }

  private handleCoordinatorConnection(socket: WebSocket, request?: IncomingMessage): void {
    // A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`.
    const remoteAddress = request?.socket.remoteAddress
      ? stripIpv4MappedPrefix(request.socket.remoteAddress)
      : undefined;
    pairBothLog.info('Pair-both connection opened', this.coordinatorState, { remoteAddress });
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
          pairBothLog.info('Pair-both worker confirmed the code', this.coordinatorState, {
            coordinatorApproved: this.coordinatorState.coordinatorApproved,
          });
          sendMessage(socket, { type: 'worker.confirmed.ack', sessionId: message.sessionId });
          if (this.coordinatorState.coordinatorApproved) {
            this.deliverEncryptedPairingPayload(message.sessionId, socket);
          }
          return;
        }
        if (message.type === 'pairing.payload.ack') {
          this.assertBoundCoordinatorSocket(socket, message.sessionId);
          this.coordinatorState = this.store.markPayloadDelivered(message.sessionId);
          pairBothLog.info('Pair-both completed: the worker received its connection details', this.coordinatorState);
          void this.stopCoordinatorServer('pairing completed').catch(() => {
            if (this.coordinatorState?.sessionId === message.sessionId) {
              this.coordinatorState = {
                ...this.coordinatorState,
                error: 'Pairing completed; listener cleanup failed',
              };
            }
          });
        }
      } catch (error) {
        pairBothLog.warn('Pair-both request refused', this.coordinatorState, {
          remoteAddress,
          error: capForLog(error instanceof Error ? error.message : 'Pair-both request failed'),
        });
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
    socket.once('close', (code, reason) => {
      pairBothLog.closed('Pair-both connection closed', this.coordinatorState, code, reason, {
        remoteAddress,
        wasBoundWorker: this.coordinatorSocket === socket,
      });
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
    pairBothLog.info('Pair-both worker connected; waiting for the code to be confirmed', this.coordinatorState, {
      workerMachineName: capForLog(hello.machineName),
      remoteAddress,
    });
    sendMessage(socket, {
      type: 'coordinator.hello',
      hello: this.coordinatorState.coordinatorHello,
      shortCode: this.requireCoordinatorCode(),
    });
    // Never log the code itself.
    pairBothLog.info('Pair-both verification code is ready to compare on both screens', this.coordinatorState);
  }

  private acceptCoordinatorHello(
    candidate: PairBothCandidate,
    message: Extract<PairBothWireMessage, { type: 'coordinator.hello' }>,
  ): PairBothWorkerPairingState {
    const workerHello = this.requireWorkerHello();
    const { transcript, shortCode } = verifyCoordinatorHello(
      candidate,
      message,
      workerHello,
      this.requireWorkerKeyMaterial(),
    );
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
      logger.warn('Pair-both coordinator reported an error', { error: capForLog(message.message) });
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
    const parsed = decryptPairingPayload(
      payload,
      this.requireWorkerKeyMaterial(),
      this.requireWorkerTranscript(),
    );
    await this.beforeWorkerConfigWrite();
    this.workerResult = writePairedWorkerConfig(this.workerConfigPath, parsed);
    this.clearWorkerResultTimer();
    logger.info('Pair-both worker config written', { sessionId });
    sendMessage(this.requireOpenWorkerSocket(), { type: 'pairing.payload.ack', sessionId });
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
    pairBothLog.info('Pair-both connection details sent to the worker', latest);
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
      logger.warn('Pair-both worker side timed out', { sessionId: candidate.pairingSessionId, error: error.message });
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

  private async stopCoordinatorServer(reason: string): Promise<void> {
    if (this.coordinatorExpiryTimer) {
      clearTimeout(this.coordinatorExpiryTimer);
      this.coordinatorExpiryTimer = null;
    }
    const server = this.coordinatorServer;
    const socket = this.coordinatorSocket;
    if (this.coordinatorState?.status === 'approved' && !this.coordinatorState.payloadDelivered) {
      this.coordinatorState = this.store.abortPayloadDelivery(
        this.coordinatorState.sessionId,
        'Pairing stopped before worker acknowledged payload delivery',
      );
    }
    // A session still waiting for, or comparing codes with, a worker ends as
    // cancelled instead of keeping a status that says it is still open.
    if (this.coordinatorState?.status === 'waiting' || this.coordinatorState?.status === 'confirming') {
      this.coordinatorState = this.store.cancel(this.coordinatorState.sessionId);
    }
    this.coordinatorServer = null;
    this.coordinatorSocket = null;
    if (!server) {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      return;
    }
    pairBothLog.info('Pair-both listener stopped', this.coordinatorState, { reason });
    closeServerClients(server);
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
