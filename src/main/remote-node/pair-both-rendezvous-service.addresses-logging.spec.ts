import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const logged = vi.hoisted(() => ({
  entries: [] as { level: string; message: string; data: unknown }[],
}));

vi.mock('../logging/logger', () => {
  const record = (level: string) => (message: string, ...rest: unknown[]) => {
    logged.entries.push({ level, message, data: rest });
  };
  return {
    getLogger: () => ({
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }),
  };
});

import { PairBothRendezvousService } from './pair-both-rendezvous-service';
import {
  createPairBothNonce,
  generatePairBothKeyMaterial,
  PAIR_BOTH_PROTOCOL_VERSION,
} from './pair-both-crypto';
import type { PairBothHello } from '../../shared/types/pair-both.types';

const SECRET_TOKEN = 'EXAMPLE_PAIRING_TOKEN_DO_NOT_LOG';

function messages(): string[] {
  return logged.entries.map((entry) => entry.message);
}

function makeServices(options: { workerTimeoutMs?: number } = {}): {
  coordinator: PairBothRendezvousService;
  worker: PairBothRendezvousService;
  configPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-both-addresses-'));
  const configPath = path.join(dir, 'worker-node.json');
  const coordinator = new PairBothRendezvousService({
    auth: {
      issuePairingCredential: vi.fn(() => ({
        token: SECRET_TOKEN,
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
    addressTimeoutMs: options.workerTimeoutMs ?? 200,
  });
  return { coordinator, worker, configPath };
}

describe('PairBothRendezvousService addresses and logging', () => {
  const services: PairBothRendezvousService[] = [];

  beforeEach(() => {
    logged.entries.length = 0;
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.shutdown()));
    services.length = 0;
  });

  it('lists every address in the offer, main one first, without duplicates and within the schema limit', async () => {
    const { coordinator } = makeServices();
    services.push(coordinator);
    const state = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });

    const candidate = coordinator.getLocalCandidate(state.sessionId, [
      'mac.tail1234.ts.net',
      '100.68.10.5',
      'fd7a:115c:a1e0::1234',
      '192.168.0.156',
      '100.68.10.5',
    ]);
    expect(candidate.host).toBe('mac.tail1234.ts.net');
    expect(candidate.addresses).toEqual([
      'mac.tail1234.ts.net',
      '100.68.10.5',
      'fd7a:115c:a1e0::1234',
      '192.168.0.156',
    ]);

    const many = Array.from({ length: 30 }, (_, i) => `192.168.1.${i + 1}`);
    expect(coordinator.getLocalCandidate(state.sessionId, many).addresses).toHaveLength(16);
    expect(() => coordinator.getLocalCandidate(state.sessionId, [])).toThrow(/at least one address/);
  });

  it('listens for IPv4 workers on the all-interfaces setting and sends the fallback addresses in the payload', async () => {
    const { coordinator, worker, configPath } = makeServices();
    services.push(coordinator, worker);
    const state = await coordinator.startCoordinatorPairing({
      host: '0.0.0.0',
      namespace: 'default',
      coordinatorUrl: 'ws://mac.tail1234.ts.net:4878',
      coordinatorUrls: ['ws://[fd7a:115c:a1e0::1234]:4878', 'ws://192.168.0.156:4878'],
    });
    const candidate = coordinator.getLocalCandidate(state.sessionId, ['127.0.0.1']);

    await worker.connectWorkerToCandidate(candidate);
    await worker.confirmWorkerCode();
    await coordinator.approveCoordinatorPairing(state.sessionId);
    await worker.waitForWorkerPairingResult();

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      coordinatorUrl: 'ws://mac.tail1234.ts.net:4878',
      coordinatorUrls: ['ws://[fd7a:115c:a1e0::1234]:4878', 'ws://192.168.0.156:4878'],
    });
    // The peer address is recorded as plain IPv4, never `::ffff:...`.
    const connected = logged.entries.find((entry) => entry.message.startsWith('Pair-both worker connected'));
    expect(JSON.stringify(connected?.data)).toContain('"remoteAddress":"127.0.0.1"');
    expect(JSON.stringify(logged.entries)).not.toContain('::ffff:');
  });

  it('tries each address in order and keeps the first that answers', async () => {
    const { coordinator, worker } = makeServices();
    services.push(coordinator, worker);
    const state = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const offer = coordinator.getLocalCandidate(state.sessionId, ['127.0.0.1']);
    // An address nothing answers on (TEST-NET-3) comes first.
    const candidate = { ...offer, host: '203.0.113.1', addresses: ['203.0.113.1', '127.0.0.1'] };

    const workerState = await worker.connectWorkerToCandidate(candidate);

    expect(workerState.status).toBe('confirming');
    const failed = logged.entries.filter((entry) => entry.message === 'Pair-both address did not answer');
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0].data)).toContain('203.0.113.1');
    const reached = logged.entries.find((entry) => entry.message === 'Pair-both reached the coordinator');
    expect(JSON.stringify(reached?.data)).toContain('"address":"127.0.0.1"');
  });

  it('says plainly when no address answers', async () => {
    const { worker } = makeServices({ workerTimeoutMs: 100 });
    services.push(worker);
    const keys = generatePairBothKeyMaterial();

    await expect(worker.connectWorkerToCandidate({
      id: 'pair-both:x',
      product: 'Harness',
      protocol: 'aio-worker-pair-v1',
      protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
      pairingSessionId: '00000000-0000-4000-8000-000000000000',
      friendlyName: 'James MacBook',
      namespace: 'default',
      port: 1,
      coordinatorPublicKey: keys.publicKey,
      expiresAt: Date.now() + 60_000,
      host: '127.0.0.1',
      addresses: ['127.0.0.1', '::1'],
    })).rejects.toThrow(/any of its addresses \(tried 2 of 2\)/);
    expect(messages()).toContain('Pair-both could not reach the coordinator');
  });

  it('logs a readable trail for a full pairing without the token, the code or any key', async () => {
    const { coordinator, worker } = makeServices();
    services.push(coordinator, worker);
    const state = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const candidate = coordinator.getLocalCandidate(state.sessionId, ['127.0.0.1']);
    const workerState = await worker.connectWorkerToCandidate(candidate);
    await worker.confirmWorkerCode();
    await coordinator.approveCoordinatorPairing(state.sessionId);
    await worker.waitForWorkerPairingResult();
    await vi.waitFor(() => {
      expect(coordinator.getCoordinatorState()?.status).toBe('completed');
    });
    await coordinator.shutdown();

    expect(messages()).toEqual(expect.arrayContaining([
      'Pair-both session started',
      'Pair-both offer ready',
      'Pair-both worker connected; waiting for the code to be confirmed',
      'Pair-both verification code is ready to compare on both screens',
      'Pair-both worker confirmed the code',
      'Pair-both approved on this computer',
      'Pair-both connection details sent to the worker',
      'Pair-both completed: the worker received its connection details',
      'Pair-both listener stopped',
      'Pair-both connection closed',
    ]));
    const everything = JSON.stringify(logged.entries);
    const compact = workerState.shortCode.replace(' ', '');
    expect(everything).not.toContain(SECRET_TOKEN);
    expect(everything).not.toContain(workerState.shortCode);
    expect(everything).not.toContain(`"${compact}"`);
    expect(everything).not.toContain(candidate.coordinatorPublicKey);
    expect(everything).not.toContain(workerState.workerHello.publicKey);
    expect(everything).not.toContain(workerState.workerHello.nonce);
    // A finished pairing keeps its status when the listener is stopped afterwards.
    expect(coordinator.getCoordinatorState()?.status).toBe('completed');
  });

  it('ends a session still waiting for a worker as cancelled when the user stops it', async () => {
    const { coordinator } = makeServices();
    services.push(coordinator);
    const state = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });

    await coordinator.shutdown();

    expect(coordinator.getCoordinatorState()).toMatchObject({
      sessionId: state.sessionId,
      status: 'cancelled',
      error: 'Pairing was cancelled',
    });
    const stopped = logged.entries.find((entry) => entry.message === 'Pair-both listener stopped');
    expect(JSON.stringify(stopped?.data)).toContain('stopped by the user');
    expect(JSON.stringify(stopped?.data)).toContain('"status":"cancelled"');
  });

  it('cancels the old session when a new one replaces it', async () => {
    const { coordinator } = makeServices();
    services.push(coordinator);
    const first = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const second = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    const replaced = logged.entries.find((entry) => entry.message === 'Pair-both listener stopped');
    expect(JSON.stringify(replaced?.data)).toContain(first.sessionId);
    expect(JSON.stringify(replaced?.data)).toContain('replaced by a new pairing session');
    expect(JSON.stringify(replaced?.data)).toContain('"status":"cancelled"');
  });

  it('logs expiry', async () => {
    const { coordinator } = makeServices();
    services.push(coordinator);
    const state = await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
      ttlMs: 1_000,
    });
    await vi.waitFor(() => {
      expect(coordinator.getCoordinatorState()?.status).toBe('expired');
      expect(messages()).toContain('Pair-both listener stopped');
    }, { timeout: 3_000 });

    const expired = logged.entries.find((entry) => entry.message === 'Pair-both listener stopped');
    expect(JSON.stringify(expired?.data)).toContain(state.sessionId);
    expect(JSON.stringify(expired?.data)).toContain('"reason":"expired"');
  });

  it('logs the rate limit once when it is reached, naming the address and not the hello contents', async () => {
    const { coordinator } = makeServices();
    services.push(coordinator);
    await coordinator.startCoordinatorPairing({
      host: '127.0.0.1',
      namespace: 'default',
      coordinatorUrl: 'ws://127.0.0.1:4878',
    });
    const seam = coordinator as unknown as {
      handleWorkerHello(socket: WebSocket, hello: PairBothHello, remoteAddress?: string): void;
    };
    const keys = generatePairBothKeyMaterial();
    const hello = (i: number): PairBothHello => ({
      protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
      role: 'worker',
      machineName: 'Untrusted Worker',
      nonce: createPairBothNonce(),
      publicKey: keys.publicKey,
      pairingSessionId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    });

    for (let i = 0; i < 6; i++) {
      try {
        seam.handleWorkerHello({} as WebSocket, hello(i), `192.168.1.${100 + i}`);
      } catch {
        // Expected: each wrong-session hello is refused.
      }
    }

    const limited = logged.entries.filter((entry) => entry.message.startsWith('Pair-both rate limit reached'));
    expect(limited).toHaveLength(1);
    expect(JSON.stringify(limited[0].data)).toContain('"lockedBy":"session"');
    expect(JSON.stringify(logged.entries)).not.toContain(keys.publicKey);
  });
});
