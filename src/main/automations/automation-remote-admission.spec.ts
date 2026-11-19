import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
// The account rules read settings; their own spec covers them.
const preference = vi.hoisted(() => ({ on: false, elsewhere: false, elsewhereOnlyAvoiding: false, avoid: [] as string[] }));
vi.mock('./automation-computer-preference', () => ({
  automationPrefersOtherComputer: () => preference.on,
  // A computer can take the job only on an account it is signed in to; the never-use list rules that one out.
  automationRunsOnOtherComputer: (action: { forceNodeId?: string }, _defaults: unknown, accountPreferences?: { avoid: string[] }) =>
    Boolean(action.forceNodeId) || (preference.on && (preference.elsewhereOnlyAvoiding
      // The default account isn't signed in on the free computer; skipping it picks one that is.
      ? Boolean(accountPreferences?.avoid.length)
      : preference.elsewhere && !accountPreferences?.avoid.length)),
}));
vi.mock('./automation-account-rules', () => ({
  automationAccountPreferences: async () => (preference.avoid.length ? { avoid: preference.avoid, last: [] } : undefined),
}));

const databases: ReturnType<typeof defaultDriverFactory>[] = [];
const admissions: WorkAdmission[] = [];
afterEach(() => { preference.on = false; preference.elsewhere = false; preference.elsewhereOnlyAvoiding = false; preference.avoid = []; admissions.splice(0).forEach(admission => admission.dispose()); vi.restoreAllMocks(); WorkAdmission._resetForTesting(); databases.splice(0).forEach(db => db.close()); });

const rlmTemplate = useSqliteTemplate((db) => {
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
});
async function setup(level: 1 | 2, holdBeforeDispatch = false) {
  const admission = new WorkAdmission({ cpuCount: () => 1, loadAverage: () => [100, 100, 100] });
  admissions.push(admission);
  vi.spyOn(WorkAdmission, 'getInstance').mockReturnValue(admission);
  const db = rlmTemplate.open(); databases.push(db);
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

describe('asking for another computer', () => {
  it.each([[true, { preferOtherComputer: true }], [false, {}]])('when the setting says %s, the job starts with %j', async (on, expected) => {
    preference.on = on;
    const { runner, createInstance, create } = await setup(1);
    getWorkAdmission().setWorkloadLevel(3);
    const local = await create(false);
    await runner.fire(local.id, { trigger: 'scheduled', scheduledAt: 1000 });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));
    const config = (createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(config['preferOtherComputer']).toBe(on ? true : undefined);
    expect(config).toMatchObject(expected);
  });

  it('does not hold a job that a free computer can take because this Mac is busy', async () => {
    preference.on = true;
    preference.elsewhere = true;
    const { store, runner, createInstance, create } = await setup(1);
    const local = await create(false);
    expect(getWorkAdmission().check('automation-run')).toMatchObject({ allowed: false, reason: 'computer-busy' });
    store.decideAndInsertRun(local, 'scheduled', 1000, 1000, { admissionHeld: true });
    await runner.promotePendingIfAny();
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ preferOtherComputer: true, admittedAsOtherComputer: true }));
  });

  it('does not mark a job as admitted for another computer when it was going to run here', async () => {
    preference.on = true;
    const { runner, createInstance, create } = await setup(1);
    getWorkAdmission().setWorkloadLevel(3);
    const local = await create(false);
    await runner.fire(local.id, { trigger: 'scheduled', scheduledAt: 1000 });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));
    expect((createInstance.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('admittedAsOtherComputer');
  });

  it("holds a job whose own never-use list sends it back to this Mac while this Mac is busy", async () => {
    preference.on = true;
    preference.elsewhere = true;
    preference.avoid = ['signed-in-on-the-pc'];
    const { store, runner, createInstance, create } = await setup(1);
    const local = await create(false);
    store.decideAndInsertRun(local, 'scheduled', 1000, 1000, { admissionHeld: true });
    await runner.promotePendingIfAny();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('does not hold a job whose own never-use list moves it to an account signed in on a free computer', async () => {
    preference.on = true;
    preference.elsewhereOnlyAvoiding = true;
    preference.avoid = ['default-account'];
    const { store, runner, createInstance, create } = await setup(1);
    const local = await create(false);
    store.decideAndInsertRun(local, 'scheduled', 1000, 1000, { admissionHeld: true });
    await runner.promotePendingIfAny();
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ preferOtherComputer: true }));
  });

  it('starts such a job straight away on its first fire while this Mac is busy', async () => {
    preference.on = true;
    preference.elsewhereOnlyAvoiding = true;
    preference.avoid = ['default-account'];
    const { runner, createInstance, create } = await setup(1);
    const local = await create(false);
    await runner.fire(local.id, { trigger: 'scheduled', scheduledAt: 1000 });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ preferOtherComputer: true })));
  });

  it('holds a job that wakes an existing session while this Mac is busy, even when another computer is free', async () => {
    preference.on = true;
    preference.elsewhere = true;
    const { store, runner, createInstance, create } = await setup(1);
    const base = await create(false);
    const wake = await store.create({ name: 'Wake', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      destination: { kind: 'thread', instanceId: 'local-thread', reviveIfArchived: false },
      action: { prompt: 'Check work', workingDirectory: '/tmp' } }, 1000);
    expect(await runner.runsOnOtherComputer(base.action, base.destination.kind)).toBe(true);
    expect(await runner.runsOnOtherComputer(wake.action, wake.destination.kind)).toBe(false);
    expect(await runner.runsOnOtherComputer({ ...wake.action, forceNodeId: 'windows-pc' }, wake.destination.kind)).toBe(true);
    store.decideAndInsertRun(wake, 'scheduled', 1000, 1000, { admissionHeld: true });
    await runner.promotePendingIfAny();
    expect(store.listActiveRuns().find(run => run.automationId === wake.id)?.status).toBe('pending');
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('holds the first fire of a job that wakes an existing session while this Mac is busy', async () => {
    preference.on = true;
    preference.elsewhere = true;
    const { store, runner, create } = await setup(1);
    await create(false);
    const wake = await store.create({ name: 'Wake', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      destination: { kind: 'thread', instanceId: 'local-thread', reviveIfArchived: false },
      action: { prompt: 'Check work', workingDirectory: '/tmp' } }, 1000);
    const outcome = await runner.fire(wake.id, { trigger: 'scheduled', scheduledAt: 1000 });
    expect(outcome.status).toBe('queued');
  });

  it('still holds a job that asks but has nowhere to go while this Mac is busy', async () => {
    preference.on = true;
    const { store, runner, createInstance, create } = await setup(1);
    const local = await create(false);
    store.decideAndInsertRun(local, 'scheduled', 1000, 1000, { admissionHeld: true });
    await runner.promotePendingIfAny();
    expect(createInstance).not.toHaveBeenCalled();
  });
});
