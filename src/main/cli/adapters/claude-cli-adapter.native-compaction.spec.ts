import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import { InputFormatter } from '../input-formatter';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

type Options = { resident?: boolean; version?: string; pipe?: boolean };

function harness(options: Options = {}) {
  const adapter = new ClaudeCliAdapter({ residentClaude: options.resident ?? true, sessionId: 'synthetic-session' });
  const writes: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback(); } });
  const state = adapter as unknown as {
    process: unknown; formatter: InputFormatter; cachedCliStatus: unknown;
    residentTurnActive: boolean; awaitingOneShotCompletion: boolean;
    handleStdout(chunk: Buffer): void; handleExit(code: number, signal: null): void;
    compactContext(): Promise<boolean>; nativeCompactionKnownUnsupported(): boolean;
  };
  state.process = options.pipe === false ? null : { stdin };
  state.formatter = new InputFormatter(stdin);
  state.cachedCliStatus = { available: true, version: options.version ?? '2.1.310' };
  const feed = (message: unknown) => state.handleStdout(Buffer.from(JSON.stringify(message) + '\n'));
  return { adapter, state, writes, stdin, feed };
}

afterEach(() => vi.useRealTimers());

describe('Claude adapter native compaction wiring', () => {
  it.each(['sendInput', 'sendRaw'] as const)('holds %s through the compact result and reports provider maintenance', async route => {
    const { adapter, state, feed, writes } = harness();
    const pending = state.compactContext();
    const sent = vi.fn();
    const input = adapter[route]('input after compaction').then(sent);
    await Promise.resolve();
    expect(adapter.isProviderCompacting()).toBe(true);
    expect(writes).toHaveLength(1);
    feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 47076, post_tokens: 10236 } });
    expect(await pending).toBe(true);
    expect(sent).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    await input;
    expect(adapter.isProviderCompacting()).toBe(false);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]).message.content).toBe('input after compaction');
  });

  it.each(['while-waiting', 'after-result'] as const)('cancels queued dispatch without writing (%s)', async timing => {
    const { adapter, state, feed, writes } = harness();
    const pending = state.compactContext();
    const controller = new AbortController();
    const dispatched = vi.fn();
    const input = adapter.sendInput('cancelled input', undefined, { dispatch: { signal: controller.signal, beforeProviderDispatch: dispatched } });
    const outcome = input.catch(error => error);
    if (timing === 'while-waiting') controller.abort();
    feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 47076 } });
    expect(await pending).toBe(true);
    feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    if (timing === 'after-result') controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(dispatched).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('rejects queued input when compaction fails, leaving fallback exclusive ownership', async () => {
    const { adapter, state, feed, writes } = harness();
    const pending = state.compactContext();
    const input = adapter.sendInput('wait for recovery').catch(error => error);
    feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await pending).toBe(false);
    expect(await input).toBeInstanceOf(Error);
    expect(writes).toHaveLength(1);
  });

  it.each(['one-shot', 'stream'] as const)('refuses %s sends during native maintenance before spawning or resetting the turn', async route => {
    const { adapter, state, feed, writes } = harness();
    const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): never }, 'spawnProcess').mockImplementation(() => {
      throw new Error('Synthetic one-shot process must not start');
    });
    const pending = state.compactContext();
    const message = { role: 'user' as const, content: 'one-shot input' };
    const outcome = (route === 'one-shot' ? adapter.sendMessage(message) : adapter.sendMessageStream(message)[Symbol.asyncIterator]().next()).catch(error => error);
    expect(await outcome).toBeInstanceOf(Error);
    expect(state.residentTurnActive).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await pending).toBe(false);
  });

  it.each<[Options, boolean]>([
    [{}, true], [{ resident: false }, false], [{ pipe: false }, false],
    [{ version: '2.1.309' }, false], [{ version: '2.2.0' }, true],
  ])('advertises native support for %j as %s', (options, expected) => {
    const { adapter } = harness(options);
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(expected);
    expect(adapter.getRuntimeCapabilities().selfManagedAutoCompaction).toBe(true);
    expect(adapter.getContextCapabilities().compactionProof).toBe(options.pipe === false || options.resident === false ? 'none' : 'observed');
  });

  it('uses the executing process version from init without spawning another process', () => {
    const { adapter, state, feed } = harness();
    const probe = vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, version: '2.1.310', path: 'claude' });
    state.cachedCliStatus = null;
    feed({ type: 'system', subtype: 'init', claude_code_version: '2.1.310' });
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(true);
    feed({ type: 'system', subtype: 'init', claude_code_version: '2.1.309' });
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the session and normal completion/cost accounting, hiding synthetic compact echoes', async () => {
    const { adapter, state, feed, writes } = harness();
    const completed = vi.fn();
    const output = vi.fn();
    adapter.on('complete', completed);
    adapter.on('output', output);
    const pending = state.compactContext();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).message.content).toMatch(/^\/compact Keep my open requests word for word/);
    feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 47076, post_tokens: 10236 }, session_id: 'synthetic-session' });
    expect(await pending).toBe(true);
    feed({ type: 'user', isSynthetic: true, content: 'synthetic summary', message: { role: 'user', content: 'synthetic summary' } });
    feed({ type: 'user', isReplay: true, content: '<local-command-stdout>Compacted</local-command-stdout>' });
    feed({ type: 'result', subtype: 'success', total_cost_usd: 0.01, usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 99000, outputTokens: 1000, contextWindow: 1000000 } } });
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][0].usage.cost).toBe(0.01);
    expect(output.mock.calls.filter(([message]) => message.type === 'user')).toEqual([]);
    expect(adapter.getSessionId()).toBe('synthetic-session');
    expect(adapter.getTurnCompaction()).toEqual({ count: 1, trigger: 'manual', preTokens: 47076, postTokens: 10236 });
    expect(adapter.getLastContextUsage()).toMatchObject({ status: 'known', used: 10236 });
    expect(state.residentTurnActive).toBe(false);
    feed({ type: 'user', content: 'ordinary user echo' });
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ type: 'user', content: 'ordinary user echo' }));
  });

  it.each(['residentTurnActive', 'awaitingOneShotCompletion'] as const)('never writes a compact command while %s', async field => {
    const { state, writes } = harness();
    state[field] = true;
    expect(await state.compactContext()).toBe(false);
    expect(writes).toEqual([]);
  });

  it('keeps missing post-compaction occupancy unknown instead of using cumulative result totals', async () => {
    const { adapter, state, feed } = harness();
    const context = vi.fn();
    adapter.on('context', context);
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier reply' }], usage: { input_tokens: 50000, output_tokens: 10 } } });
    feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(adapter.getLastContextUsage()).toMatchObject({ status: 'known', used: 50010 });
    context.mockClear();
    const pending = state.compactContext();
    feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 47076 } });
    expect(await pending).toBe(true);
    feed({ type: 'result', total_cost_usd: 0.01,
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 99000, outputTokens: 1000, contextWindow: 1000000 } } });
    expect(context).not.toHaveBeenCalled();
    expect(adapter.getLastContextUsage()).toEqual({ status: 'unknown', reason: 'not-reported' });
  });

  it('records unsupported assistant replies for the runtime fallback', async () => {
    const { state, feed } = harness();
    const pending = state.compactContext();
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Please use the terminal to compact.' }] } });
    expect(await pending).toBe(false);
    expect(state.nativeCompactionKnownUnsupported()).toBe(true);
  });

  it('settles on process exit and does not leave a five-minute timer alive', async () => {
    vi.useFakeTimers();
    const { state } = harness();
    const pending = state.compactContext();
    state.handleExit(1, null);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves the resident pipe while a streaming send prepares', async () => {
    // A stream send is refused outright while a resident process exists, so it starts with no pipe;
    // the pipe appears while it is still preparing, and compaction must not take it.
    const { adapter, state, feed, writes, stdin } = harness({ pipe: false });
    let release!: () => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const prepared = new Promise<void>(resolve => { release = resolve; });
    const streamHost = adapter as unknown as {
      prepareHardenedLogin(): Promise<void>;
      spawnProcess(args: string[]): never;
    };
    vi.spyOn(streamHost, 'prepareHardenedLogin').mockImplementation(async () => { entered(); await prepared; });
    vi.spyOn(streamHost, 'spawnProcess').mockImplementation(() => { throw new Error('Synthetic stream stop'); });
    const input = adapter.sendMessageStream({ role: 'user', content: 'streamed input' })[Symbol.asyncIterator]().next().catch(error => error);
    await preparing;
    state.process = { stdin };
    try {
      const compact = state.compactContext();
      const compactWrites = writes.length;
      feed({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
      expect(await compact).toBe(false);
      expect(compactWrites).toBe(0);
    } finally {
      release();
      expect(await input).toBeInstanceOf(Error);
    }
  });

  it('waits for an earlier failed turn receipt before admitting native compaction', async () => {
    const { adapter, state, feed, writes } = harness();
    adapter.on('error', vi.fn());
    await adapter.sendInput('earlier request');
    feed({ type: 'error', error: { message: 'Synthetic earlier turn failure' } });
    const phaseBeforeReceipt = adapter.getRuntimeSnapshot().turnPhase;
    const premature = state.compactContext();
    const prematureWrites = writes.length;
    feed({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await premature).toBe(false);
    expect(phaseBeforeReceipt).toBe('running');
    expect(prematureWrites).toBe(1);
    const compact = state.compactContext();
    feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 47076, post_tokens: 10236 } });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(await compact).toBe(true);
    expect(writes).toHaveLength(2);
  });
});
