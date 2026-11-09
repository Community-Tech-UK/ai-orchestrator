import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { gitExec } from '../workspace/git/git-exec';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { documentContentSha256 } from './plan-queue-progress';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueVerification } from './plan-queue-verification';
import type { PlanQueueItem } from './plan-queue.types';

vi.mock('../workspace/git/git-exec', async original => ({ ...await original<typeof import('../workspace/git/git-exec')>(),
  gitExec: vi.fn(async (args: string[]) => args.some(arg => arg.startsWith('refs/heads/')) ? 'base' : 'head') }));
let root: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let host: PlanQueueFlowHost;
const pass: PlanQueueVerdict = { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [], notChecked: [] };
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'queue-check-policy-'));
  const sourceRef = join(root, 'work_plan.md'); writeFileSync(sourceRef, '# Work\n- [ ] Keep this criterion\n');
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  store.upsertRun({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: ['check'], baseBranch: 'main' },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null });
  store.upsertItem(newPlanQueueItem('item', 'run', sourceRef, 1, { state: 'verifying', branchName: 'queue/test',
    checkpointCommit: 'head', worktreePath: root, workerInstanceId: 'worker' }));
  host = { history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    save: (item: PlanQueueItem) => { store.upsertItem(item); return item; }, checksAdmitted: () => true,
    tracker: { isShuttingDown: () => false }, worktrees: {
      withBaseline: async (_repo: string, _sha: string, action: (cwd: string) => Promise<unknown>) => action('/baseline') },
  } as unknown as PlanQueueFlowHost;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('queue verification policy', () => {
  it('returns to pump admission when checks are paused or load has changed', async () => {
    host.checksAdmitted = () => false;
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const policy = createPolicy(createGates(execute));
    expect(await policy.prepare(host.getItem('item'))).toEqual({ kind: 'wait', detail: 'Checks are paused or the computer is busy.' });
    expect(execute).not.toHaveBeenCalled();
    host.checksAdmitted = () => true;
    expect(await policy.prepare(host.getItem('item'))).toEqual({ kind: 'ready' });
    expect(host.getItem('item').detail).toBe('Running checks');
    expect(await policy.prepare(host.getItem('item'))).toEqual({ kind: 'ready' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels one concurrent preparation while the other writes its receipts', async () => {
    const sourceRef = join(root, 'other_plan.md'); writeFileSync(sourceRef, '# Other work');
    store.upsertItem({ ...host.getItem('item'), id: 'other', sourceRef, worktreePath: `${root}/other` });
    const releases = new Map<string, () => void>();
    const execute = vi.fn((_command: string, cwd: string, signal?: AbortSignal) => new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      releases.set(cwd, () => { signal?.removeEventListener('abort', abort); resolve({ exitCode: 0, output: '' }); });
    }));
    const policy = createPolicy(createGates(execute));
    const first = policy.prepare(host.getItem('item'));
    const other = policy.prepare(host.getItem('other'));
    try {
      await vi.waitFor(() => expect(releases.size).toBe(2));
      policy.cancel('item');
      expect(await first).toEqual({ kind: 'wait', detail: 'Checks were stopped.' });
      releases.get(`${root}/other`)!();
      expect(await other).toEqual({ kind: 'ready' });
      await policy.prompt(host.getItem('other'), host.getRun('run'), 'main');
      expect(await policy.record(host.getItem('other'), pass)).toMatchObject({ verdict: 'PASS', gatesRun: [{ head: 'head', exitCode: 0 }] });
    } finally {
      policy.cancelAll(); for (const release of releases.values()) release();
      await Promise.all([first, other]);
    }
  });

  it.each(['x', 'X'])('keeps a pinned criterion present when its checkbox is marked [%s]', async mark => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.pin(host.getItem('item'));
    writeFileSync(host.getItem('item').sourceRef, `# Work\n- [${mark}] Keep this criterion\n`);
    expect(await policy.prompt(host.getItem('item'), host.getRun('run'), 'main')).toContain('"changes":[]');
    writeFileSync(host.getItem('item').sourceRef, `# Work\n- [${mark}] Keep this criterion only for one case\n`);
    expect(await policy.prompt(host.getItem('item'), host.getRun('run'), 'main')).toContain('"status":"reworded"');
  });
  it('hands the checker the plan Status, open work and a change summary instead of the whole document', async () => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.pin(host.getItem('item'));
    writeFileSync(host.getItem('item').sourceRef, '# Work\n\n## Status\nNext: Step 9\n\n## Open\n- [ ] Keep this criterion\n');
    const prompt = await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    expect(prompt).toContain('<plan_status>\nNext: Step 9\n</plan_status>');
    expect(prompt).toContain('- [ ] Keep this criterion');
    expect(prompt).toContain('<diff_stat>');
  });

  it('caps the change summary handed to the checker at about 4 KB, with a truncation marker', async () => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.pin(host.getItem('item'));
    const stat = Array.from({ length: 400 }, (_, index) => ` src/some/long/path/file-${index}.ts | 12 ++++++------`).join('\n');
    vi.mocked(gitExec).mockImplementation(async (args: string[]) => args.includes('--stat') && args.includes('main...HEAD') ? stat
      : args.some(arg => arg.startsWith('refs/heads/')) ? 'base' : 'head');
    try {
      const prompt = await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
      const block = /<diff_stat>\n([\s\S]*?)\n<\/diff_stat>/.exec(prompt)![1];
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(4096);
      expect(block).toContain('[Change summary truncated.');
    } finally {
      vi.mocked(gitExec).mockImplementation(async (args: string[]) => args.some(arg => arg.startsWith('refs/heads/')) ? 'base' : 'head');
    }
  });

  it('records red gates before spawning a checker and refuses an unbacked PASS afterward', async () => {
    const gates = createGates(async (_command, cwd) => cwd === '/baseline'
      ? { exitCode: 0, output: '' } : { exitCode: 1, output: 'src/work.ts(1,1): error TS2322: New failure' });
    const policy = createPolicy(gates);
    expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'fix' });
    expect(await policy.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'FAIL', documentComplete: false });
    expect(store.history.listVerdicts('item').map(row => row.verdict)).toEqual(['FAIL', 'FAIL']);
  });

  describe('checks that run out of time', () => {
    const timedOut = (progress = '') => async () => ({ exitCode: 1, timedOut: true, output: progress });
    const timeouts = () => store.history.listEvents('item').filter(event => event.reason === 'check-timeout');

    it('uses no round, reaches no worker and records no verdict, because no code was judged', async () => {
      const prepared = await createPolicy(createGates(timedOut())).prepare(host.getItem('item'));
      expect(prepared).toMatchObject({ kind: 'wait' });
      expect(host.getItem('item')).toMatchObject({ round: 0, verdict: null });
      expect(store.history.listVerdicts('item')).toEqual([]);
    });

    it('keeps how far the run got, so a stopped job can say', async () => {
      await createPolicy(createGates(timedOut('  … 1209 test file(s) done, 1 test worker(s) (full log: x)\n\n[plan queue] timed out'))).prepare(host.getItem('item'));
      expect(JSON.parse(timeouts()[0].detailHead!)).toMatchObject({ command: 'check', progress: '… 1209 test file(s) done, 1 test worker(s) (full log: x)' });
    });

    it('stops the job after two in a row, which points to a real hang', async () => {
      const execute = vi.fn(timedOut());
      const policy = createPolicy(createGates(execute));
      await policy.prepare(host.getItem('item'));
      expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'park', reason: 'check-hung' });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('starts counting again once a worker has changed the job', async () => {
      const policy = createPolicy(createGates(timedOut()));
      await policy.prepare(host.getItem('item'));
      store.history.recordEvent({ itemId: 'item', runId: 'run', fromState: 'verifying', toState: 'fixing', reason: null, detailHead: null, round: 0, tokens: 0 });
      expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'wait' });
    });

    it('reports only the real failure when one sits beside a timeout', async () => {
      store.upsertRun({ ...store.getRun('run')!, config: { ...store.getRun('run')!.config, verifierGates: ['bad', 'slow'] } });
      const gates = createGates(async (command, cwd) => cwd === '/baseline' ? { exitCode: 0, output: '' }
        : command === 'slow' ? { exitCode: 1, timedOut: true, output: '' } : { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Failure' });
      expect(await createPolicy(gates).prepare(host.getItem('item'))).toMatchObject({ kind: 'fix' });
      expect(host.getItem('item').verdict?.findings.map(finding => finding.summary)).toEqual(["Harness's own gate run failed: bad"]);
    });
  });

  it('allows only a proven existing base failure and gives its machine receipts to the checker', async () => {
    const gates = createGates(async () => ({ exitCode: 1, output: 'src/work.ts(1,1): error TS2322: Existing failure' }));
    const policy = createPolicy(gates);
    expect(await policy.prepare(host.getItem('item'))).toEqual({ kind: 'ready' });
    const prompt = await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    expect(await policy.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'PASS', gatesRun: [{ baseline: 'also-failing-on-base', head: 'head' }] });
    expect(prompt).toContain('gate_receipts');
    expect(prompt).toContain('Harness marked it also-failing-on-base');
    expect(prompt).not.toContain('every gate exited 0');
  });

  it('warns once for an unchanged fix, then parks even after a new policy instance', async () => {
    const gates = createGates(async (_command, cwd) => ({ exitCode: cwd === '/baseline' ? 0 : 1, output: 'src/work.ts(1,1): error TS2322: Failure' }));
    const policy = createPolicy(gates);
    await policy.prepare(host.getItem('item'));
    expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'fix', prompt: expect.stringContaining('Nothing changed') });
    expect(await createPolicy(gates).prepare(host.getItem('item'))).toMatchObject({ kind: 'park', reason: 'no-progress' });
  });

  it.each([false, true])('rechecks a changed source after invalidating a PASS (new policy: %s)', async restart => {
    const gates = createGates(async () => ({ exitCode: 0, output: '' }));
    const policy = createPolicy(gates);
    expect(await policy.prepare(host.getItem('item'))).toEqual({ kind: 'ready' });
    await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    const reviewedHash = await documentContentSha256(host.getItem('item').sourceRef);
    writeFileSync(host.getItem('item').sourceRef, '# Work\n- [ ] Keep this criterion\n- [ ] Added while reviewing\n');
    expect(await policy.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'FAIL', findings: [
      { summary: 'The source document changed while the checker was reviewing it.' },
    ] });
    expect(store.history.listVerdicts('item')[0].documentSha256).toBe(reviewedHash);
    const next = restart ? createPolicy(gates) : policy;
    expect(await next.prepare(host.getItem('item'))).toEqual({ kind: 'ready' });
    expect(store.history.listEvents('item').some(event => event.reason === 'no-progress-warning')).toBe(false);
    await next.prompt(host.getItem('item'), host.getRun('run'), 'main');
    expect(await next.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'PASS' });
  });

  it('records fresh gate evidence against the current document after an interrupted checker', async () => {
    const gates = createGates(async (_command, cwd) => ({ exitCode: cwd === '/baseline' ? 0 : 1,
      output: 'src/work.ts(1,1): error TS2322: Failure' }));
    const policy = createPolicy(gates);
    await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    writeFileSync(host.getItem('item').sourceRef, '# Updated after the checker was closed\n');
    expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'fix' });
    expect(store.history.listVerdicts('item')[0].documentSha256).toBe(await documentContentSha256(host.getItem('item').sourceRef));
    expect(await policy.prepare(host.getItem('item'))).toMatchObject({ kind: 'fix', prompt: expect.stringContaining('Nothing changed') });
  });

  it('refuses a PASS without a recorded checker document identity', async () => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.prepare(host.getItem('item'));
    expect(await policy.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'FAIL', documentComplete: false,
      findings: [{ summary: 'The checker did not record which source document it reviewed.' }] });
  });

  it.each([false, true])('keeps prepared check evidence while other jobs are admitted (checker prompted: %s)', async prompted => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.prepare(host.getItem('item'));
    if (prompted) await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    for (let index = 0; index < 100; index++) {
      const later = { ...host.getItem('item'), id: `later-${index}`, sourceRef: join(root, `later-${index}_plan.md`) };
      writeFileSync(later.sourceRef, '# Another plan\n');
      store.upsertItem(later);
      expect(await policy.prepare(later)).toEqual({ kind: 'ready' });
    }
    if (!prompted) await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    expect(await policy.record(host.getItem('item'), pass)).toMatchObject({ verdict: 'PASS' });
  });

  it('does not erase an in-flight review identity when a hold cancels checks before acquiring the item lock', async () => {
    const policy = createPolicy(createGates(async () => ({ exitCode: 0, output: '' })));
    await policy.prepare(host.getItem('item'));
    await policy.prompt(host.getItem('item'), host.getRun('run'), 'main');
    const recording = policy.record(host.getItem('item'), pass);
    policy.cancel('item');
    expect(await recording).toMatchObject({ verdict: 'PASS' });
  });

  it('runs base checks without removing the queue folder or stopping its worker', async () => {
    const order: string[] = [];
    const item = host.getItem('item');
    Object.assign(host.worktrees, {
      checkpoint: async () => { order.push('checkpoint'); return host.getItem('item'); },
      removeWithProof: async () => { order.push('remove'); host.save({ ...host.getItem('item'), worktreePath: null }); return { removed: true }; },
      withBaseline: async (_repo: string, _sha: string, action: (cwd: string) => Promise<unknown>) => { order.push('base'); return action('/baseline'); },
      reattach: async () => { order.push('reattach'); return host.save({ ...host.getItem('item'), worktreePath: root }); },
    });
    const gates = createGates(async (_command, cwd) => ({ exitCode: cwd === '/baseline' ? 0 : 1, output: 'src/work.ts(1,1): error TS2322: Failure' }));
    const policy = createPolicy(gates);
    expect(await policy.prepare(item)).toMatchObject({ kind: 'fix' });
    expect(order).toEqual(['base']);
    expect(host.getItem('item').worktreePath).toBe(root);
    expect(host.getItem('item').workerInstanceId).toBe('worker');
  });
});

function createGates(execute: ConstructorParameters<typeof PlanQueueGateRunner>[0]) {
  return new PlanQueueGateRunner(execute, () => 'verification-test-tree');
}
function createPolicy(gates: PlanQueueGateRunner) {
  return new PlanQueueVerification(host, gates, { lock: async (_id, action) => action(), waiting: () => false });
}
