import { describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { blockingGateReceipts, classifyGateEvidence, PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { runInProcessGroup } from './plan-queue-process';
import { gitExec } from '../workspace/git/git-exec';

const fakeTree = () => 'unit-test-tree';
const fakeRunner = (execute: ConstructorParameters<typeof PlanQueueGateRunner>[0]) => new PlanQueueGateRunner(execute, fakeTree);

describe('Harness queue gate receipts', () => {
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
});
