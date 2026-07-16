import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PairBothRendezvousService } from './pair-both-rendezvous-service';
import {
  buildPairBothTranscript,
  createPairBothNonce,
  derivePairBothCodeForHellos,
  derivePairBothPayloadKeyForHellos,
  encryptPairBothPayload,
  generatePairBothKeyMaterial,
  hashPairBothTranscript,
  PAIR_BOTH_PROTOCOL_VERSION,
  type PairBothKeyMaterial,
} from './pair-both-crypto';
import type { PairBothWireMessage } from './pair-both-wire-schema';
import type {
  PairBothCandidate,
  PairBothHello,
  PairBothTranscript,
} from '../../shared/types/pair-both.types';

describe('PairBothRendezvousService', () => {
  const services: PairBothRendezvousService[] = [];
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(services.map((service) => service.shutdown()));
    await Promise.all(servers.map((server) => closeTestServer(server)));
    services.length = 0;
    servers.length = 0;
  });

  it('pairs over localhost and writes the canonical worker config without stale node credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-both-rendezvous-'));
    const configPath = path.join(dir, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({
      nodeId: 'existing-node',
      name: 'Old Worker',
      authToken: 'old-token',
      nodeToken: 'stale-node-token',
      recoveryToken: 'stale-recovery-token',
      namespace: 'old',
      maxConcurrentInstances: 1,
      workingDirectories: ['/old'],
      reconnectIntervalMs: 5000,
      heartbeatIntervalMs: 10000,
    }, null, 2));

    const coordinator = new PairBothRendezvousService({
      auth: {
        issuePairingCredential: vi.fn(() => ({
          token: 'one-time-token',
          createdAt: Date.now(),
          expiresAt: Date.now() + 300_000,
        })),
      },
      machineName: 'James MacBook',
    });
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
      workerConfigPath: configPath,
    });
    services.push(coordinator, worker);

    const coordinatorState = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const candidate = coordinator.getLocalCandidate(coordinatorState.sessionId, '127.0.0.1');
    const workerState = await worker.connectWorkerToCandidate(candidate);

    expect(workerState.shortCode).toMatch(/^\d{3} \d{3}$/);
    expect(coordinator.getCoordinatorState()?.shortCode).toBe(workerState.shortCode);

    await worker.confirmWorkerCode();
    await coordinator.approveCoordinatorPairing(coordinatorState.sessionId);
    await worker.waitForWorkerPairingResult();
    await vi.waitFor(() => {
      expect(coordinator.getCoordinatorState()).toMatchObject({
        status: 'completed',
        payloadDelivered: true,
      });
    });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      nodeId: 'existing-node',
      name: 'Noah PC',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://127.0.0.1:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    });
    expect(persisted).not.toHaveProperty('nodeToken');
    expect(persisted).not.toHaveProperty('recoveryToken');
  });

  it('allows coordinator approval before worker confirmation and releases payload after both confirm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-both-rendezvous-approval-first-'));
    const configPath = path.join(dir, 'worker-node.json');
    const issuePairingCredential = vi.fn(() => ({
      token: 'one-time-token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    }));
    const coordinator = new PairBothRendezvousService({
      auth: { issuePairingCredential },
      machineName: 'James MacBook',
    });
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
      workerConfigPath: configPath,
    });
    services.push(coordinator, worker);

    const coordinatorState = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const candidate = coordinator.getLocalCandidate(coordinatorState.sessionId, '127.0.0.1');
    await worker.connectWorkerToCandidate(candidate);

    const approved = await coordinator.approveCoordinatorPairing(coordinatorState.sessionId);
    expect(approved.coordinatorApproved).toBe(true);
    expect(approved.workerConfirmed).toBe(false);
    expect(approved.payloadDelivered).toBe(false);
    expect(issuePairingCredential).not.toHaveBeenCalled();

    const result = worker.waitForWorkerPairingResult();
    await worker.confirmWorkerCode();
    await result;

    expect(issuePairingCredential).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      name: 'Noah PC',
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
  });

  it('refuses an encrypted payload before worker confirmation is acknowledged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-both-rendezvous-unconfirmed-'));
    const configPath = path.join(dir, 'worker-node.json');
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
      workerConfigPath: configPath,
    });
    services.push(worker);
    const fixture = configureWorkerMessageFixture(worker);

    await expect(fixture.seam.handleWorkerMessage({
      type: 'pairing.payload',
      sessionId: fixture.sessionId,
      encryptedPayload: fixture.encryptedPayload,
    })).rejects.toThrow(/confirmation/i);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fixture.socket.send).not.toHaveBeenCalled();
  });

  it('rejects confirmation acknowledgements and payloads for another session', async () => {
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
    });
    services.push(worker);
    const fixture = configureWorkerMessageFixture(worker);
    const resolveAck = vi.fn();
    fixture.seam.workerConfirmAck = {
      promise: Promise.resolve(),
      resolve: resolveAck,
      reject: vi.fn(),
    };

    await expect(fixture.seam.handleWorkerMessage({
      type: 'worker.confirmed.ack',
      sessionId: '00000000-0000-4000-8000-000000000001',
    })).rejects.toThrow(/session/i);
    expect(resolveAck).not.toHaveBeenCalled();

    fixture.seam.workerConfirmationAcknowledged = true;
    await expect(fixture.seam.handleWorkerMessage({
      type: 'pairing.payload',
      sessionId: '00000000-0000-4000-8000-000000000002',
      encryptedPayload: fixture.encryptedPayload,
    })).rejects.toThrow(/session/i);
  });

  it('bounds the worker hello wait when a candidate accepts TCP but never responds', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await waitForTestServer(server);
    const coordinatorKeys = generatePairBothKeyMaterial();
    const candidate = makeCandidate(
      (server.address() as AddressInfo).port,
      coordinatorKeys.publicKey,
    );
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
      workerHandshakeTimeoutMs: 25,
    });
    services.push(worker);

    const outcome = await Promise.race([
      worker.connectWorkerToCandidate(candidate).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/timed out/i);
  });

  it('bounds the worker result wait after a valid coordinator hello', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await waitForTestServer(server);
    const coordinatorKeys = generatePairBothKeyMaterial();
    const candidate = makeCandidate(
      (server.address() as AddressInfo).port,
      coordinatorKeys.publicKey,
    );
    server.on('connection', (socket) => {
      socket.once('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Extract<
          PairBothWireMessage,
          { type: 'worker.hello' }
        >;
        const coordinatorHello: PairBothHello = {
          protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
          role: 'coordinator',
          machineName: 'James MacBook',
          nonce: createPairBothNonce(),
          publicKey: coordinatorKeys.publicKey,
          pairingSessionId: candidate.pairingSessionId,
        };
        const transcript = buildPairBothTranscript({
          protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
          pairingSessionId: candidate.pairingSessionId,
          coordinator: coordinatorHello,
          worker: message.hello,
        });
        socket.send(JSON.stringify({
          type: 'coordinator.hello',
          hello: coordinatorHello,
          shortCode: derivePairBothCodeForHellos({
            privateKey: coordinatorKeys.privateKey,
            peerPublicKey: message.hello.publicKey,
            transcript,
          }),
        }));
      });
    });
    const worker = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'Noah PC',
      workerHandshakeTimeoutMs: 1_000,
      workerResultTimeoutMs: 25,
    });
    services.push(worker);

    await worker.connectWorkerToCandidate(candidate);
    const outcome = await Promise.race([
      worker.waitForWorkerPairingResult().then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/timed out|expired/i);
  });

  it('charges wrong-session hellos to the active session across rotating addresses', async () => {
    const coordinator = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'James MacBook',
    });
    services.push(coordinator);
    await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const seam = coordinator as unknown as PairBothCoordinatorTestSeam;
    const workerKeys = generatePairBothKeyMaterial();

    for (let i = 0; i < 5; i++) {
      const wrongSessionId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      expect(() => seam.handleWorkerHello(
        {} as WebSocket,
        {
          protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
          role: 'worker',
          machineName: 'Untrusted Worker',
          nonce: createPairBothNonce(),
          publicKey: workerKeys.publicKey,
          pairingSessionId: wrongSessionId,
        },
        `192.168.1.${100 + i}`,
      )).toThrow(/session/i);
    }

    expect(() => seam.handleWorkerHello(
      {} as WebSocket,
      {
        protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
        role: 'worker',
        machineName: 'Untrusted Worker',
        nonce: createPairBothNonce(),
        publicKey: workerKeys.publicKey,
        pairingSessionId: '00000000-0000-4000-8000-000000000099',
      },
      '192.168.1.200',
    )).toThrow(/too many pairing attempts/i);
  });

  it('expires and closes an unused coordinator rendezvous listener', async () => {
    const coordinator = new PairBothRendezvousService({
      auth: { issuePairingCredential: vi.fn() },
      machineName: 'James MacBook',
    });
    services.push(coordinator);

    await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
      ttlMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(coordinator.getCoordinatorState()).toMatchObject({
      status: 'expired',
      error: 'Pairing session expired',
    });
  });
});

interface DeferredVoidTestSeam {
  promise: Promise<void>;
  resolve(value?: void): void;
  reject(error: unknown): void;
}

interface PairBothWorkerTestSeam {
  workerCandidate: PairBothCandidate | null;
  workerHello: PairBothHello | null;
  workerKeyMaterial: PairBothKeyMaterial | null;
  workerTranscript: PairBothTranscript | null;
  workerSocket: WebSocket | null;
  workerConfirmAck: DeferredVoidTestSeam | null;
  workerConfirmationAcknowledged: boolean;
  handleWorkerMessage(message: PairBothWireMessage): Promise<void>;
}

interface PairBothCoordinatorTestSeam {
  handleWorkerHello(socket: WebSocket, hello: PairBothHello, remoteAddress?: string): void;
}

function configureWorkerMessageFixture(service: PairBothRendezvousService): {
  seam: PairBothWorkerTestSeam;
  sessionId: string;
  encryptedPayload: Extract<PairBothWireMessage, { type: 'pairing.payload' }>['encryptedPayload'];
  socket: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    readyState: number;
  };
} {
  const sessionId = '00000000-0000-4000-8000-000000000000';
  const coordinatorKeys = generatePairBothKeyMaterial();
  const workerKeys = generatePairBothKeyMaterial();
  const coordinatorHello: PairBothHello = {
    protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
    role: 'coordinator',
    machineName: 'James MacBook',
    nonce: createPairBothNonce(),
    publicKey: coordinatorKeys.publicKey,
    pairingSessionId: sessionId,
  };
  const workerHello: PairBothHello = {
    protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
    role: 'worker',
    machineName: 'Noah PC',
    nonce: createPairBothNonce(),
    publicKey: workerKeys.publicKey,
    pairingSessionId: sessionId,
  };
  const transcript = buildPairBothTranscript({
    protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
    pairingSessionId: sessionId,
    coordinator: coordinatorHello,
    worker: workerHello,
  });
  const sessionKey = derivePairBothPayloadKeyForHellos({
    privateKey: workerKeys.privateKey,
    peerPublicKey: coordinatorHello.publicKey,
    transcript,
  });
  const encryptedPayload = encryptPairBothPayload({
    name: 'Noah PC',
    authToken: 'test-pairing-token',
    coordinatorUrl: 'ws://127.0.0.1:4878',
    namespace: 'default',
    maxConcurrentInstances: 10,
    workingDirectories: [],
  }, sessionKey, hashPairBothTranscript(transcript));
  let closeHandler: (() => void) | undefined;
  const socket = {
    send: vi.fn(),
    readyState: WebSocket.OPEN as number,
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
    }),
    close: vi.fn(() => {
      socket.readyState = WebSocket.CLOSED;
      closeHandler?.();
    }),
  };
  const seam = service as unknown as PairBothWorkerTestSeam;
  seam.workerCandidate = makeCandidate(49321, coordinatorKeys.publicKey, sessionId);
  seam.workerHello = workerHello;
  seam.workerKeyMaterial = workerKeys;
  seam.workerTranscript = transcript;
  seam.workerSocket = socket as unknown as WebSocket;
  seam.workerConfirmationAcknowledged = false;
  return { seam, sessionId, encryptedPayload, socket };
}

function makeCandidate(
  port: number,
  coordinatorPublicKey: string,
  pairingSessionId = '00000000-0000-4000-8000-000000000000',
): PairBothCandidate {
  return {
    id: `pair-both:${pairingSessionId}:127.0.0.1:${port}`,
    host: '127.0.0.1',
    addresses: ['127.0.0.1'],
    product: 'Harness',
    protocol: 'aio-worker-pair-v1',
    protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
    pairingSessionId,
    friendlyName: 'James MacBook',
    namespace: 'default',
    port,
    coordinatorPublicKey,
    expiresAt: Date.now() + 60_000,
  };
}

function waitForTestServer(server: WebSocketServer): Promise<void> {
  if (server.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeTestServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  if (!server.address()) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
