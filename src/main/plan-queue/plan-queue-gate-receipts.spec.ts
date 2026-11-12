import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { PlanQueueGateRunSchema } from '@contracts/schemas/plan-queue';
import { blockingGateReceipts, classifyGateEvidence, GATE_TIMEOUT_MS, notRunReasonOf, onlyTimedOut, PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { runInProcessGroup } from './plan-queue-process';
import { gitExec } from '../workspace/git/git-exec';

const fakeTree = () => 'unit-test-tree';
const fakeRunner = (execute: ConstructorParameters<typeof PlanQueueGateRunner>[0], useThisMac = true) =>
  new PlanQueueGateRunner(execute, fakeTree, () => useThisMac);

describe('Harness queue gate receipts', () => {
  it('gives one check long enough for a full test run on a shared machine, which timed out at 15 minutes', () => {
    expect(GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('does not count or inspect a tree when no commands execute', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const readTree = vi.fn(() => 'tree');
    const onExecution = vi.fn();
    const runner = new PlanQueueGateRunner(execute, readTree);
    expect(await runner.run({ cwd: '/empty', head: 'head', commands: [], onExecution })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(readTree).not.toHaveBeenCalled();
    expect(onExecution).not.toHaveBeenCalled();
  });

  it('records the actual checked Git tree rather than the member commit', async () => {
    const runner = new PlanQueueGateRunner(async () => ({ exitCode: 0, output: '' }));
    const [receipt] = await runner.run({ cwd: process.cwd(), head: 'member-head', commands: ['check'] });
    expect(receipt.testedTree).toBe(await gitExec(['rev-parse', 'HEAD^{tree}'], process.cwd()));
    expect(receipt.testedTree).not.toBe(receipt.head);
  });

  it('seeds exact member receipts without executing and returns isolated copies', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const runner = new PlanQueueGateRunner(execute, async () => 'combined-tree');
    const input = { cwd: '/member', head: 'member-head', commands: ['check'], baseSha: 'base' };
    const receipts = await runner.run({ ...input, cwd: '/combined' });
    receipts[0].checkGroup = { id: 'group', baseTip: 'base', memberItemIds: ['one', 'two'] };
    runner.seed(input, receipts);
    receipts[0].checkGroup.memberItemIds.push('mutation');
    const reused = await runner.run(input);
    expect(reused).toMatchObject([{ head: 'member-head', testedTree: 'combined-tree',
      checkGroup: { id: 'group', memberItemIds: ['one', 'two'] } }]);
    reused[0].tail = 'mutation';
    expect(runner.cached(input)?.[0].tail).toBe('');
    expect(execute).toHaveBeenCalledTimes(1);
    await runner.run({ ...input, head: 'changed' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(() => runner.seed(input, [{ ...reused[0], head: 'different' }])).toThrow();
    expect(() => runner.seed(input, [{ ...reused[0], command: 'different' }])).toThrow();
  });

  it('can withdraw exactly one seeded member even after cancellation', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const runner = fakeRunner(execute);
    const input = { cwd: '/member', head: 'head', commands: ['check'], baseSha: 'base' };
    const other = { ...input, cwd: '/other' };
    await runner.run(input);
    await runner.run(other);
    const controller = new AbortController(); controller.abort();
    runner.forget({ ...input, signal: controller.signal });
    expect(runner.cached(input)).toBeUndefined();
    expect(runner.cached(other)).toBeDefined();
    await runner.run(input);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('runs a commit\'s checks again after forgetting it, and leaves other commits cached', async () => {
    const execute = vi.fn(async () => ({ exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Nope' }));
    const runner = fakeRunner(execute);
    const job = { cwd: '/repo', head: 'job', commands: ['check'] };
    const other = { ...job, head: 'other' };
    await runner.run(job); await runner.run(other);
    runner.forgetCommit('job');
    expect(runner.cached(job)).toBeUndefined();
    expect(runner.cached(other)).toBeDefined();
    await runner.run(job);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('keeps base comparison separate from copy execution and records only real job runs', async () => {
    const calls: string[] = [];
    const runner = new PlanQueueGateRunner(async (_command, cwd) => {
      calls.push(cwd);
      return { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Existing failure' };
    }, async () => 'tree');
    const onExecution = vi.fn();
    const input = { cwd: '/combined', head: 'combined-head', commands: ['check'], baseSha: 'base', onExecution,
      withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
    const raw = await runner.executeCommands(input);
    expect(calls).toEqual(['/combined']);
    expect(raw[0].failureKeyCounts).not.toEqual({});
    const compared = await runner.compareWithBase(input, raw);
    expect(calls).toEqual(['/combined', '/base']);
    expect(compared[0]).toMatchObject({ baseline: 'also-failing-on-base', failureKeyCounts: {} });
    runner.seed(input, compared);
    await runner.run(input);
    expect(onExecution).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/combined', '/base']);
  });

  it('keeps the names of failing tests from a clipped report, through the cache and the schema', async () => {
    const output = [
      '✗ src/a.spec.ts › first test', '  → expected 1 to be 2',
      '✗ src/a.spec.ts › first test', '  → expected 3 to be 4',
      '✗ src/b.spec.ts › group | second test', '  → boom', '     ', '    …(truncated — see log)', '',
      '  …and 28 more failed test(s) — see _scratch/test-run.log',
    ].join('\n');
    const runner = new PlanQueueGateRunner(async () => ({ exitCode: 1, output }), async () => 'tree');
    const input = { cwd: '/repo', head: 'head', commands: ['npm test'] };
    const [receipt] = await runner.run(input);
    expect(receipt.failingTests).toEqual(['src/a.spec.ts › first test', 'src/b.spec.ts › group | second test']);
    expect(runner.cached(input)?.[0].failingTests).toEqual(receipt.failingTests);
    expect(PlanQueueGateRunSchema.parse(receipt).failingTests).toEqual(receipt.failingTests);
  });

  it('caps the names it keeps so a stored result stays within the schema', async () => {
    const output = Array.from({ length: 30 }, (_, index) => `✗ src/a.spec.ts › ${'long '.repeat(80)}${index}\n  → no`).join('\n');
    const runner = new PlanQueueGateRunner(async () => ({ exitCode: 1, output }), async () => 'tree');
    const [receipt] = await runner.run({ cwd: '/repo', head: 'head', commands: ['npm test'] });
    expect(() => PlanQueueGateRunSchema.parse(receipt)).not.toThrow();
    expect(receipt.failingTests!.length).toBeGreaterThan(0);
    expect(receipt.failingTests!.length).toBeLessThanOrEqual(20);
  });

  it('names no tests for a failure that is not a test', async () => {
    const runner = new PlanQueueGateRunner(async () => ({ exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Nope' }), async () => 'tree');
    const [receipt] = await runner.run({ cwd: '/repo', head: 'head', commands: ['tsc'] });
    expect(receipt).not.toHaveProperty('failingTests');
  });

  it('starts real command groups concurrently and cancels one without killing the other', async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const script = `require('node:net').connect(${port},'127.0.0.1').on('data',function(){this.end();process.exit(0)})`;
    const command = `"${process.execPath}" -e "${script}"`;
    const runner = new PlanQueueGateRunner();
    const controller = new AbortController();
    const otherController = new AbortController();
    const input = { cwd: process.cwd(), head: 'first', commands: [command] };
    const first = runner.run({ ...input, signal: controller.signal }).then(() => 'finished', () => 'cancelled');
    let otherFinished = false;
    const other = runner.run({ ...input, head: 'other', signal: otherController.signal }).then(receipts => {
      otherFinished = true; return receipts;
    });
    try {
      await vi.waitFor(() => expect(sockets.size).toBe(2), { timeout: 10_000 });
      controller.abort();
      expect(await first).toBe('cancelled');
      await vi.waitFor(() => expect(sockets.size).toBe(1), { timeout: 10_000 });
      expect(otherFinished).toBe(false);
      for (const socket of sockets) socket.end('finish');
      expect(await other).toMatchObject([{ head: 'other', exitCode: 0, classification: 'passed' }]);
    } finally {
      controller.abort(); otherController.abort();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([first, other]);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 20_000);

  it('reports an actual command timeout independently of its output', async () => {
    const result = await runInProcessGroup(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 1000, outputTail: 2048, label: 'receipt timeout test',
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);
  it('does not treat an empty successful test process as passing test evidence', () => {
    expect(classifyGateEvidence('npm run test:quiet', 0, '')).toBe('not-recognised');
    expect(classifyGateEvidence('npm run test:quiet', 0, '✓ 2 files · 15 tests passed in 2s')).toBe('passed');
    expect(classifyGateEvidence('npm test', 0, 'No test files found')).toBe('no-tests-found');
    expect(classifyGateEvidence('npm run lint', 1, '')).toBe('failed');
  });

  it('compares complete diagnostic multisets through the executing runner and refuses unknown or additional failures', async () => {
    const base = 'src/a.ts(2,3): error TS2322: Wrong type';
    for (const [output, expected] of [[base, 'also-failing-on-base'], [base + '\n' + base, 'new'], [base + '\n[ERROR] unexpected runtime failure', 'new'],
      ['unrecognised failure', 'new'], [base + '\n' + 'x'.repeat(256_000), 'new']] as const) {
      const runner = fakeRunner(async (_command, cwd) => ({ exitCode: 1, output: cwd === '/base' ? base : output }));
      const receipts = await runner.run({ cwd: '/item', head: 'head', commands: ['check'], baseSha: 'base',
        withBaseline: action => action('/base') });
      expect(receipts[0].baseline).toBe(expected);
      expect(blockingGateReceipts(receipts)).toHaveLength(expected === 'new' ? 1 : 0);
    }
  });

  it.each([
    ['npm test', 'Tests: 5 passed, 5 total'], ['go test ./...', 'ok example/package 0.1s'],
    ['npx mocha', '5 passing (10ms)'],
  ])('recognises a successful %s summary', (command, output) => {
    expect(classifyGateEvidence(command, 0, output)).toBe('passed');
  });

  it.each(['Tests: 0 passed, 0 total', 'Tests 0 passed', '0 tests passed in 1s', '0 passing (0ms)'])(
    'does not pass an explicit zero-test summary: %s', output => {
      expect(classifyGateEvidence('npm test', 0, output)).toBe('no-tests-found');
    });

  it.each([
    ['ok example/pkg 0.005s [no tests to run]', 'no-tests-found'],
    ['? example/pkg [no test files]', 'no-tests-found'],
    ['? example/empty [no test files]\nok example/filtered 0.005s [no tests to run]', 'no-tests-found'],
    ['? example/empty [no test files]\nok example/tested 0.005s', 'passed'],
    ['ok example/filtered 0.005s [no tests to run]\nok example/tested (cached)', 'passed'],
  ] as const)('distinguishes empty Go packages from a real passing package: %s', (output, classification) => {
    expect(classifyGateEvidence('go test ./...', 0, output)).toBe(classification);
  });

  it('retains unknown successful output without treating it as a red receipt', async () => {
    const runner = fakeRunner(async command => command === 'npm test --unknown-summary'
      ? { exitCode: 0, output: 'All good in a custom runner' }
      : command === 'npm test --empty' ? { exitCode: 0, output: 'No tests found' }
      : { exitCode: 1, output: 'Failed' });
    const receipts = await runner.run({ cwd: '/item', head: 'head', commands: ['npm test --unknown-summary', 'npm test --empty', 'red'] });
    expect(receipts[0].classification).toBe('not-recognised');
    expect(blockingGateReceipts(receipts).map(receipt => receipt.command)).toEqual(['npm test --empty', 'red']);
  });

  it('runs commands serially within each concurrent set and reuses only matching receipts', async () => {
    let active = 0;
    let maximum = 0;
    const perFolder = new Map<string, number>();
    const execute = vi.fn(async (command: string, cwd: string) => {
      active++; maximum = Math.max(maximum, active);
      perFolder.set(cwd, (perFolder.get(cwd) ?? 0) + 1);
      expect(perFolder.get(cwd)).toBe(1);
      await new Promise(resolve => setImmediate(resolve));
      perFolder.set(cwd, perFolder.get(cwd)! - 1);
      active--;
      return { exitCode: command === 'bad' ? 1 : 0, output: 'diagnostic', timedOut: false };
    });
    const runner = fakeRunner(execute);
    const input = { cwd: '/item', head: 'head-1', commands: ['bad', 'good'] };
    const [first, second] = await Promise.all([runner.run(input), runner.run({ ...input, cwd: '/other' })]);
    expect(first.map(receipt => receipt.exitCode)).toEqual([1, 0]);
    expect(second).toHaveLength(2);
    expect(maximum).toBe(2);
    expect(await runner.run(input)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(4);
    await runner.run({ ...input, head: 'head-2' });
    expect(execute).toHaveBeenCalledTimes(6);
    await runner.run({ ...input, commands: ['good'] });
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it('gives a real check a fixed test worker count, because a busy start would otherwise leave it on one', async () => {
    const runner = new PlanQueueGateRunner(undefined, fakeTree);
    const [receipt] = await runner.run({ cwd: process.cwd(), head: 'h', commands: ['echo "forks=$AIO_TEST_MAX_FORKS"'] });
    expect(receipt.tail).toContain('forks=8');
  });

  it('runs a timed-out check again instead of replaying it against the same code', async () => {
    const execute = vi.fn(async () => ({ exitCode: 1, timedOut: true, output: '' }));
    const runner = fakeRunner(execute);
    const input = { cwd: '/item', head: 'h', commands: ['check'] };
    await runner.run(input);
    expect(runner.cached(input)).toBeUndefined();
    await runner.run(input);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('skips the run on the base when only timeouts failed, because it could not change the answer', async () => {
    const usedBase = vi.fn();
    const withBaseline = async <T>(action: (cwd: string) => Promise<T>) => { usedBase(); return action('/baseline'); };
    const runner = fakeRunner(async () => ({ exitCode: 1, timedOut: true, output: '' }));
    await runner.run({ cwd: '/item', head: 'h', commands: ['check'], baseSha: 'base', withBaseline });
    expect(usedBase).not.toHaveBeenCalled();
  });

  it('stops the checklist at a timeout, so a hang holds the turn once and not once per command', async () => {
    const execute = vi.fn(async () => ({ exitCode: 1, timedOut: true, output: '' }));
    const receipts = await fakeRunner(execute).run({ cwd: '/item', head: 'h', commands: ['first', 'second', 'third'] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
  });

  it('never keeps a timed-out run on the base, which would hide a failure main really has', async () => {
    let baseRuns = 0;
    const execute = vi.fn(async (_command: string, cwd: string) => {
      if (cwd !== '/baseline') return { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Existing failure' };
      baseRuns += 1;
      return baseRuns === 1 ? { exitCode: 1, timedOut: true, output: '' } : { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Existing failure' };
    });
    const runner = fakeRunner(execute);
    const input = (head: string) => ({ cwd: '/item', head, commands: ['check'], baseSha: 'base', scope: '/repo',
      withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/baseline') });
    expect((await runner.run(input('first')))[0].baseline).toBe('new');
    expect((await runner.run(input('second')))[0].baseline).toBe('also-failing-on-base');
  });

  it('still compares with the base when a real failure sits beside a timeout', async () => {
    const usedBase = vi.fn();
    const withBaseline = async <T>(action: (cwd: string) => Promise<T>) => { usedBase(); return action('/baseline'); };
    const runner = fakeRunner(async (command, cwd) => cwd === '/baseline' ? { exitCode: 0, output: '' } : command === 'slow'
      ? { exitCode: 1, timedOut: true, output: '' } : { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Failure' });
    const receipts = await runner.run({ cwd: '/item', head: 'h', commands: ['bad', 'slow'], baseSha: 'base', withBaseline });
    expect(usedBase).toHaveBeenCalledTimes(1);
    expect(onlyTimedOut(receipts)).toBe(false);
  });

  it('marks a check no test machine could take as not run, stops there, and neither compares nor keeps it', async () => {
    const execute = vi.fn(async (command: string) => command === 'first'
      ? { exitCode: 69, output: '\u001b[33mNot run: the test Mac and the Windows PC are both paused\u001b[39m\n' } : { exitCode: 0, output: '' });
    const runner = fakeRunner(execute);
    const input = { cwd: '/item', head: 'h', commands: ['first', 'second'], baseSha: 'base',
      withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
    const receipts = await runner.run(input);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ exitCode: 69, classification: 'failed', timedOut: false, baseline: 'new',
      notRun: 'the test Mac and the Windows PC are both paused' });
    expect(notRunReasonOf(receipts)).toBe('the test Mac and the Windows PC are both paused');
    expect(blockingGateReceipts(receipts)).toHaveLength(1);
    expect(execute.mock.calls.map(call => call[0])).toEqual(['first']);
    expect(runner.cached(input)).toBeUndefined();
    expect(PlanQueueGateRunSchema.parse(receipts[0])).not.toHaveProperty('notRun');
  });

  it('keeps an ordinary failure a failure, and a bare exit 69 without the runner\'s line too', async () => {
    const [failed] = await fakeRunner(async () => ({ exitCode: 1, output: 'Not run: printed by a test\n' })).run({ cwd: '/i', head: 'h', commands: ['c'] });
    expect(failed).not.toHaveProperty('notRun');
    const [bare] = await fakeRunner(async () => ({ exitCode: 69, output: '' })).run({ cwd: '/i', head: 'h', commands: ['c'] });
    expect(bare).not.toHaveProperty('notRun');
    expect(bare.classification).toBe('failed');
  });

  it('retains timeout separately from output and limits receipt tails', async () => {
    const runner = fakeRunner(async () => ({ exitCode: 0, timedOut: true, output: 'x'.repeat(6000) }));
    const [receipt] = await runner.run({ cwd: '/item', head: 'h', commands: ['check'] });
    expect(receipt).toMatchObject({ head: 'h', timedOut: true, classification: 'failed', baseline: 'new' });
    expect(Buffer.byteLength(receipt.tail)).toBeLessThanOrEqual(2048);
  });

  it('cancels one active gate set without stopping or delaying the other sets', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const calls: string[] = [];
    const runner = fakeRunner(async (command, _cwd, signal) => {
      calls.push(command);
      if (command === 'first') { entered(); await held; }
      if (command === 'cancelled') {
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      }
      return { exitCode: 0, output: '' };
    });
    const first = runner.run({ cwd: '/first', head: 'h', commands: ['first'] });
    await started;
    const controller = new AbortController();
    let outcome = 'pending';
    const cancelled = runner.run({ cwd: '/cancelled', head: 'h', commands: ['cancelled', 'must-not-run'], signal: controller.signal })
      .then(() => { outcome = 'resolved'; }, () => { outcome = 'cancelled'; });
    controller.abort();
    const next = runner.run({ cwd: '/next', head: 'h', commands: ['next'] });
    let observed: string;
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      observed = outcome;
      expect(calls).toEqual(['first', 'cancelled', 'next']);
    } finally { release(); await Promise.all([first, cancelled, next]); }
    expect(observed).toBe('cancelled');
    expect(calls).toEqual(['first', 'cancelled', 'next']);
    await runner.run({ cwd: '/cancelled', head: 'h', commands: ['retry'] });
    expect(calls.at(-1)).toBe('retry');
  });

  it('honours cancellation before returning cached receipts', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: '' }));
    const runner = fakeRunner(execute);
    const input = { cwd: '/item', head: 'head', commands: ['check'] };
    await runner.run(input);
    const controller = new AbortController(); controller.abort();
    await expect(runner.run({ ...input, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never caches an aborted run even when the executor returns normally', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(); return { exitCode: 0, output: '' }; });
    const runner = fakeRunner(execute);
    const input = { cwd: '/item', head: 'head', commands: ['check'] };
    await expect(runner.run({ ...input, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(await runner.run(input)).toMatchObject([{ exitCode: 0 }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reuses an in-flight base comparison without tying its cancellation to another job', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const withBaseline = vi.fn(async (action: (cwd: string) => Promise<unknown>) => action('/base'));
    const execute = vi.fn(async (_command: string, cwd: string) => {
      if (cwd === '/base') await held;
      return { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Existing failure' };
    });
    const runner = fakeRunner(execute);
    const input = { cwd: '/first', head: 'head', commands: ['check'], baseSha: 'base', scope: '/repo',
      withBaseline: withBaseline as <T>(action: (cwd: string) => Promise<T>) => Promise<T> };
    const first = runner.run(input);
    const controller = new AbortController();
    const cancelled = runner.run({ ...input, cwd: '/cancelled', signal: controller.signal }).catch(() => 'cancelled');
    const other = runner.run({ ...input, cwd: '/other' });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(withBaseline).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(await cancelled).toBe('cancelled');
      release();
      expect(await first).toMatchObject([{ baseline: 'also-failing-on-base' }]);
      expect(await other).toMatchObject([{ baseline: 'also-failing-on-base' }]);
      await runner.run({ ...input, cwd: '/later' });
      expect(withBaseline).toHaveBeenCalledTimes(1);
    } finally { release(); await Promise.allSettled([first, cancelled, other]); }
  });

  it('takes its own base evidence when the job that owned a shared comparison is cancelled', async () => {
    let baseRuns = 0;
    const diagnostic = { exitCode: 1, output: 'src/a.ts(1,1): error TS2322: Existing failure' };
    const runner = fakeRunner(async (_command, cwd, signal) => {
      if (cwd === '/base' && ++baseRuns === 1) {
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      }
      return diagnostic;
    });
    const controller = new AbortController();
    const input = { cwd: '/first', head: 'head', commands: ['check'], baseSha: 'base', scope: '/repo',
      withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
    const first = runner.run({ ...input, signal: controller.signal }).catch(() => 'cancelled');
    const other = runner.run({ ...input, cwd: '/other' });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(baseRuns).toBe(1);
      controller.abort();
      expect(await first).toBe('cancelled');
      expect(await other).toMatchObject([{ baseline: 'also-failing-on-base' }]);
      expect(baseRuns).toBe(2);
    } finally { controller.abort(); await Promise.allSettled([first, other]); }
  });

  describe('where a check ran', () => {
    const failing = (machine: string | null) => ({
      exitCode: 1,
      output: `FAIL src/a.spec.ts > a test\n${machine ? `Ran on ${machine} in 5m 52s.\n` : ''}`,
    });
    const compare = (execute: ConstructorParameters<typeof PlanQueueGateRunner>[0]) => fakeRunner(execute).run({
      cwd: '/item', head: 'h', commands: ['npm run test:quiet'], baseSha: 'base',
      withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base'),
    });

    it('records the machine the test runner names, with colour codes and on a fallback', async () => {
      const run = (output: string) => fakeRunner(async () => ({ exitCode: 0, output })).run({ cwd: '/item', head: 'h', commands: ['check'] });
      expect((await run('  \u001b[32mRan on the Windows PC in 5m 52s.\u001b[39m\n'))[0].ranOn).toBe('the Windows PC');
      expect((await run('Ran on the Mac in 12m 3s, because the Windows PC could not be reached.\n'))[0].ranOn).toBe('the Mac');
    });

    it('records nothing for a check that does not say', async () => {
      const [receipt] = await fakeRunner(async () => ({ exitCode: 0, output: 'done' })).run({ cwd: '/item', head: 'h', commands: ['check'] });
      expect(receipt).not.toHaveProperty('ranOn');
    });

    it('keeps the run on main on the Mac when the job\'s check fell back there', async () => {
      const execute = vi.fn(async (_command: string, _cwd: string, _signal?: AbortSignal, _env?: Record<string, string>) => failing('the Mac'));
      const [receipt] = await compare(execute);
      expect(execute.mock.calls[0][3]).toBeUndefined();
      expect(execute.mock.calls[1][1]).toBe('/base');
      expect(execute.mock.calls[1][3]).toEqual({ AIO_REMOTE_CHECKS: 'off' });
      expect(receipt).toMatchObject({ baseline: 'also-failing-on-base', timedOut: false });
    });

    it('sends the run on main to a test machine when "use this Mac" is off, even though the job\'s check ran here', async () => {
      const execute = vi.fn(async (_command: string, _cwd: string, _signal?: AbortSignal, _env?: Record<string, string>) => failing('the Mac'));
      await fakeRunner(execute, false).run({ cwd: '/item', head: 'h', commands: ['npm run test:quiet'], baseSha: 'base',
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') });
      expect(execute.mock.calls[1][1]).toBe('/base');
      expect(execute.mock.calls[1][3]).toBeUndefined();
    });

    it('leaves the run on main free to go to the PC when the job\'s check ran there', async () => {
      const execute = vi.fn(async (_command: string, _cwd: string, _signal?: AbortSignal, _env?: Record<string, string>) => failing('the Windows PC'));
      const [receipt] = await compare(execute);
      expect(execute.mock.calls[1][3]).toBeUndefined();
      expect(receipt).toMatchObject({ baseline: 'also-failing-on-base', timedOut: false });
    });

    it('calls it "did not finish" when the two ran on different machines, rather than blocking the job', async () => {
      const execute = vi.fn(async (_command: string, cwd: string) => failing(cwd === '/base' ? 'the Mac' : 'the Windows PC'));
      const receipts = await compare(execute);
      expect(receipts[0]).toMatchObject({ timedOut: true, baseline: 'new' });
      expect(receipts[0].tail).toContain('different machine');
      expect(onlyTimedOut(receipts)).toBe(true);
    });

    it('keeps the tail inside the stored limit when it adds its note', async () => {
      const long = 'x'.repeat(4000);
      const execute = vi.fn(async (_command: string, cwd: string) => {
        const { exitCode, output } = failing(cwd === '/base' ? 'the Mac' : 'the Windows PC');
        return { exitCode, output: `${output}${long}` };
      });
      const [receipt] = await compare(execute);
      expect(receipt.tail.length).toBeLessThanOrEqual(2048);
      expect(receipt.tail).toContain('different machine');
    });

    it('keeps a real failure when only the run on main names a machine, as after a failed preflight', async () => {
      const execute = vi.fn(async (_command: string, cwd: string) => failing(cwd === '/base' ? 'the Windows PC' : null));
      const [receipt] = await compare(execute);
      expect(receipt).toMatchObject({ timedOut: false, classification: 'failed' });
      expect(receipt.tail).not.toContain('different machine');
    });

    it('does not keep a run on main that fell back to the Mac, so the next job can still compare on the PC', async () => {
      let baseMachine = 'the Mac';
      const execute = vi.fn(async (_command: string, cwd: string) => failing(cwd === '/base' ? baseMachine : 'the Windows PC'));
      const runner = fakeRunner(execute);
      const input = { head: 'h', commands: ['npm run test:quiet'], baseSha: 'base', scope: 'run',
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
      expect((await runner.run({ ...input, cwd: '/one' }))[0].timedOut).toBe(true);
      baseMachine = 'the Windows PC';
      expect(await runner.run({ ...input, cwd: '/two', head: 'h2' })).toMatchObject([{ timedOut: false, baseline: 'also-failing-on-base' }]);
    });

    it('still keeps a run on main that was asked to stay on the Mac', async () => {
      const execute = vi.fn(async () => failing('the Mac'));
      const runner = fakeRunner(execute);
      const input = { head: 'h', commands: ['npm run test:quiet'], baseSha: 'base', scope: 'run',
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
      await runner.run({ ...input, cwd: '/one' });
      await runner.run({ ...input, cwd: '/two', head: 'h2' });
      expect(execute.mock.calls.filter(call => (call as unknown[])[1] === '/base')).toHaveLength(1);
    });

    it('keeps other settings alongside the instruction to stay on the Mac', async () => {
      const execute = vi.fn(async (_command: string, _cwd: string, _signal?: AbortSignal, _env?: Record<string, string>) => failing('the Mac'));
      await fakeRunner(execute).run({ cwd: '/item', head: 'h', commands: ['npm run test:quiet'], baseSha: 'base', extraEnv: { KEPT: '1' },
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') });
      expect(execute.mock.calls[1][3]).toEqual({ KEPT: '1', AIO_REMOTE_CHECKS: 'off' });
    });

    it('does not answer a job that needs main on the Mac from a run on main that went to the PC', async () => {
      let jobMachine = 'the Windows PC';
      const execute = vi.fn(async (_command: string, cwd: string, _signal?: AbortSignal, _env?: Record<string, string>) =>
        failing(cwd !== '/base' ? jobMachine : _env ? 'the Mac' : 'the Windows PC'));
      const runner = fakeRunner(execute);
      const input = { head: 'h', commands: ['npm run test:quiet'], baseSha: 'base', scope: 'run',
        withBaseline: <T>(action: (cwd: string) => Promise<T>) => action('/base') };
      await runner.run({ ...input, cwd: '/one' });
      jobMachine = 'the Mac';
      expect(await runner.run({ ...input, cwd: '/two', head: 'h2' })).toMatchObject([{ timedOut: false, baseline: 'also-failing-on-base' }]);
      expect(execute.mock.calls.filter(call => call[1] === '/base')).toHaveLength(2);
    });

    it('still compares normally when neither side says where it ran', async () => {
      const [receipt] = await compare(vi.fn(async () => failing(null)));
      expect(receipt).toMatchObject({ baseline: 'also-failing-on-base', timedOut: false });
    });
  });
});

describe('Harness queue checks sent as one batch', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** A worktree that has the checks script, as main does since the remote-first plan's Stage 2. */
  function worktree(): string {
    const folder = mkdtempSync(join(tmpdir(), 'gate-batch-'));
    folders.push(folder);
    mkdirSync(join(folder, 'scripts/remote-checks'), { recursive: true });
    writeFileSync(join(folder, 'scripts/remote-checks/checks.js'), '');
    return folder;
  }

  /** Answers the batch the way checks.js does, and anything else as a test run on the PC. */
  const answerFiles: string[] = [];
  function machine(answer: (checks: string[]) => object | null, batch: Partial<{ timedOut: boolean }> = {}) {
    return vi.fn(async (command: string, _cwd?: string, _signal?: AbortSignal, _extraEnv?: Record<string, string>) => {
      if (!command.startsWith('node scripts/remote-checks/checks.js')) {
        return { exitCode: 0, output: '5 tests passed\nRan on the Windows PC in 7m 0s.' };
      }
      const jsonPath = /--json '([^']+)'/.exec(command)![1]!;
      answerFiles.push(jsonPath);
      const checks = [...command.slice(command.indexOf(' -- ')).matchAll(/'([^']+)'/g)].map(match => match[1]!);
      const outcome = answer(checks);
      if (outcome) writeFileSync(jsonPath, JSON.stringify(outcome));
      return { exitCode: 0, output: 'batch output', ...batch };
    });
  }

  const passing = (checks: string[]) => ({
    ranOn: 'the Windows PC',
    checks: checks.map(command => command === 'npm run lint'
      ? { command, exitCode: 2, durationMs: 1234, output: 'src/a.ts(1,1): error TS2322: Nope' }
      : { command, exitCode: 0, durationMs: 1000, output: 'fine' }),
  });

  it('sends the checks it knows in one trip, and keeps one receipt per check in the original order', async () => {
    const execute = machine(passing);
    const onExecution = vi.fn();
    const receipts = await fakeRunner(execute).run({
      cwd: worktree(), head: 'head', commands: ['npx tsc --noEmit', 'npm run test:quiet', 'npm run lint'], onExecution,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onExecution).toHaveBeenCalledTimes(1);
    expect(receipts.map(receipt => receipt.command)).toEqual(['npx tsc --noEmit', 'npm run test:quiet', 'npm run lint']);
    expect(receipts[0]).toMatchObject({ exitCode: 0, classification: 'passed', ranOn: 'the Windows PC', durationMs: 1000 });
    expect(receipts[1]).toMatchObject({ classification: 'passed', ranOn: 'the Windows PC' });
    expect(receipts[2]).toMatchObject({ exitCode: 2, classification: 'failed', ranOn: 'the Windows PC', durationMs: 1234 });
    expect(receipts[2]!.tail).toContain('TS2322');
    expect(answerFiles.at(-1)).toContain(tmpdir());
    expect(existsSync(answerFiles.at(-1)!)).toBe(false);
  });

  it('runs each check on its own in a worktree without the checks script', async () => {
    const execute = vi.fn(async (_command: string) => ({ exitCode: 0, output: '' }));
    await fakeRunner(execute).run({ cwd: '/older-branch', head: 'head', commands: ['npx tsc --noEmit', 'npm run lint'] });
    expect(execute.mock.calls.map(call => call[0])).toEqual(['npx tsc --noEmit', 'npm run lint']);
  });

  it('times out the checks when the batch runs out of time, which says nothing about the code', async () => {
    const execute = machine(() => null, { timedOut: true });
    const receipts = await fakeRunner(execute).run({ cwd: worktree(), head: 'head', commands: ['npx tsc --noEmit', 'npm run lint'] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
    expect(onlyTimedOut(receipts)).toBe(true);
  });

  it('runs each check on its own when the batch leaves no usable answer', async () => {
    for (const answer of [() => null, (checks: string[]) => ({ ranOn: 'the Mac', checks: passing(checks).checks.slice(1) })]) {
      const execute = machine(answer);
      const onExecution = vi.fn();
      const receipts = await fakeRunner(execute).run({
        cwd: worktree(), head: 'head', commands: ['npx tsc --noEmit', 'npm run lint'], onExecution,
      });
      expect(onExecution).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls.map(call => call[0]).slice(1)).toEqual(['npx tsc --noEmit', 'npm run lint']);
      expect(receipts.map(receipt => receipt.command)).toEqual(['npx tsc --noEmit', 'npm run lint']);
    }
  });

  it('names no machine when no test machine is set up, as a check run directly names none', async () => {
    const execute = machine(checks => ({ ranOn: null, checks: passing(checks).checks }));
    const [receipt] = await fakeRunner(execute).run({ cwd: worktree(), head: 'head', commands: ['npm run typecheck'] });
    expect(receipt).toMatchObject({ classification: 'passed' });
    expect(receipt).not.toHaveProperty('ranOn');
  });

  it('marks every check not run when the batch says no test machine could take it, and runs nothing else', async () => {
    const execute = machine(() => ({ ranOn: null, checks: [], notRun: true, reason: 'both test machines are busy' }));
    execute.mockImplementationOnce(async (command: string) => {
      const jsonPath = /--json '([^']+)'/.exec(command)![1]!;
      writeFileSync(jsonPath, JSON.stringify({ notRun: true, reason: 'both test machines are busy' }));
      return { exitCode: 69, output: 'Not run: both test machines are busy' };
    });
    const runner = fakeRunner(execute);
    const input = { cwd: worktree(), head: 'head', commands: ['npx tsc --noEmit', 'npm run test:quiet', 'npm run lint'] };
    const receipts = await runner.run(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts).toEqual([expect.objectContaining({ command: 'npx tsc --noEmit', exitCode: 69, notRun: 'both test machines are busy' })]);
    expect(runner.cached(input)).toBeUndefined();
  });

  it('passes the stay-on-the-Mac request through to the batch', async () => {
    const execute = machine(checks => ({ ranOn: 'the Mac', checks: passing(checks).checks }));
    const [receipt] = await fakeRunner(execute).run({
      cwd: worktree(), head: 'head', commands: ['npm run typecheck'], extraEnv: { AIO_REMOTE_CHECKS: 'off' },
    });
    expect(execute.mock.calls[0]![3]).toEqual({ AIO_REMOTE_CHECKS: 'off' });
    expect(receipt).toMatchObject({ ranOn: 'the Mac', classification: 'passed' });
  });
});
