import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingToolExecutor, ToolStatus } from './streaming-tool-executor';

describe('StreamingToolExecutor', () => {
  let executor: StreamingToolExecutor;
  const makeExecuteFn = (result: unknown, delayMs = 0) =>
    vi.fn(async () => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return { ok: true as const, output: result };
    });

  const makeFailingExecuteFn = (error: string) =>
    vi.fn(async () => ({ ok: false as const, error }));

  beforeEach(() => {
    executor = new StreamingToolExecutor();
  });

  it('executes a single tool and returns result', async () => {
    const executeFn = makeExecuteFn('hello');
    executor.addTool({
      toolUseId: 'tool-1',
      toolId: 'bash',
      args: {},
      concurrencySafe: true,
      executeFn,
    });

    const results: any[] = [];
    for await (const result of executor.getRemainingResults()) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe('tool-1');
    expect(results[0].output).toBe('hello');
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it('runs concurrency-safe tools in parallel', async () => {
    const startTimes: number[] = [];
    const makeTimed = (id: string) => vi.fn(async () => {
      startTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
      return { ok: true as const, output: id };
    });

    executor.addTool({ toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true, executeFn: makeTimed('a') });
    executor.addTool({ toolUseId: 'b', toolId: 'read', args: {}, concurrencySafe: true, executeFn: makeTimed('b') });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(2);
    // Both should start within ~10ms of each other (parallel)
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(30);
  });

  it('runs non-concurrent tools exclusively', async () => {
    const startTimes: number[] = [];
    const makeTimed = (id: string) => vi.fn(async () => {
      startTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
      return { ok: true as const, output: id };
    });

    executor.addTool({ toolUseId: 'a', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: makeTimed('a') });
    executor.addTool({ toolUseId: 'b', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: makeTimed('b') });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(2);
    // Second should start after first finishes (~50ms gap)
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(40);
  });

  it('cascades sibling abort on error when tool is non-concurrent', async () => {
    const failFn = makeFailingExecuteFn('disk full');
    const slowFn = vi.fn(async (_args: unknown, _ctx: unknown, signal?: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, output: 'done' }), 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return { ok: true as const, output: 'done' };
    });

    // Non-concurrent: first fails, second should be aborted
    executor.addTool({ toolUseId: 'fail', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: failFn });
    executor.addTool({ toolUseId: 'slow', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: slowFn });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    const failResult = results.find(r => r.toolUseId === 'fail');
    const slowResult = results.find(r => r.toolUseId === 'slow');
    expect(failResult?.ok).toBe(false);
    expect(slowResult?.ok).toBe(false);
    expect(slowResult?.error).toContain('sibling');
  });

  it('emits progress events', async () => {
    const progressMessages: any[] = [];
    executor.on('progress', (msg) => progressMessages.push(msg));

    const executeFn = vi.fn(async () => {
      executor.emitProgress('tool-1', 'Working on it...');
      return { ok: true as const, output: 'done' };
    });

    executor.addTool({ toolUseId: 'tool-1', toolId: 'bash', args: {}, concurrencySafe: true, executeFn });

    for await (const _r of executor.getRemainingResults()) { /* drain */ }

    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0].message).toBe('Working on it...');
  });

  it('returns results in submission order', async () => {
    // Tool 'b' finishes before tool 'a', but results should be in add order
    executor.addTool({
      toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 80));
        return { ok: true as const, output: 'a-result' };
      }),
    });
    executor.addTool({
      toolUseId: 'b', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10));
        return { ok: true as const, output: 'b-result' };
      }),
    });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results[0].toolUseId).toBe('a');
    expect(results[1].toolUseId).toBe('b');
  });

  it('discards pending tools when discard() is called', async () => {
    executor.addTool({
      toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 5000));
        return { ok: true as const, output: 'done' };
      }),
    });

    executor.discard();

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('discard');
  });
});
