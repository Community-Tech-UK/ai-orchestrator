import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { GeminiCliProvider } from '../gemini-cli-provider';
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

vi.mock('../../cli/adapters/gemini-cli-adapter', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('GeminiCliProvider inline translation', () => {
  let provider: GeminiCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    provider = new GeminiCliProvider({ type: 'google', name: 'test', enabled: true });
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    // Grab the fake adapter the provider constructed.
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('output with OutputMessage object becomes an output envelope', () => {
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp: Date.now(), metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('gemini');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({ kind: 'output', content: 'hi', messageType: 'assistant', metadata: { foo: 1 } });
  });

  it('output with plain string becomes an output envelope with messageType assistant', () => {
    adapter.emit('output', 'hello from string');
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('gemini');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({ kind: 'output', content: 'hello from string', messageType: 'assistant', metadata: undefined });
  });

  it('status string becomes a status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
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
    adapter.emit('complete');
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
    const outputSpy = vi.fn();
    provider.on('output', outputSpy);
    adapter.emit('output', { id: 'm', type: 'assistant', content: 'x', timestamp: Date.now() });
    expect(outputSpy).not.toHaveBeenCalled();
  });
});
