import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { CursorCliProvider } from '../cursor-cli-provider';
import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

const makeConfig = (): ProviderConfig => ({
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: true,
});

describe('CursorCliProvider identity', () => {
  it('reports provider = cursor', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.provider).toBe('cursor');
  });

  it('declares Wave 2 adapter capabilities', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.capabilities).toEqual({
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    });
  });

  it('getType returns cursor', () => {
    expect(new CursorCliProvider(makeConfig()).getType()).toBe('cursor');
  });

  it('reports inactive/null accessors before initialize', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.isRunning()).toBe(false);
    expect(p.getPid()).toBeNull();
    expect(p.getUsage()).toBeNull();
  });

  it('populates currentUsage when a context event is processed', () => {
    const p = new CursorCliProvider(makeConfig());
    (p as unknown as { updateUsageFromContext: (c: { used: number; total: number; percentage: number }) => void })
      .updateUsageFromContext({ used: 1000, total: 200000, percentage: 0.5 });
    const usage = p.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(1000);
    expect(usage!.inputTokens).toBe(700);
    expect(usage!.outputTokens).toBe(300);
    expect(usage!.estimatedCost).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Inline-translation tests
// ---------------------------------------------------------------------------

class FakeAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-1'; }
  getPid(): number | null { return null; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
  async checkStatus(): Promise<{ available: boolean }> { return { available: true }; }
}

vi.mock('../../cli/adapters/cursor-cli-adapter', () => ({
  CursorCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('CursorCliProvider inline translation', () => {
  let provider: CursorCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    provider = new CursorCliProvider(makeConfig());
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('output (OutputMessage) becomes output envelope', () => {
    const ts = 1713340800000;
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp: ts, metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('cursor');
    expect(last.instanceId).toBe('i-1');
    expect(last.event).toEqual({
      kind: 'output', content: 'hi', messageType: 'assistant',
      messageId: 'm1', timestamp: ts, metadata: { foo: 1 },
    });
  });

  it('status string becomes status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('context becomes context envelope AND updates getUsage', () => {
    adapter.emit('context', { used: 500, total: 128000, percentage: 0.39 });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'context', used: 500, total: 128000, percentage: 0.39 });
    const usage = provider.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(500);
  });

  it('error Error → error envelope', () => {
    adapter.emit('error', new Error('boom'));
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'boom', recoverable: false });
  });

  it('error string → error envelope', () => {
    adapter.emit('error', 'str');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'str', recoverable: false });
  });

  it('complete becomes a complete envelope', () => {
    adapter.emit('complete', { usage: { totalTokens: 42, cost: 0.25, duration: 500 } });
    expect(envelopes.at(-1)!.event).toEqual({
      kind: 'complete',
      tokensUsed: 42,
      costUsd: 0.25,
      durationMs: 500,
    });
  });

  it('exit → exit envelope + clears isActive', () => {
    adapter.emit('exit', 0, null);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(provider.isRunning()).toBe(false);
  });

  it('spawned → spawned envelope + sets isActive', () => {
    adapter.emit('spawned', 9999);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'spawned', pid: 9999 });
    expect(provider.isRunning()).toBe(true);
  });
});
