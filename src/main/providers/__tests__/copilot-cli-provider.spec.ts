import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { CopilotCliProvider } from '../copilot-cli-provider';
import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

const makeConfig = (): ProviderConfig => ({
  type: 'copilot',
  name: 'GitHub Copilot CLI',
  enabled: true,
});

describe('CopilotCliProvider identity', () => {
  it('reports provider = copilot', () => {
    const p = new CopilotCliProvider(makeConfig());
    expect(p.provider).toBe('copilot');
  });

  it('declares Wave 2 adapter capabilities', () => {
    const p = new CopilotCliProvider(makeConfig());
    expect(p.capabilities).toEqual({
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    });
  });

  it('getType returns copilot', () => {
    const p = new CopilotCliProvider(makeConfig());
    expect(p.getType()).toBe('copilot');
  });

  it('reports inactive/null accessors before initialize', () => {
    const p = new CopilotCliProvider(makeConfig());
    expect(p.isRunning()).toBe(false);
    expect(p.getPid()).toBeNull();
    expect(p.getUsage()).toBeNull();
  });

  it('populates currentUsage when a context event is processed', () => {
    const p = new CopilotCliProvider(makeConfig());
    // Invoke the private updateUsageFromContext handler directly. This is the
    // same path the 'context' event listener registered in initialize() takes,
    // so it verifies the capability-declared usageReporting actually works
    // without needing to stand up the full Copilot CLI adapter.
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

vi.mock('../../cli/adapters/copilot-cli-adapter', () => ({
  CopilotCliAdapter: vi.fn().mockImplementation(() => new FakeAdapter()),
}));

describe('CopilotCliProvider inline translation', () => {
  let provider: CopilotCliProvider;
  let adapter: FakeAdapter;
  let envelopes: ProviderRuntimeEventEnvelope[];

  beforeEach(async () => {
    provider = new CopilotCliProvider(makeConfig());
    envelopes = [];
    provider.events$.subscribe(e => envelopes.push(e));
    await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-1' });
    // Grab the fake adapter the provider constructed.
    adapter = (provider as unknown as { adapter: FakeAdapter }).adapter;
  });

  it('output (OutputMessage) becomes an output envelope', () => {
    const timestamp = 1713340800000;
    adapter.emit('output', { id: 'm1', type: 'assistant', content: 'hi', timestamp, metadata: { foo: 1 } });
    const last = envelopes.at(-1)!;
    expect(last.provider).toBe('copilot');
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

  it('status string becomes a status envelope', () => {
    adapter.emit('status', 'busy');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'status', status: 'busy' });
  });

  it('context usage becomes a context envelope and updates getUsage()', () => {
    adapter.emit('context', { used: 500, total: 128000, percentage: 0.39 });
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'context', used: 500, total: 128000, percentage: 0.39 });
    // Regression guard: updateUsageFromContext side-effect is preserved.
    const usage = provider.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(500);
  });

  it('error with Error object becomes an error envelope', () => {
    adapter.emit('error', new Error('boom'));
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'boom', recoverable: false });
  });

  it('error with string becomes an error envelope', () => {
    adapter.emit('error', 'str err');
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'error', message: 'str err', recoverable: false });
  });

  it('exit becomes an exit envelope and clears isActive', () => {
    adapter.emit('exit', 0, null);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'exit', code: 0, signal: null });
    expect(provider.isRunning()).toBe(false);
  });

  it('spawned becomes a spawned envelope and sets isActive', () => {
    adapter.emit('spawned', 9999);
    expect(envelopes.at(-1)!.event).toEqual({ kind: 'spawned', pid: 9999 });
    expect(provider.isRunning()).toBe(true);
  });

  it('no legacy EventEmitter emission — output spy is not called', () => {
    const outputSpy = vi.fn();
    provider.on('output', outputSpy);
    adapter.emit('output', { id: 'm', type: 'assistant', content: 'x', timestamp: Date.now() });
    expect(outputSpy).not.toHaveBeenCalled();
  });
});
