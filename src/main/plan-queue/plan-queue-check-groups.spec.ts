import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { gitExec } from '../workspace/git/git-exec';
import { PlanQueueCheckGroups } from './plan-queue-check-groups';
import { PlanQueueGateRunner, type GateInput } from './plan-queue-gate-receipts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { pumpPlanQueue } from './plan-queue-pump';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { limitsFor } from '../work-admission/workload-policy';
import { WorktreeCapacityError } from '../workspace/git/worktree-manager';

vi.mock('../workspace/git/git-exec', async original => ({ ...await original<typeof import('../workspace/git/git-exec')>(), gitExec: vi.fn() }));
vi.mock('./plan-queue-landing', () => ({ syncItemWithBase: vi.fn(async () => ({ status: 'up-to-date' })) }));
vi.mock('./plan-queue-orphan-checkout', () => ({ hasCheckout: vi.fn(async () => true) }));
vi.mock('./plan-queue-git', async original => ({ ...await original<typeof import('./plan-queue-git')>(),
  snapshotTree: vi.fn(async () => ({ head: 'head', status: [] })) }));
let root: string, db: SqliteDriver, store: PlanQueueStore, host: PlanQueueFlowHost;
let heads: Map<string, string>, waiting: Set<string>;
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'queue-batch-'));
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  heads = new Map(); waiting = new Set();
  vi.mocked(gitExec).mockImplementation(async (args, cwd) => args[0] === 'rev-parse'
    ? args[1].startsWith('refs/') ? 'base' : heads.get(cwd)! : 'mergeable');
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: ['check'], baseBranch: 'main' },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
  for (const [index, id] of ['leader', 'member'].entries()) {
    const documentPath = join(root, `${id}_plan.md`); writeFileSync(documentPath, '# Work');
    const cwd = join(root, id); heads.set(cwd, `${id}-head`);
    store.upsertItem(newPlanQueueItem(id, run.id, documentPath, index, { state: 'awaiting-slot', worktreePath: cwd,
      branchName: `queue/${id}`, checkpointCommit: `${id}-head` }));
  }
  host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save: (item: PlanQueueItem) => { store.upsertItem(item); return item; }, requestPump: vi.fn(),
    worktrees: { checkpoint: async (item: PlanQueueItem) => item,
      withBaseline: async (_repo: string, _base: string, action: (cwd: string) => Promise<unknown>) => action('/baseline'),
      withCombinedCopy: async (_repo: string, _base: string, members: { itemId: string; head: string }[], action: (copy: unknown) => Promise<unknown>) =>
        action({ cwd: '/combined', head: 'combined-head', testedTree: 'combined-tree', members }),
    },
  } as unknown as PlanQueueFlowHost;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); WorkAdmission._resetForTesting(); });
const item = (id: string) => host.getItem(id);
const run = () => host.getRun('run');
function setup(execute = vi.fn(async (_command: string, _cwd: string) => ({ exitCode: 0, output: '' }))) {
  const runner = new PlanQueueGateRunner(execute, cwd => cwd === '/combined' ? 'combined-tree' : 'solo-tree');
  const groups = new PlanQueueCheckGroups(host, runner, { lock: async (_id, action) => action(), waiting: id => waiting.has(id) });
  const input = (): GateInput => ({ cwd: item('leader').worktreePath!, head: 'leader-head', baseSha: 'base', scope: root,
    commands: ['check'], signal: groups.controllerFor('leader')?.signal,
    withBaseline: async action => action('/baseline') });
  return { runner, groups, execute, input };
}

describe('combined queue checks', () => {
  it.each([{ level: 5 as const, fails: false }, { level: 1 as const, fails: false }, { level: 5 as const, fails: true }])('uses the real pump and flow at workload $level, combined failure $fails', async ({ level, fails }) => {
    // The pending-member proof now asks Git for real object identities and a clean status.
    for (const [index, id] of ['leader', 'member'].entries()) {
      const head = String(index + 1).repeat(40); heads.set(item(id).worktreePath!, head);
      host.save({ ...item(id), checkpointCommit: head });
    }
    vi.mocked(gitExec).mockImplementation(async (args, cwd) => args[0] === 'rev-parse'
      ? args[1].startsWith('refs/') ? '3'.repeat(40) : heads.get(cwd)! : '');
    const seeded = vi.spyOn(PlanQueueGateRunner.prototype, 'seed');
    const admission = getWorkAdmission(); admission.setWorkloadLevel(level);
    vi.spyOn(admission, 'getLimits').mockImplementation(() => ({ ...limitsFor(level, 8), loadPerCore: null }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const executions: string[] = [];
    const original = PlanQueueGateRunner.prototype.executeCommands;
    vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands').mockImplementation(function (input) {
      return original.call(new PlanQueueGateRunner(async (_command, cwd) => {
        executions.push(cwd); await held; return { exitCode: fails && cwd === '/combined' ? 1 : 0,
          output: fails && cwd === '/combined' ? 'src/work.ts(1,1): error TS2322: New failure' : '' };
      }, () => '4'.repeat(40)), input);
    });
    const create = vi.fn(async () => ({ id: `checker-${create.mock.calls.length}` }));
    Object.assign(host, { checksAdmitted: () => true,
      transition: (value: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem>) => host.save({ ...value, ...patch, state }),
      instances: { getInstance: () => undefined, createInstance: create },
      selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
      liveParentId: () => 'parent', registerRole: vi.fn(), tracker: { track: vi.fn() },
    });
    const flow = new PlanQueueItemFlow(host);
    const pumpHost = { ...host, flow, triage: null, loadAverage: () => [0, 0, 0], followParent: (value: PlanQueueRun) => value,
      isShuttingDown: () => false, isControlling: () => false, resolveRunParent: () => 'parent', finishRun: vi.fn(),
      notifyParent: vi.fn(), logItemError: (_value: PlanQueueItem, error: unknown) => { throw error; }, announceRun: vi.fn() };
    try {
      await pumpPlanQueue(pumpHost);
      await vi.waitFor(() => expect(executions).toEqual(['/combined']));
      expect(store.listItems('run').map(value => value.state)).toEqual(['verifying', 'awaiting-slot']);
      expect(flow.checklistTurns.size).toBe(1);
      expect(create).not.toHaveBeenCalled();
      release(); await flow.whenSettled();
      if (level === 1 && !fails) host.save({ ...item('leader'), state: 'landed', verifierInstanceId: null,
        landedCommit: '5'.repeat(40), verdict: { verdict: 'PASS', findings: [], documentComplete: false, needJames: [],
          gatesRun: [...seeded.mock.calls.find(([input]) => input.cwd === item('leader').worktreePath)![1]] } });
      await pumpPlanQueue(pumpHost); await flow.whenSettled();
      expect(executions).toEqual(fails ? ['/combined', '/baseline', item('leader').worktreePath, item('member').worktreePath] : ['/combined']);
      expect(create).toHaveBeenCalledTimes(2);
      const events = host.history.listEvents('leader').filter(event => event.reason === 'checklist-run');
      expect(events).toHaveLength(fails ? 2 : 1);
      expect(host.history.checksSummary('run')).toEqual({ runs: fails ? 3 : 1, jobs: 2 });
    } finally { release(); flow.cancelChecks(); await flow.whenSettled(); }
  });

  it('claims waiting members synchronously, shares one run and seeds their own commit keys', async () => {
    const { groups, runner, execute, input } = setup();
    groups.reserve(item('leader'), run());
    expect(groups.isClaimed('member')).toBe(true);
    const receipts = await groups.run(item('leader'), run(), input());
    expect(receipts).toMatchObject([{ head: 'leader-head', testedTree: 'combined-tree', checkGroup: { memberItemIds: ['leader', 'member'] } }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runner.cached({ ...input(), cwd: item('member').worktreePath!, head: 'member-head' })).toMatchObject([{ head: 'member-head' }]);
    expect(groups.isClaimed('member')).toBe(false);
    expect(item('member').detail).toBeNull();
  });

  it.each(['folder', 'base', 'checklist', 'disabled', 'paused', 'usage', 'failed-head'])('does not take a member with incompatible %s', async difference => {
    const other = { ...run(), id: 'other', config: { ...run().config } };
    if (difference === 'folder') other.workspaceCwd += '/other';
    if (difference === 'base') other.config.baseBranch = 'other';
    if (difference === 'checklist') other.config.verifierGates = ['other'];
    if (difference === 'disabled') other.config.checkBatchSize = 1;
    if (difference === 'paused') other.status = 'paused';
    if (difference === 'usage') waiting.add('member');
    store.upsertRun(other);
    db.prepare('UPDATE plan_queue_items SET run_id = ? WHERE id = ?').run(other.id, 'member');
    if (difference === 'failed-head') host.history.recordEvent({ itemId: 'member', runId: other.id, fromState: 'awaiting-slot', toState: 'awaiting-slot',
      reason: 'check-group-failed', detailHead: JSON.stringify({ head: 'member-head' }), round: 0, tokens: 0 });
    const { groups, execute } = setup();
    groups.reserve(item('leader'), run());
    // There need not be an in-flight controller when synchronous eligibility excludes everyone.
    const signal = groups.controllerFor('leader')?.signal;
    expect(await groups.run(item('leader'), run(), { cwd: item('leader').worktreePath!, head: 'leader-head', baseSha: 'base', commands: ['check'], signal })).toBeUndefined();
    expect(execute).not.toHaveBeenCalled(); expect(groups.isClaimed('member')).toBe(false);
  });

  it('does not group when the leader opts out or a member already has current receipts', async () => {
    const { groups, runner } = setup();
    store.upsertRun({ ...run(), config: { ...run().config, checkBatchSize: 1 } });
    groups.reserve(item('leader'), run()); expect(groups.isClaimed('member')).toBe(false);
    store.upsertRun({ ...run(), config: { ...run().config, checkBatchSize: 4 } });
    await runner.run({ cwd: item('member').worktreePath!, head: 'member-head', baseSha: 'base', commands: ['check'] });
    groups.reserve(item('leader'), run());
    expect(await groups.run(item('leader'), run(), { cwd: item('leader').worktreePath!, head: 'leader-head', baseSha: 'base', commands: ['check'] })).toBeUndefined();
    expect(groups.isClaimed('member')).toBe(false);
  });

  it('re-runs nobody alone when a combined check runs out of time, and counts it for every member', async () => {
    const { groups, runner, execute, input } = setup(vi.fn(async () => ({ exitCode: 1, timedOut: true, output: '' })));
    groups.reserve(item('leader'), run());
    const receipts = await groups.run(item('leader'), run(), input());
    expect(receipts).toMatchObject([{ timedOut: true, head: 'leader-head' }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runner.cached(input())).toBeUndefined();
    for (const id of ['leader', 'member']) expect(host.history.hasFailedCheckGroup(id, `${id}-head`)).toBe(false);
    expect(host.history.listEvents('member').filter(event => event.reason === 'check-timeout')).toHaveLength(1);
    expect(host.history.listEvents('leader').filter(event => event.reason === 'check-timeout')).toHaveLength(0);
    expect(item('member').detail).toContain('did not finish in time');
    expect(groups.isClaimed('member')).toBe(false);
  });

  describe('the checklist turn', () => {
    function realFlow() {
      vi.mocked(gitExec).mockImplementation(async (args, cwd) => args[0] === 'rev-parse'
        ? args[1].startsWith('refs/') ? 'base' : heads.get(cwd)! : '');
      const turnsWhenCheckerStarted: number[] = [];
      const create = vi.fn(async () => { turnsWhenCheckerStarted.push(flow.checklistTurns.size); return { id: 'checker' }; });
      Object.assign(host, { checksAdmitted: () => true,
        transition: (value: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem>) => host.save({ ...value, ...patch, state }),
        instances: { getInstance: () => undefined, createInstance: create },
        selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
        liveParentId: () => 'parent', registerRole: vi.fn(), tracker: { track: vi.fn(), isShuttingDown: () => false },
      });
      store.upsertRun({ ...run(), config: { ...run().config, checkBatchSize: 1 } });
      const flow: PlanQueueItemFlow = new PlanQueueItemFlow(host);
      return { flow, turnsWhenCheckerStarted };
    }

    it('is held while commands run and given back before the checker reviews', async () => {
      const { flow, turnsWhenCheckerStarted } = realFlow();
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const original = PlanQueueGateRunner.prototype.executeCommands;
      vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands').mockImplementation(function (input) {
        return original.call(new PlanQueueGateRunner(async () => { await held; return { exitCode: 0, output: '' }; }, () => 'tree'), input);
      });
      const started = flow.startVerification(item('leader'));
      expect(flow.checklistTurns.has('leader')).toBe(true);
      vi.mocked(host.requestPump).mockClear();
      release();
      await started;
      expect(turnsWhenCheckerStarted).toEqual([0]);
      expect(item('leader').state).toBe('verifying');
      expect(host.requestPump).toHaveBeenCalled();
    });

    it('keeps the job waiting when checks cannot start, and tells the breaker', async () => {
      const { flow } = realFlow();
      const noted = vi.spyOn(flow.breaker, 'note');
      vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands').mockRejectedValue(new Error('/bin/sh: npm: command not found'));
      await flow.startVerification(item('leader'));
      expect(item('leader')).toMatchObject({ state: 'awaiting-slot', parkReason: null });
      expect(item('leader').detail).toContain('npm: command not found');
      expect(noted).toHaveBeenCalledWith('run', 'leader', '/bin/sh: npm: command not found');
      expect(flow.checklistTurns.size).toBe(0);
    });

    it('sets one job aside only after its checks repeatedly fail to start', async () => {
      const { flow } = realFlow();
      vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands').mockRejectedValue(new Error('checkout is broken'));
      for (let attempt = 1; attempt <= 3; attempt += 1) await flow.startVerification(item('leader'));
      expect(item('leader')).toMatchObject({ state: 'parked', parkReason: 'worktree-error' });
      expect(item('leader').detail).toContain('Could not run Harness checks: checkout is broken');
    });

    it('is given back when a Pause stops the commands', async () => {
      const { flow } = realFlow();
      let finish!: () => void;
      const running = new Promise<void>(resolve => { finish = resolve; });
      const original = PlanQueueGateRunner.prototype.executeCommands;
      vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands').mockImplementation(function (input) {
        return original.call(new PlanQueueGateRunner(async () => { await running; return { exitCode: 0, output: '' }; }, () => 'tree'), input);
      });
      const started = flow.startVerification(item('leader'));
      await vi.waitFor(() => expect(PlanQueueGateRunner.prototype.executeCommands).toHaveBeenCalled());
      flow.cancelChecks();
      finish();
      await started;
      expect(flow.checklistTurns.size).toBe(0);
    });

    it('is given back when the check stops early', async () => {
      const { flow } = realFlow();
      store.upsertRun({ ...run(), status: 'paused' });
      await flow.startVerification(item('leader'));
      expect(flow.checklistTurns.size).toBe(0);
    });

    it('is given back when the job cannot move to checking', () => {
      const { flow } = realFlow();
      Object.assign(host, { transition: () => { throw new Error('refused'); } });
      expect(() => flow.startVerification(item('leader'))).toThrow('refused');
      expect(flow.checklistTurns.size).toBe(0);
    });

    it('is not taken by a run with no checklist', async () => {
      const { flow } = realFlow();
      store.upsertRun({ ...run(), config: { ...run().config, verifierGates: [] } });
      const started = flow.startVerification(item('leader'));
      expect(flow.checklistTurns.size).toBe(0);
      await started;
    });
  });

  it('records failed commits and falls back without seeding any member', async () => {
    const { groups, runner, execute, input } = setup(vi.fn(async (_command, cwd) => ({ exitCode: cwd === '/combined' ? 1 : 0,
      output: cwd === '/combined' ? 'src/work.ts(1,1): error TS2322: New failure' : '' })));
    groups.reserve(item('leader'), run());
    expect(await groups.run(item('leader'), run(), input())).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2); // combined plus baseline; solo runs belong to normal preparation.
    expect(runner.cached(input())).toBeUndefined();
    for (const id of ['leader', 'member']) expect(host.history.hasFailedCheckGroup(id, `${id}-head`)).toBe(true);
    expect(item('member').detail).toContain('checking each job on its own');
    expect(groups.isClaimed('member')).toBe(false);
  });

  it('shares failures proven on the base only after the combined copy has been removed', async () => {
    let removed = false;
    const { groups, execute, input } = setup(vi.fn(async () => ({ exitCode: 1, output: 'src/work.ts(1,1): error TS2322: Existing failure' })));
    host.worktrees.withCombinedCopy = async (_repo, _base, members, action) => {
      try { return await action({ cwd: '/combined', head: 'combined-head', testedTree: 'combined-tree', members: [...members] }); }
      finally { removed = true; }
    };
    groups.reserve(item('leader'), run());
    const receipts = await groups.run(item('leader'), run(), { ...input(), withBaseline: async action => {
      expect(removed).toBe(true); return action('/baseline');
    } });
    expect(receipts).toMatchObject([{ baseline: 'also-failing-on-base' }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not seed changed heads, and a later fix commit cannot reuse the group receipts', async () => {
    const { groups, runner, input, execute } = setup(vi.fn(async () => { heads.set(item('member').worktreePath!, 'changed'); return { exitCode: 0, output: '' }; }));
    groups.reserve(item('leader'), run()); await groups.run(item('leader'), run(), input());
    expect(runner.cached({ ...input(), cwd: item('member').worktreePath!, head: 'member-head' })).toBeUndefined();
    expect(runner.cached({ ...input(), head: 'fixed-head' })).toBeUndefined();
    expect(await runner.run({ ...input(), head: 'fixed-head' })).toMatchObject([{ head: 'fixed-head', testedTree: 'solo-tree' }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('releases claims on a copy error, using solo fallback only for capacity refusal (%s)', async capacity => {
    const { groups, execute, input } = setup();
    const failure = capacity ? new WorktreeCapacityError('No available folder') : new Error('Disk operation failed');
    host.worktrees.withCombinedCopy = async () => { throw failure; };
    groups.reserve(item('leader'), run());
    const result = groups.run(item('leader'), run(), input());
    if (capacity) await expect(result).resolves.toBeUndefined(); else await expect(result).rejects.toBe(failure);
    expect(groups.isClaimed('member')).toBe(false); expect(execute).not.toHaveBeenCalled();
    expect(host.history.hasFailedCheckGroup('leader', 'leader-head')).toBe(false);
  });

  it('rolls back earlier seeds when cancellation arrives during a later member HEAD read', async () => {
    const { groups, runner, input } = setup();
    const read = vi.mocked(gitExec).getMockImplementation()!;
    let reads = 0;
    vi.mocked(gitExec).mockImplementation(async (args, cwd, timeout) => {
      const value = await read(args, cwd, timeout);
      if (cwd === item('member').worktreePath && args[0] === 'rev-parse' && args[1] === 'HEAD' && ++reads === 3) groups.cancel('member');
      return value;
    });
    groups.reserve(item('leader'), run()); const request = input();
    await expect(groups.run(item('leader'), run(), request)).rejects.toThrow();
    expect(runner.cached({ ...request, signal: undefined })).toBeUndefined();
    expect(runner.cached({ ...request, signal: undefined, cwd: item('member').worktreePath!, head: 'member-head' })).toBeUndefined();
    expect(groups.isClaimed('member')).toBe(false);
  });

  it('member cancellation aborts the group and releases every claim without evidence', async () => {
    const { groups, runner, input } = setup(vi.fn(async (_command, _cwd) => {
      groups.cancel('member'); return { exitCode: 0, output: '' };
    }));
    groups.reserve(item('leader'), run()); const request = input();
    await expect(groups.run(item('leader'), run(), request)).rejects.toThrow();
    expect(groups.isClaimed('member')).toBe(false);
    expect(runner.cached({ ...request, signal: undefined })).toBeUndefined();
  });
});
