import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import * as gitCommands from '../workspace/git/git-exec';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { PlanQueueCheckGroups } from './plan-queue-check-groups';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { PlanQueueVerification } from './plan-queue-verification';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { PlanQueueItemLanding } from './plan-queue-item-landing';
import { PlanQueueLandingWaits } from './plan-queue-landing-wait';
import { groupCoversMovedBase } from './plan-queue-group-landing';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let repo: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let service: PlanQueueWorktreeService;
let run: PlanQueueRun;
let landing: PlanQueueItemLanding;
let base: string;
let gateLog: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function save(item: PlanQueueItem): PlanQueueItem { store.upsertItem(item); return item; }
function transition(item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
  assertItemTransition(item.state, state); return save({ ...item, ...patch, state });
}

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-group-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', '.git/no-hooks']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n*.md\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  base = git(['rev-parse', 'main']); gateLog = join(repo, '.git', 'post-merge-runs');
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', verifierGates: ['npm test'],
      postMergeGate: [`node -e "require('node:fs').appendFileSync(process.argv[1], 'checked\\n')" '${gateLog}'`] },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
  service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, creator: WorktreeManager.getInstance(),
    saveItem: save, skipInstall: true, history: store.history, stopLeftoversIn: async () => 0 });
  const host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save, transition, worktrees: service, requestPump: () => undefined } as PlanQueueFlowHost;
  // The real wait, with ports that never need a lock or a pump: neither file waits on the root checkout.
  const waits = new PlanQueueLandingWaits({ host, lock: (_id, action) => action(), enqueueLanding: async () => undefined, park: async () => undefined });
  landing = new PlanQueueItemLanding({ host, waits, stopInstance: async () => undefined,
    toFixing: async (item, _prompt, detail) => { transition(item, 'fixing', { detail }); },
    park: async (item, reason, detail) => { transition(item, 'parked', { parkReason: reason, detail }); } });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(repo, { recursive: true, force: true });
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting(); });

async function group(ids = ['one', 'two'], separateFirstRun = false): Promise<PlanQueueItem[]> {
  const members: PlanQueueItem[] = [];
  if (separateFirstRun) store.upsertRun({ ...run, id: 'other-run' });
  for (const id of ids) {
    writeFileSync(join(repo, `${id}_plan.md`), '# Checked plan\n');
    let item = newPlanQueueItem(id, id === 'one' && separateFirstRun ? 'other-run' : run.id,
      join(repo, `${id}_plan.md`), 1, { state: 'preparing', round: 1 });
    item = await service.prepare(item, repo);
    writeFileSync(join(item.worktreePath!, `${id}.txt`), `${id}\n`);
    item = await service.checkpoint(item, 'finished work');
    members.push(item);
  }
  const testedTree = await service.withCombinedCopy(repo, base,
    members.map(item => ({ itemId: item.id, head: item.checkpointCommit! })), async copy => copy.testedTree);
  expect(testedTree).toBeTruthy();
  const checkGroup = { id: 'test-group', baseTip: base, memberItemIds: ids };
  store.history.recordChecklistRun(members[0], ids, checkGroup.id);
  return members.map(item => {
    const verdict: PlanQueueVerdict = { verdict: 'PASS', findings: [], documentComplete: false, needJames: [],
      gatesRun: [{ command: 'npm test', exitCode: 0, head: item.checkpointCommit!, testedTree,
        checkGroup, classification: 'passed', baseline: 'new', timedOut: false }] };
    return save({ ...item, state: 'landing', verifiedMainCommit: base, verdict });
  });
}

async function landFirst(): Promise<void> {
  await landing.land('one', {});
  expect(store.getItem('one')?.state).toBe('landed');
  expect(existsSync(gateLog)).toBe(false);
}
async function landSecondWithGate(): Promise<void> {
  await landing.land('two', {});
  expect(store.getItem('two')?.state).toBe('landed');
  expect(readFileSync(gateLog, 'utf8')).toBe('checked\n');
}

describe('landing a member of a passing combined check', () => {
  it('still syncs and checkpoints the second member while skipping its covered post-merge check', async () => {
    const [, second] = await group();
    await landFirst();
    await landing.land('two', {});
    const landed = store.getItem('two')!;
    expect(landed.state).toBe('landed');
    expect(landed.checkpointCommit).not.toBe(second.checkpointCommit);
    expect(git(['show', `${landed.checkpointCommit}:one.txt`])).toBe('one');
    expect(git(['show', 'main:two.txt'])).toBe('two');
    expect(existsSync(gateLog)).toBe(false);
  });

  it('runs the post-merge check again when an unrelated commit lands in between', async () => {
    await group(); await landFirst();
    writeFileSync(join(repo, 'outside.txt'), 'outside\n'); git(['add', 'outside.txt']); git(['commit', '-qm', 'outside job']);
    await landSecondWithGate();
    expect(git(['show', 'main:outside.txt'])).toBe('outside');
  });

  it('runs the post-merge check when a member left the round and later returned', async () => {
    await group(['one', 'two', 'three']); await landFirst();
    let other = transition(store.getItem('three')!, 'fixing');
    other = transition(other, 'awaiting-slot'); transition(other, 'verifying');
    await landSecondWithGate();
  });

  it('does not mistake an empty commit range after a backward base move for covered work', async () => {
    await group(); await landFirst();
    const newerBase = git(['rev-parse', 'main']);
    for (const id of ['one', 'two']) {
      const item = store.getItem(id)!;
      for (const receipt of item.verdict!.gatesRun) receipt.checkGroup!.baseTip = newerBase;
      save(item);
    }
    await expect(groupCoversMovedBase(store.getItem('two')!, run, base, { store, history: store.history })).resolves.toBe(false);
  });

  it('keeps the post-merge check when uncommitted code changed after the combined check', async () => {
    const [, second] = await group(); await landFirst();
    writeFileSync(join(second.worktreePath!, 'two.txt'), 'changed after checking\n');
    await landSecondWithGate();
    expect(git(['show', 'main:two.txt'])).toBe('changed after checking');
  });

  it('keeps the post-merge check when an earlier member landed code changed after the combined check', async () => {
    const [first] = await group();
    writeFileSync(join(first.worktreePath!, 'one.txt'), 'changed after checking\n');
    await landFirst(); await landSecondWithGate();
  });

  it('also skips the third member after the second member was synced and checkpointed', async () => {
    await group(['one', 'two', 'three']); await landFirst();
    await landing.land('two', {}); await landing.land('three', {});
    expect(store.getItem('three')?.state).toBe('landed');
    expect(existsSync(gateLog)).toBe(false);
    expect(git(['show', 'main:one.txt'])).toBe('one');
    expect(git(['show', 'main:two.txt'])).toBe('two');
    expect(git(['show', 'main:three.txt'])).toBe('three');
  });

  it('keeps the post-merge check when another participating run is cancelled during syncing', async () => {
    await group(['one', 'two'], true); await landFirst();
    const checkpoint = service.checkpoint.bind(service);
    vi.spyOn(service, 'checkpoint').mockImplementation(async (item, label) => {
      const updated = await checkpoint(item, label);
      store.upsertRun({ ...store.getRun('other-run')!, status: 'cancelled' });
      return updated;
    });
    await landSecondWithGate();
  });

  it.each(['missing-command', 'different-tree', 'different-group', 'cancelled-run', 'failed-receipt'] as const)(
    'keeps the post-merge check for %s evidence', async condition => {
      await group(['one', 'two'], condition === 'cancelled-run'); await landFirst();
      const second = store.getItem('two')!;
      if (condition === 'missing-command') { run.config.verifierGates.push('npm run lint'); store.upsertRun(run); }
      else if (condition === 'cancelled-run') {
        store.upsertRun({ ...store.getRun('other-run')!, status: 'cancelled' });
      } else {
        const verdict = second.verdict!;
        const receipt = verdict.gatesRun[0];
        if (condition === 'different-tree') receipt.testedTree = git(['rev-parse', 'main^{tree}']);
        if (condition === 'different-group') receipt.checkGroup!.id = 'another-group';
        if (condition === 'failed-receipt') { receipt.exitCode = 1; receipt.classification = 'failed'; }
        save({ ...second, verdict });
      }
      await landSecondWithGate();
    },
  );
});


function runtimeFlow() {
  const roles = new Map<string, { role: 'verifier'; runId: string; itemId: string }>();
  const reviews: string[] = [];
  const original = PlanQueueGateRunner.prototype.executeCommands;
  const execute = vi.spyOn(PlanQueueGateRunner.prototype, 'executeCommands');
  execute.mockImplementation(function (input) {
    return original.call(new PlanQueueGateRunner(async () => ({ exitCode: 0, output: '1 tests passed' })), input);
  });
  const host = { store, history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save, transition, worktrees: service, requestPump: () => undefined, checksAdmitted: () => true,
    liveParentId: () => 'parent', selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    registerRole: (id: string, role: { role: 'verifier'; runId: string; itemId: string }) => roles.set(id, role),
    unregisterRole: (id: string) => roles.delete(id), roleOf: (id: string) => roles.get(id),
    tracker: { track: () => undefined, untrack: () => undefined, isShuttingDown: () => false },
    instances: { getInstance: () => undefined, createInstance: async (options: { metadata: { planQueueItemId: string } }) => {
      reviews.push(options.metadata.planQueueItemId); return { id: `checker-${reviews.length}` };
    } },
  } as unknown as PlanQueueFlowHost;
  const flow = new PlanQueueItemFlow(host);
  async function prepare(id: string) {
    const sourceRef = join(repo, `${id}_plan.md`); writeFileSync(sourceRef, '# Work\n');
    let item = await service.prepare(newPlanQueueItem(id, run.id, sourceRef, 1, { state: 'preparing' }), repo);
    writeFileSync(join(item.worktreePath!, `${id}.txt`), id);
    item = await service.checkpoint(item, 'work'); return save({ ...item, state: 'awaiting-slot' });
  }
  async function pass(id: string) {
    const item = store.getItem(id)!;
    flow.recordVerdict(item, item.verifierInstanceId!, { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] });
    await flow.onVerifierOutcome(item.verifierInstanceId!, { kind: 'turn-complete', lastAssistantOutput: null }); await flow.whenSettled();
    expect(store.getItem(id)?.state, JSON.stringify(store.getItem(id))).toBe('landed');
  }
  return { flow, execute, reviews, prepare, pass };
}

it('reuses the paired checklist after the first review really moves main, then synchronizes at landing', async () => {
  const { flow, execute, reviews, prepare, pass } = runtimeFlow();
  await prepare('solo'); await flow.startVerification(store.getItem('solo')!); await pass('solo');
  await prepare('one'); const second = await prepare('two');
  await flow.startVerification(store.getItem('one')!); await pass('one');
  const movedBase = git(['rev-parse', 'main']);
  expect(movedBase).not.toBe(base);
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(git(['rev-parse', 'HEAD'], second.worktreePath!)).toBe(second.checkpointCommit);
  expect(store.getItem('two')?.verifiedMainCommit).not.toBe(movedBase);
  await pass('two');
  expect(reviews).toEqual(['solo', 'one', 'two']);
  expect(store.history.checksSummary('run')).toEqual({ runs: 2, jobs: 3 });
  expect(store.history.listVerdicts('one')).toHaveLength(1);
  expect(store.history.listVerdicts('two')).toHaveLength(1);
  const firstReceipt = store.getItem('one')!.verdict!.gatesRun[0];
  const secondReceipt = store.getItem('two')!.verdict!.gatesRun[0];
  expect(secondReceipt.checkGroup).toEqual(firstReceipt.checkGroup);
  expect(secondReceipt.testedTree).toBe(firstReceipt.testedTree);
  expect(secondReceipt.head).toBe(second.checkpointCommit);
  expect(store.getItem('two')?.checkpointCommit).not.toBe(second.checkpointCommit);
  expect(git(['show', 'main:one.txt'])).toBe('one');
  expect(git(['show', 'main:two.txt'])).toBe('two');
});


it.each(['unrelated-base', 'changed-head', 'changed-command', 'changed-source', 'changed-linked-spec', 'dirty',
  'held-member', 'paused-run', 'cancelled-run', 'departed-round', 'cancelled-check'] as const)(
  'reruns machine checks instead of reusing pending group evidence after %s', async condition => {
    const { flow, execute, prepare, pass } = runtimeFlow();
    store.upsertRun({ ...run, id: 'leader-run' });
    await prepare('one');
    // A separate owning run may finish or pause independently after this member lands.
    db.prepare('UPDATE plan_queue_items SET run_id = ? WHERE id = ?').run('leader-run', 'one');
    const second = await prepare('two');
    await flow.startVerification(store.getItem('one')!); await pass('one');
    expect(execute).toHaveBeenCalledTimes(1);
    if (condition === 'unrelated-base') {
      writeFileSync(join(repo, 'outside.txt'), 'outside'); git(['add', 'outside.txt']); git(['commit', '-qm', 'outside']);
    } else if (condition === 'changed-head') {
      writeFileSync(join(second.worktreePath!, 'two.txt'), 'new work'); await service.checkpoint(second, 'new work');
    } else if (condition === 'changed-command') store.upsertRun({ ...run, config: { ...run.config, verifierGates: ['npm run check'] } });
    else if (condition === 'changed-source') writeFileSync(second.sourceRef, '# Changed criteria\n');
    else if (condition === 'changed-linked-spec') writeFileSync(join(repo, 'two_spec_planned.md'), '# New linked criteria\n');
    else if (condition === 'dirty') writeFileSync(join(second.worktreePath!, 'two.txt'), 'uncommitted work');
    else if (condition === 'held-member') save({ ...store.getItem('one')!, heldAt: Date.now() });
    else if (condition === 'paused-run' || condition === 'cancelled-run') {
      store.upsertRun({ ...store.getRun('leader-run')!, status: condition === 'paused-run' ? 'paused' : 'cancelled' });
    } else if (condition === 'departed-round') {
      transition(second, 'verifying'); transition(store.getItem('two')!, 'fixing'); transition(store.getItem('two')!, 'awaiting-slot');
    } else await flow.hold('two');
    await flow.startVerification(store.getItem('two')!);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.getItem('two')?.state).toBe('verifying');
    expect(store.getItem('two')?.verifiedMainCommit).toBe(git(['rev-parse', 'main']));
  },
);

it('reuses evidence from an already landed member whose other owning run completed', async () => {
  const { flow, execute, prepare, pass } = runtimeFlow();
  store.upsertRun({ ...run, id: 'leader-run' });
  await prepare('one'); db.prepare('UPDATE plan_queue_items SET run_id = ? WHERE id = ?').run('leader-run', 'one');
  await prepare('two'); await flow.startVerification(store.getItem('one')!); await pass('one');
  store.upsertRun({ ...store.getRun('leader-run')!, status: 'completed' });
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.getItem('two')?.state).toBe('verifying');
});


it('waits on a Git proof error without silently reusing or running old-HEAD checks', async () => {
  const { flow, execute, prepare, pass } = runtimeFlow();
  await prepare('one'); await prepare('two');
  await flow.startVerification(store.getItem('one')!); await pass('one');
  const original = gitCommands.gitExec;
  vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, timeout) => {
    if (args[0] === 'rev-list' && args[1] === '--first-parent') return Promise.reject(new Error('Cannot read group ancestry'));
    return original(args, cwd, timeout);
  });
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.getItem('two')).toMatchObject({ state: 'awaiting-slot', parkReason: null,
    detail: expect.stringContaining('Cannot read group ancestry') });
});

it('rechecks a hold arriving during the asynchronous ancestry proof', async () => {
  const { flow, execute, prepare, pass } = runtimeFlow();
  await prepare('one'); await prepare('two');
  await flow.startVerification(store.getItem('one')!); await pass('one');
  const original = gitCommands.gitExec;
  vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, cwd, timeout) => {
    const value = await original(args, cwd, timeout);
    if (args[0] === 'rev-list' && args[1] === '--first-parent') save({ ...store.getItem('one')!, heldAt: Date.now() });
    return value;
  });
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(store.getItem('two')?.verifiedMainCommit).toBe(git(['rev-parse', 'main']));
});


it('does not start an independent review if HEAD changes between pending proof and preparation', async () => {
  const { flow, execute, reviews, prepare, pass } = runtimeFlow();
  await prepare('one'); const second = await prepare('two');
  await flow.startVerification(store.getItem('one')!); await pass('one');
  const original = PlanQueueCheckGroups.prototype.pendingReceipts;
  vi.spyOn(PlanQueueCheckGroups.prototype, 'pendingReceipts').mockImplementationOnce(async function (this: PlanQueueCheckGroups, item) {
    const receipts = await original.call(this, item);
    expect(receipts).toBeDefined();
    writeFileSync(join(second.worktreePath!, 'two.txt'), 'changed during preparation');
    await service.checkpoint(store.getItem('two')!, 'changed during preparation');
    return receipts;
  });
  await flow.startVerification(store.getItem('two')!);
  expect(store.getItem('two')?.state).toBe('awaiting-slot');
  expect(reviews).toEqual(['one']);
  expect(execute).toHaveBeenCalledTimes(1);
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(reviews).toEqual(['one', 'two']);
});


it.each(['dirty', 'source', 'linked-spec', 'unrelated-base'] as const)(
  'waits and runs fresh checks when %s changes after the pending group proof', async kind => {
    const { flow, execute, reviews, prepare, pass } = runtimeFlow();
    await prepare('one'); const second = await prepare('two');
    await flow.startVerification(store.getItem('one')!); await pass('one');
    const original = PlanQueueCheckGroups.prototype.pendingReceipts;
    vi.spyOn(PlanQueueCheckGroups.prototype, 'pendingReceipts').mockImplementationOnce(async function (this: PlanQueueCheckGroups, item) {
      const receipts = await original.call(this, item);
      expect(receipts).toBeDefined();
      if (kind === 'dirty') writeFileSync(join(second.worktreePath!, 'two.txt'), 'untested dirty work');
      else if (kind === 'source') writeFileSync(second.sourceRef, '# Changed acceptance after proof\n');
      else if (kind === 'linked-spec') writeFileSync(join(repo, 'two_spec_planned.md'), '# Changed linked acceptance\n');
      else {
        writeFileSync(join(repo, 'outside.txt'), 'outside'); git(['add', 'outside.txt']); git(['commit', '-qm', 'outside']);
      }
      return receipts;
    });
    await flow.startVerification(store.getItem('two')!);
    expect(store.getItem('two')?.state).toBe('awaiting-slot');
    expect(reviews).toEqual(['one']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.history.listVerdicts('two')).toEqual([]);
    await flow.startVerification(store.getItem('two')!);
    expect(store.getItem('two')?.state).toBe('verifying');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(reviews).toEqual(['one', 'two']);
    expect(store.getItem('two')?.verifiedMainCommit).toBe(git(['rev-parse', 'main']));
    await pass('two');
    if (kind === 'dirty') expect(git(['show', 'main:two.txt'])).toBe('untested dirty work');
    if (kind === 'unrelated-base') expect(git(['show', 'main:outside.txt'])).toBe('outside');
  },
);


it.each(['dirty', 'source', 'linked-spec', 'unrelated-base'] as const)('rejects %s changes between grouped preparation and the checker prompt', async kind => {
  const { flow, execute, reviews, prepare, pass } = runtimeFlow();
  await prepare('one'); const second = await prepare('two');
  await flow.startVerification(store.getItem('one')!); await pass('one');
  const original = PlanQueueVerification.prototype.prompt;
  vi.spyOn(PlanQueueVerification.prototype, 'prompt').mockImplementationOnce(async function (this: PlanQueueVerification, item, currentRun, baseBranch) {
    if (kind === 'dirty') writeFileSync(join(second.worktreePath!, 'two.txt'), 'untested before prompt');
    else if (kind === 'source' || kind === 'linked-spec') {
      writeFileSync(kind === 'source' ? second.sourceRef : join(repo, 'two_spec_planned.md'), '# Replaced before prompt\n');
    } else {
      writeFileSync(join(repo, 'outside.txt'), 'outside'); git(['add', 'outside.txt']); git(['commit', '-qm', 'outside']);
    }
    return original.call(this, item, currentRun, baseBranch);
  });
  await flow.startVerification(store.getItem('two')!);
  expect(store.getItem('two')?.state).toBe('awaiting-slot');
  expect(reviews).toEqual(['one']);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.history.listVerdicts('two')).toEqual([]);
  await flow.startVerification(store.getItem('two')!);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(reviews).toEqual(['one', 'two']);
  await pass('two');
});
