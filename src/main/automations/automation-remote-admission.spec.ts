import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
// The account rules read settings; their own spec covers them.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));

const databases: ReturnType<typeof defaultDriverFactory>[] = [];
const admissions: WorkAdmission[] = [];
afterEach(() => { admissions.splice(0).forEach(admission => admission.dispose()); vi.restoreAllMocks(); WorkAdmission._resetForTesting(); databases.splice(0).forEach(db => db.close()); });

async function setup(level: 1 | 2, holdBeforeDispatch = false) {
  const admission = new WorkAdmission({ cpuCount: () => 1, loadAverage: () => [100, 100, 100] });
  admissions.push(admission);
  vi.spyOn(WorkAdmission, 'getInstance').mockReturnValue(admission);
  const db = defaultDriverFactory(':memory:'); databases.push(db);
  createTables(db); createMigrationsTable(db); runMigrations(db);
  const store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
  const createInstance = vi.fn(async () => ({ id: 'remote-instance', status: 'busy', outputBuffer: [] }));
  const manager = Object.assign(new EventEmitter(), { createInstance });
  const runner = new AutomationRunner(store, undefined, Date.now, undefined, undefined, undefined,
    undefined, () => false, async (_run, _store, dispatch) => {
      if (holdBeforeDispatch) getWorkAdmission().setGlobalPhase('holding');
      await dispatch();
    });
  runner.initialize(manager as unknown as InstanceManager);
  getWorkAdmission().setWorkloadLevel(level);
  const create = (remote: boolean) => store.create({ name: remote ? 'Remote' : 'Local', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    action: { prompt: 'Check work', workingDirectory: '/tmp', ...(remote ? { forceNodeId: 'windows-pc' } : {}) } }, 1000);
  return { store, runner, createInstance, create };
}

describe.each([1, 2] as const)('remote automation admission at workload %s', level => {
  it('promotes the remote pending candidate while local work remains blocked by local load', async () => {
    const { store, runner, createInstance, create } = await setup(level);
    const local = await create(false);
    const remote = await create(true);
    store.decideAndInsertRun(local, 'scheduled', 1000, 1000, { admissionHeld: true });
    store.decideAndInsertRun(remote, 'scheduled', 2000, 2000, { admissionHeld: true });
    expect(getWorkAdmission().getWorkloadLevel()).toBe(level);
    expect(getWorkAdmission().check('automation-run', { remote: false })).toMatchObject({ allowed: false, reason: 'computer-busy' });
    await runner.promotePendingIfAny();
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ forceNodeId: 'windows-pc' }));
    expect(store.listActiveRuns().find(run => run.automationId === local.id)?.status).toBe('pending');
  });

  it.each([false, true])('dispatches a remote retry despite local load, initially held: %s', async held => {
    const { store, runner, createInstance, create } = await setup(level);
    const remote = await create(true);
    const decision = store.decideAndInsertRun(remote, 'scheduled', 1000);
    if (decision.kind !== 'started') throw new Error('Fixture did not start a run');
    if (held) getWorkAdmission().setGlobalPhase('holding');
    await runner.dispatchRetryRun(decision.run);
    if (held) {
      expect(createInstance).not.toHaveBeenCalled();
      getWorkAdmission().setGlobalPhase('none');
    }
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ forceNodeId: 'windows-pc' })));
  });

  it('releases a remote first dispatch held during its network check despite local load', async () => {
    const { runner, createInstance, create } = await setup(level, true);
    const remote = await create(true);
    await runner.fire(remote.id, { trigger: 'scheduled', scheduledAt: 1000 });
    expect(createInstance).not.toHaveBeenCalled();
    getWorkAdmission().setGlobalPhase('none');
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ forceNodeId: 'windows-pc' })));
  });
});
