import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairBothRendezvousService } from './pair-both-rendezvous-service';

describe('PairBothRendezvousService', () => {
  const services: PairBothRendezvousService[] = [];

  afterEach(async () => {
    await Promise.all(services.map((service) => service.shutdown()));
    services.length = 0;
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
});
