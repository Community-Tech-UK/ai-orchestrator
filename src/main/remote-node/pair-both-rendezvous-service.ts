import * as os from 'node:os';
import type { AddressInfo } from 'node:net';
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

interface PairBothAuthPort {
  issuePairingCredential(options: { label?: string; ttlMs?: number }): RemotePairingCredential;
}

export interface PairBothRendezvousServiceOptions {
  auth: PairBothAuthPort;
  machineName?: string;
  workerConfigPath?: string;
  now?: () => number;
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

type PairBothWireMessage =
  | { type: 'worker.hello'; hello: PairBothHello }
  | { type: 'coordinator.hello'; hello: PairBothHello; shortCode: string }
  | { type: 'worker.confirmed'; sessionId: string }
  | { type: 'worker.confirmed.ack'; sessionId: string }
  | { type: 'pairing.payload'; sessionId: string; encryptedPayload: PairBothEncryptedPayload }
  | { type: 'error'; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class PairBothRendezvousService {
  private readonly store: PairBothSessionStore;
  private readonly machineName: string;
  private readonly workerConfigPath: string;
  private coordinatorServer: WebSocketServer | null = null;
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

  constructor(options: PairBothRendezvousServiceOptions) {
    this.machineName = options.machineName ?? os.hostname();
    this.workerConfigPath = options.workerConfigPath ?? DEFAULT_CONFIG_PATH;
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
    server.on('connection', (socket) => this.handleCoordinatorConnection(socket));

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
    this.workerCandidate = candidate;
    this.workerResult = null;
    this.workerResultDeferred = createDeferred<WorkerConfig>();
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
        this.workerResultDeferred?.reject(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.once('open', () => {
        sendMessage(socket, { type: 'worker.hello', hello: this.requireWorkerHello() });
      });
      socket.on('message', (data) => {
        try {
          const message = parseWireMessage(data);
          if (message.type === 'coordinator.hello') {
            const state = this.acceptCoordinatorHello(candidate, message);
            if (!settled) {
              settled = true;
              resolve(state);
            }
            return;
          }
          void this.handleWorkerMessage(message);
        } catch (error) {
          rejectIfPending(error);
        }
      });
      socket.once('error', rejectIfPending);
      socket.once('close', () => {
        if (!this.workerResult) {
          rejectIfPending(new Error('Pair-both worker socket closed before pairing completed'));
        }
      });
    });
  }

  async confirmWorkerCode(): Promise<void> {
    const socket = this.requireOpenWorkerSocket();
    const workerHello = this.requireWorkerHello();
    this.workerConfirmAck = createDeferred<void>();
    sendMessage(socket, {
      type: 'worker.confirmed',
      sessionId: workerHello.pairingSessionId,
    });
    return this.workerConfirmAck.promise;
  }

  async approveCoordinatorPairing(sessionId: string): Promise<PairBothSessionState> {
    this.coordinatorState = this.store.approveCoordinator(sessionId);
    const result = this.store.produceEncryptedPairingPayload(sessionId);
    const socket = this.requireOpenCoordinatorSocket();
    if (!result.encryptedPayload) {
      throw new Error('Encrypted pairing payload was not produced');
    }
    sendMessage(socket, {
      type: 'pairing.payload',
      sessionId,
      encryptedPayload: result.encryptedPayload,
    });
    this.coordinatorState = this.store.getState(sessionId) ?? this.coordinatorState;
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

  private handleCoordinatorConnection(socket: WebSocket): void {
    this.coordinatorSocket = socket;
    socket.on('message', (data) => {
      try {
        const message = parseWireMessage(data);
        if (message.type === 'worker.hello') {
          this.handleWorkerHello(socket, message.hello);
          return;
        }
        if (message.type === 'worker.confirmed') {
          this.coordinatorState = this.store.confirmWorkerCode(message.sessionId);
          sendMessage(socket, {
            type: 'worker.confirmed.ack',
            sessionId: message.sessionId,
          });
        }
      } catch (error) {
        sendMessage(socket, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Pair-both request failed',
        });
      }
    });
    socket.once('close', () => {
      if (this.coordinatorSocket === socket) {
        this.coordinatorSocket = null;
      }
    });
  }

  private handleWorkerHello(socket: WebSocket, hello: PairBothHello): void {
    this.coordinatorState = this.store.acceptWorkerHello(hello.pairingSessionId, hello);
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
      this.workerConfirmAck?.resolve();
      this.workerConfirmAck = null;
      return;
    }
    if (message.type === 'pairing.payload') {
      await this.applyEncryptedPayload(message.encryptedPayload);
      return;
    }
    if (message.type === 'error') {
      throw new Error(message.message);
    }
  }

  private async applyEncryptedPayload(payload: PairBothEncryptedPayload): Promise<void> {
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
    this.workerResultDeferred?.resolve(this.workerResult);
  }

  private requireOpenCoordinatorSocket(): WebSocket {
    const socket = this.coordinatorSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('No worker is connected for pair-both approval');
    }
    return socket;
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

  private async stopCoordinatorServer(): Promise<void> {
    const server = this.coordinatorServer;
    const socket = this.coordinatorSocket;
    this.coordinatorServer = null;
    this.coordinatorSocket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    if (!server) {
      return;
    }
    await closeServer(server);
  }

  private async closeWorkerSocket(): Promise<void> {
    const socket = this.workerSocket;
    this.workerSocket = null;
    this.workerCandidate = null;
    this.workerHello = null;
    this.workerKeyMaterial = null;
    this.workerTranscript = null;
    this.workerConfirmAck = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await closeSocket(socket);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function sendMessage(socket: WebSocket, message: PairBothWireMessage): void {
  socket.send(JSON.stringify(message));
}

function parseWireMessage(data: Buffer | ArrayBuffer | Buffer[]): PairBothWireMessage {
  const message = JSON.parse(data.toString()) as unknown;
  if (!message || typeof message !== 'object') {
    throw new Error('Pair-both message must be a JSON object');
  }
  const record = message as Record<string, unknown>;
  if (typeof record['type'] !== 'string') {
    throw new Error('Pair-both message is missing a type');
  }
  return record as PairBothWireMessage;
}

function waitForServerListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    socket.close();
  });
}
