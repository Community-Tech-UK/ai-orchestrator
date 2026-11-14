import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueCapabilityGap } from '@contracts/schemas/plan-queue';
import { coordinator, fake, repo, store, git, writeDoc } from './plan-queue-coordinator.test-helpers';
import { newPlanQueueItem } from './plan-queue-state';
import { launchCapabilityRun } from './plan-queue-capability-launch';
import { preflightResumedRun } from './plan-queue-run-preflight';
import type { CapabilityRepair } from './plan-queue-capability-store';

vi.mock('./plan-queue-run-preflight', async original => ({ ...await original<object>(), preflightResumedRun: vi.fn(async () => undefined) }));
vi.mock('./plan-queue-routing', async original => ({ ...await original<object>(), assertRoutingInstalled: vi.fn(async () => undefined) }));
vi.mock('./plan-queue-folder-checklists', async original => ({ ...await original<object>(), readSavedFolderChecklists: () => [] }));
vi.mock('./plan-queue-default-gates', async original => ({ ...await original<object>(),
  defaultRunConfigFor: vi.fn(async () => ({ ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: ['npm run plan-checks'], postMergeGate: ['npm run plan-post'] })) }));

let repair: CapabilityRepair;
beforeEach(() => {
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  vi.mocked(preflightResumedRun).mockImplementation(async () => undefined);
  const parent = fake.addParent(), document = writeDoc('docs/plans/origin_livetest.md', '# Original\n- [ ] Check\n');
  const config = { ...DEFAULT_PLAN_QUEUE_CONFIG.livetests, baseBranch: git(['branch', '--show-current']), capabilityRepairRepository: repo,
    verifierGates: ['npm run source-check'], routing: { workers: [{ provider: 'claude', accountProfileIds: ['allowed'] }], verifiers: [{ provider: 'codex' }] } };
  store.upsertRun({ id: 'source', parentInstanceId: parent.id, parentHistoryThreadId: null, kind: 'livetests', workspaceCwd: repo,
    status: 'running', config, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
  store.upsertItem(newPlanQueueItem('origin', 'source', document, 1, { state: 'parked' }));
  const gap: PlanQueueCapabilityGap = { capabilityKey: 'session-test', check: 'Owned session', requiredAction: 'Create an owned test session',
    platform: 'macos', provider: 'codex', classification: 'capability', attempts: [{ operation: 'Discover tools', observedAt: Date.now(), result: 'No owned-session creation.' }],
    alternative: 'Production sessions are outside scope.', expectedResult: 'Session responds and cleans up.', implementation: 'Add bounded test-owned create/stop controls.' };
  repair = store.capabilities.attach({ repository: repo, sourceRunId: 'source', itemId: 'origin', config, gap,
    accountRules: { never: [{ provider: 'codex', accountId: 'blocked' }], last: [] }, planDirectory: 'docs/plans', reportedBy: { instanceId: 'worker', role: 'worker', round: 0, at: Date.now() } });
});

describe('coordinator-owned capability run launch', () => {
  it('creates one persisted run/item with immutable routing, normal plan gates and stronger source gates', async () => {
    await launchCapabilityRun(coordinator, repair, () => true);
    const launched = store.capabilities.get(repair.id)!;
    const run = coordinator.getRun(launched.repairRunId!);
    expect(run).toMatchObject({ parentInstanceId: coordinator.getRun('source').parentInstanceId, kind: 'plans', workspaceCwd: repo,
      config: { capabilityRepairId: repair.id, capabilityRepairAccountRules: repair.accountRules, relaxSettings: false,
        routing: repair.config.routing, verifierGates: ['npm run plan-checks', 'npm run source-check'], postMergeGate: ['npm run plan-post', 'npx tsc --noEmit', 'npm run typecheck:spec'] } });
    expect(run.config.capabilityRepairRepository).toBeUndefined();
    expect(store.listItems(run.id)).toHaveLength(1);
    expect(store.listItems(run.id)[0]).toMatchObject({ sourceRef: repair.planPath, state: 'queued' });
    expect(preflightResumedRun).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ baseBranch: repair.config.baseBranch }) }), expect.any(Function));
    await launchCapabilityRun(coordinator, store.capabilities.get(repair.id)!, () => true);
    expect(store.listActiveRuns()).toHaveLength(2);
    expect(store.listItems(run.id)).toHaveLength(1);
  });

  it('keeps a stable launch intent when preflight fails and reuses it on retry', async () => {
    vi.mocked(preflightResumedRun).mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(launchCapabilityRun(coordinator, repair, () => true)).rejects.toThrow('Provider unavailable');
    const pending = store.capabilities.get(repair.id)!;
    expect(pending.repairRunId).toBeTruthy(); expect(store.getRun(pending.repairRunId!)).toBeNull();
    await launchCapabilityRun(coordinator, pending, () => true);
    expect(store.capabilities.get(repair.id)?.repairRunId).toBe(pending.repairRunId);
  });

  it.each(['paused', 'cancelled'] as const)('does not launch when the source becomes %s during preflight', async status => {
    vi.mocked(preflightResumedRun).mockImplementationOnce(async () => { store.upsertRun({ ...coordinator.getRun('source'), status }); });
    await launchCapabilityRun(coordinator, repair, () => true);
    expect(store.listActiveRuns().filter(run => run.id !== 'source')).toEqual([]);
  });

  it('does not start under the previous owner after a handover during preflight', async () => {
    const other = fake.addParent();
    vi.mocked(preflightResumedRun).mockImplementationOnce(async () => { store.setRunParent('source', other.id, null); });
    await expect(launchCapabilityRun(coordinator, repair, () => true)).rejects.toThrow(/owner changed/);
    expect(store.listActiveRuns()).toHaveLength(1);
  });

  it('rechecks that all source turns have stopped after the asynchronous preflight', async () => {
    vi.mocked(preflightResumedRun).mockImplementationOnce(async () => { coordinator.save({ ...coordinator.getItem('origin'), state: 'working' }); });
    await launchCapabilityRun(coordinator, repair, () => true);
    expect(store.listActiveRuns()).toHaveLength(1);
  });
});
