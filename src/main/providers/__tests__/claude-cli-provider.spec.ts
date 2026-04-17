import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { ClaudeCliProvider } from '../claude-cli-provider';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

class FakeAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-1'; }
  getPid(): number | null { return 4321; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
}

vi.mock('../../cli/adapters/claude-cli-adapter', () => ({
  ClaudeCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('ClaudeCliProvider inline translation', () => {
  let provider: ClaudeCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    provider = new ClaudeCliProvider({ type: 'claude-cli', name: 'test', enabled: true });
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    // Grab the fake adapter the provider constructed.
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('assistant output becomes an output envelope', () => {
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp: Date.now(), metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('claude');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({ kind: 'output', content: 'hi', messageType: 'assistant', metadata: { foo: 1 } });
  });

  it('status string becomes a status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('context usage becomes a context envelope', () => {
    adapter.emit('context', { used: 10, total: 100, percentage: 10 });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'context', used: 10, total: 100, percentage: 10 });
  });

  it('error becomes an error envelope', () => {
    adapter.emit('error', new Error('boom'));
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'boom', recoverable: false });
  });

  it('exit becomes an exit envelope and clears isActive', () => {
    adapter.emit('exit', 0, null);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(provider.isRunning()).toBe(false);
  });

  it('spawned becomes a spawned envelope and sets isActive', () => {
    adapter.emit('spawned', 4321);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'spawned', pid: 4321 });
    expect(provider.isRunning()).toBe(true);
  });

  it('no legacy EventEmitter emission — emit count stays at 0', () => {
    const outputSpy = vi.fn();
    provider.on('output', outputSpy);
    adapter.emit('output', { id: 'm', type: 'assistant', content: 'x', timestamp: Date.now() });
    expect(outputSpy).not.toHaveBeenCalled();
  });
});
