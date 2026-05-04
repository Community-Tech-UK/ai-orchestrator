import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { CodexCliProvider } from '../codex-cli-provider';
import { CodexCliAdapter } from '../../cli/adapters/codex-cli-adapter';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

class FakeAdapter extends EventEmitter {
  async initialize(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-1'; }
  getPid(): number | null { return 1234; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendMessage(): Promise<{ id: string; content: string; role: string }> {
    return { id: 'r1', content: 'reply', role: 'assistant' };
  }
}

vi.mock('../../cli/adapters/codex-cli-adapter', () => ({
  CodexCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('CodexCliProvider inline translation', () => {
  let provider: CodexCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    vi.mocked(CodexCliAdapter).mockClear();
    provider = new CodexCliProvider({ type: 'openai', name: 'test', enabled: true });
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    // Grab the fake adapter the provider constructed.
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('output with OutputMessage object becomes an output envelope', () => {
    const timestamp = 1713340800000;
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp, metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('codex');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({
      kind: 'output',
      content: 'hi',
      messageType: 'assistant',
      messageId: 'm1',
      timestamp,
      metadata: { foo: 1 },
    });
  });

  it('output with plain string becomes an output envelope with messageType assistant', () => {
    adapter.emit('output', 'hello from string');
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('codex');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toMatchObject({ kind: 'output', content: 'hello from string', messageType: 'assistant' });
    expect(last.event).toHaveProperty('messageId');
    expect(last.event).toHaveProperty('timestamp');
  });

  it('output with attachments and thinking emits even when text content is empty', () => {
    const timestamp = 1713340800123;
    adapter.emit('output', {
      id: 'm-structured',
      type: 'assistant',
      content: '',
      timestamp,
      attachments: [{ name: 'diagram.png', type: 'image/png', size: 4, data: 'abcd' }],
      thinking: [{ id: 'thinking-1', content: 'Need to inspect the repo first', format: 'structured', tokenCount: 12 }],
      thinkingExtracted: true,
    });

    const last = envelopes.at(-1)!;
    expect(last.event).toEqual({
      kind: 'output',
      content: '',
      messageType: 'assistant',
      messageId: 'm-structured',
      timestamp,
      attachments: [{ name: 'diagram.png', type: 'image/png', size: 4, data: 'abcd' }],
      thinking: [{ id: 'thinking-1', content: 'Need to inspect the repo first', format: 'structured', tokenCount: 12 }],
      thinkingExtracted: true,
    });
  });

  it('status string becomes a status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('configures a longer timeout for long Codex investigations', () => {
    expect(vi.mocked(CodexCliAdapter)).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 900_000,
    }));
  });

  it('configures YOLO Codex sessions with danger-full-access sandbox', async () => {
    const yoloProvider = new CodexCliProvider({ type: 'openai', name: 'test', enabled: true });

    await yoloProvider.initialize({
      workingDirectory: '/tmp',
      instanceId: 'i-yolo',
      yoloMode: true,
    });

    expect(vi.mocked(CodexCliAdapter)).toHaveBeenLastCalledWith(expect.objectContaining({
      approvalMode: 'full-auto',
      sandboxMode: 'danger-full-access',
    }));
  });

  it('context usage becomes a context envelope', () => {
    adapter.emit('context', { used: 10, total: 100, percentage: 10 });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'context', used: 10, total: 100, percentage: 10 });
  });

  it('error with Error object becomes an error envelope', () => {
    adapter.emit('error', new Error('boom'));
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'boom', recoverable: false });
  });

  it('error with string becomes an error envelope', () => {
    adapter.emit('error', 'str err');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'str err', recoverable: false });
  });

  it('complete becomes a status idle envelope (behavior-preserving translation)', () => {
    adapter.emit('complete', { id: 'complete-1', content: '', role: 'assistant' });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'idle' });
  });

  it('exit becomes an exit envelope and clears isActive', () => {
    adapter.emit('exit', 0, null);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(provider.isRunning()).toBe(false);
  });

  it('spawned becomes a spawned envelope and sets isActive', () => {
    adapter.emit('spawned', 1234);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'spawned', pid: 1234 });
    expect(provider.isRunning()).toBe(true);
  });

  it('no legacy EventEmitter emission — output spy is not called', () => {
    expect('on' in (provider as unknown as Record<string, unknown>)).toBe(false);
    adapter.emit('output', { id: 'm', type: 'assistant', content: 'x', timestamp: Date.now() });
    expect(envelopes.at(-1)!.event).toMatchObject({ kind: 'output', content: 'x' });
  });
});
