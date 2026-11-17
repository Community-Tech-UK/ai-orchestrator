/**
 * What the queue does with a session the provider check refused: the job is set aside for James with the refusal
 * sentence, and no failed round is counted. The refusal is raised by a stand-in instance port, so no session is created
 * and no Linear ticket is needed: `PlanQueueProviderNotAllowed` is the same error `spawnQueueInstance` throws for a
 * Linear run (proved in `plan-queue-linear-providers.spec.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanQueueProviderNotAllowed } from './plan-queue-linear-providers';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  coordinator, fake, planDoc, waitForRun, defineDefaultScripts, store,
  type FakeInstance,
} from './plan-queue-coordinator.test-helpers';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';

vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

const REFUSAL = 'Cursor is not allowed to see tickets from the COM team. Choose another provider, or allow this one for the COM team on the Plan Queue page.';

/** Refuses every session of one role, the way the real check would, and creates all others as usual. */
function refuseRole(role: string): void {
  const create = fake.createInstance.bind(fake);
  vi.spyOn(fake, 'createInstance').mockImplementation(async (config: InstanceCreateConfig) => {
    if (config.metadata?.['planQueueRole'] === role) throw new PlanQueueProviderNotAllowed(REFUSAL);
    return create(config);
  });
}

describe('a session refused for its provider', { timeout: 30_000 }, () => {
  void machineGates;
  // The helpers' own `beforeEach` creates the project folder first (it is registered when they are imported).
  beforeEach(() => defineDefaultScripts());

  it('sets a worker\'s job aside for James with the refusal and counts no round or failed try', async () => {
    planDoc('2026-01-01-alpha');
    refuseRole('worker');
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(fake.created.some((instance: FakeInstance) => instance.role === 'worker')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'needs-james', detail: expect.stringContaining(REFUSAL), round: 0, erroredRounds: 0 });
  });

  it('sets a checker\'s job aside for James with the refusal and counts no round or errored round', async () => {
    planDoc('2026-01-01-alpha');
    refuseRole('verifier');
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(fake.created.some((instance: FakeInstance) => instance.role === 'verifier')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'needs-james', detail: expect.stringContaining(REFUSAL), round: 0, erroredRounds: 0 });
  });
});
