import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliSpawnWorkerGateway, type CliSpawnWorkerLike } from './cli-spawn-worker-gateway';
import { CliAdapterWorkerProxy } from './cli-adapter-worker-proxy';
import { sendAbortableReviewerMessage } from '../../review/review-execution-host';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';

// Run after build:main. Only a disposable Node child replaces the provider.
describe('failed native worker reviewer accounting', () => {
  it.each(['paid', 'zero', 'unknown'])('keeps semantic failure and records final %s usage once', async mode => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () =>
      new Worker(resolve('dist/main/cli/spawn-worker/cli-spawn-worker-main.js')) as CliSpawnWorkerLike });
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'failed-fixture',
      options: { workingDirectory: process.cwd(), model: 'fixture-model' }, gateway });
    vi.spyOn(proxy as unknown as { command(): string }, 'command').mockReturnValue(process.execPath);
    const semantic = JSON.stringify({ type: 'error', error: { message: 'Fixture paid failure' } });
    const native = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
      total_cost_usd: mode === 'paid' ? 0.25 : 0, usage: { input_tokens: 100, output_tokens: 10 } });
    vi.spyOn(proxy as unknown as { buildArgs(): string[] }, 'buildArgs').mockReturnValue(['-e',
      `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(semantic + '\n')});setTimeout(()=>{${mode === 'unknown' ? '' : `process.stdout.write(${JSON.stringify(native)});`}process.exitCode=1;},150);});process.stdin.resume();`]);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    let callerSettled = false;
    const observations: { rows: number; callerSettled: boolean }[] = [];
    const semanticError = () => { observations.push({ rows: rows.length, callerSettled }); };
    const completion = vi.fn();
    proxy.on('error', semanticError);
    proxy.on('complete', completion);
    try {
      const error = await sendAbortableReviewerMessage(proxy, { role: 'user', content: 'fixture review' },
        new AbortController().signal, undefined,
        { purpose: 'cross-model-review', provider: 'claude', model: 'fixture-model' }).catch(error => {
          callerSettled = true; return error;
        });
      expect(error.message).toBe('Fixture paid failure');
      expect(observations).toEqual([{ rows: 0, callerSettled: false }]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'error', costKnown: mode !== 'unknown',
        costSource: mode === 'unknown' ? 'unknown' : 'provider' });
      if (mode !== 'unknown') expect(rows[0].usage?.cost).toBe(mode === 'paid' ? 0.25 : 0);
      expect(completion).toHaveBeenCalledTimes(1);
      proxy.off('error', semanticError); proxy.off('complete', completion);
      expect(proxy.listenerCount('usage')).toBe(0);
      expect(proxy.listenerCount('complete')).toBe(0);
      expect(proxy.listenerCount('error')).toBe(0);
      expect(proxy.listenerCount('exit')).toBe(0);
    } finally {
      stop(); await proxy.terminate(false); await gateway.close();
      vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  }, 10000);
});


describe('worker thread loss finality', () => {
  it.each(['native-error', 'partial-output', 'no-output'])('rejects %s sends and releases accounting observers', async mode => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    let worker!: Worker;
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () => {
      worker = new Worker(resolve('dist/main/cli/spawn-worker/cli-spawn-worker-main.js'));
      return worker as CliSpawnWorkerLike;
    } });
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'lost-worker-fixture',
      options: { workingDirectory: process.cwd(), model: 'fixture-model' }, gateway });
    vi.spyOn(proxy as unknown as { command(): string }, 'command').mockReturnValue(process.execPath);
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture partial output' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20 } } };
    const error = { type: 'error', error: { message: 'Fixture native failure before worker death' } };
    const frames = mode === 'native-error' ? [assistant, error] : mode === 'partial-output' ? [assistant] : [];
    const chunk = frames.map(frame => JSON.stringify(frame)).join('\n') + (frames.length ? '\n' : '');
    vi.spyOn(proxy as unknown as { buildArgs(): string[] }, 'buildArgs').mockReturnValue(['-e',
      `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)});setInterval(()=>{},1000);});process.stdin.resume();`]);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const observed = vi.fn();
    proxy.on(mode === 'native-error' ? 'error' : 'output', observed);
    const abort = new AbortController();
    let settled = false;
    const pending = sendAbortableReviewerMessage(proxy, { role: 'user', content: 'fixture' }, abort.signal, undefined,
      { purpose: 'cross-model-review', provider: 'claude', model: 'fixture-model' })
      .then(response => ({ response, error: undefined }), error => ({ response: undefined, error }))
      .then(result => { settled = true; return result; });
    try {
      if (mode === 'no-output') await vi.waitFor(() => expect(proxy.isRunning()).toBe(true));
      else await vi.waitFor(() => expect(observed).toHaveBeenCalled(), { timeout: 5000 });
      await worker.terminate();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      const result = await pending;
      expect(result.response).toBeUndefined();
      expect(result.error.message).toContain(mode === 'native-error' ? 'Fixture native failure' : 'CLI spawn worker exited');
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('error');
      if (mode !== 'no-output') expect(rows[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 });
      proxy.off(mode === 'native-error' ? 'error' : 'output', observed);
      for (const event of ['usage', 'complete', 'error', 'exit']) expect(proxy.listenerCount(event)).toBe(0);
    } finally {
      abort.abort(); await pending; stop(); await proxy.terminate(false).catch(() => undefined); await gateway.close();
      vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  }, 10000);
});

describe('actual one-shot native failed-result zero counters', () => {
  it.each(['no-result', 'unknown-zero-counters', 'paid-zero-counters', 'free-zero-counters'])('retains observed paid token/cache evidence (final mode=%s)', async mode => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () =>
      new Worker(resolve('dist/main/cli/spawn-worker/cli-spawn-worker-main.js')) as CliSpawnWorkerLike });
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'zero-counter-fixture',
      options: { workingDirectory: process.cwd(), model: 'claude-opus-5' }, gateway });
    vi.spyOn(proxy as unknown as { command(): string }, 'command').mockReturnValue(process.execPath);
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial paid work' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } };
    const failure = { type: 'error', error: { message: 'Fixture native execution failure' } };
    const final = { type: 'result', subtype: 'error_during_execution', is_error: true,
      ...(mode === 'paid-zero-counters' ? { total_cost_usd: 0.25 } : mode === 'free-zero-counters' ? { total_cost_usd: 0 } : {}),
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    const chunk = [assistant, failure, ...(mode !== 'no-result' ? [final] : [])].map(frame => JSON.stringify(frame)).join('\n') + '\n';
    vi.spyOn(proxy as unknown as { buildArgs(): string[] }, 'buildArgs').mockReturnValue(['-e',
      `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(chunk)},()=>process.exit(1));});process.stdin.resume();`]);
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    try {
      const failure = await sendAbortableReviewerMessage(proxy, { role: 'user', content: 'Disposable fixture' },
        new AbortController().signal, undefined,
        { purpose: 'cross-model-review', provider: 'claude', model: 'claude-opus-5' }).catch(error => error);
      expect(failure.message).toBe('Fixture native execution failure');
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('error');
      expect(rows[0].costSource).toBe(mode === 'paid-zero-counters' || mode === 'free-zero-counters' ? 'provider' : 'unknown');
      if (mode === 'paid-zero-counters') expect(rows[0].usage?.cost).toBe(0.25);
      if (mode === 'free-zero-counters') expect(rows[0].usage?.cost).toBe(0);
      expect(rows[0].usage?.totalTokens).toBe(110);
      expect(rows[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 });
      expect(failure.partialUsage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 });
    } finally {
      stop(); await proxy.terminate(false); await gateway.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  }, 10000);
});
