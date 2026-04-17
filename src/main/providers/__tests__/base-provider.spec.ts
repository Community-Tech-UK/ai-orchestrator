import { describe, it, expect } from 'vitest';
import { BaseProvider } from '../provider-interface';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderConfig, ProviderStatus, ProviderSessionOptions, ProviderCapabilities } from '@shared/types/provider.types';
import type { ProviderName, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

class TestProvider extends BaseProvider {
  readonly provider: ProviderName = 'claude';
  readonly capabilities: ProviderAdapterCapabilities = {
    interruption: true, permissionPrompts: true, sessionResume: true,
    streamingOutput: true, usageReporting: true, subAgents: true,
  };
  getType() { return 'claude-cli' as const; }
  getCapabilities(): ProviderCapabilities {
    return { toolExecution: true, streaming: true, multiTurn: true, vision: false, fileAttachments: false, functionCalling: true, builtInCodeTools: true };
  }
  async checkStatus(): Promise<ProviderStatus> { return { type: 'claude-cli', available: true, authenticated: true }; }
  async initialize(_opts: ProviderSessionOptions): Promise<void> { void _opts; }
  async sendMessage(_m: string): Promise<void> { void _m; }
  async terminate(): Promise<void> { /* no-op */ }
}

const makeCfg = (): ProviderConfig => ({ type: 'claude-cli', name: 'test', enabled: true });
const makeProvider = (): TestProvider => {
  const p = new TestProvider(makeCfg());
  (p as unknown as { instanceId: string }).instanceId = 'test-instance';
  return p;
};

describe('BaseProvider.events$', () => {
  it('exposes an Observable of envelopes', async () => {
    const cfg: ProviderConfig = { type: 'claude-cli', name: 'test', enabled: true };
    const p = new TestProvider(cfg);
    // Envelope schema requires non-empty instanceId; set one so the validator passes.
    (p as unknown as { instanceId: string }).instanceId = 'test-instance';
    const received: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => received.push(e));
    // Nothing emitted yet
    expect(received).toHaveLength(0);
    // Manually push
    (p as unknown as { pushEvent: (e: unknown) => void }).pushEvent({ kind: 'status', status: 'busy' });
    await new Promise(r => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0].event).toMatchObject({ kind: 'status', status: 'busy' });
  });
});

describe('BaseProvider lifecycle helpers', () => {
  it('pushStatus emits a status envelope', async () => {
    const p = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushStatus: (s: string) => void }).pushStatus('idle');
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'status', status: 'idle' });
  });

  it('pushExit emits an exit envelope', async () => {
    const p = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushExit: (c: number | null, s: string | null) => void }).pushExit(0, null);
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'exit', code: 0, signal: null });
  });

  it('pushError emits an error envelope', async () => {
    const p = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushError: (msg: string, recoverable?: boolean) => void }).pushError('oops', true);
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toMatchObject({ kind: 'error', message: 'oops', recoverable: true });
  });

  it('pushSpawned / pushComplete emit their kinds', async () => {
    const p = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    const anyP = p as unknown as {
      pushSpawned: (pid: number) => void;
      pushComplete: (p: { tokensUsed?: number; costUsd?: number; durationMs?: number }) => void;
    };
    anyP.pushSpawned(1234);
    anyP.pushComplete({ tokensUsed: 10, durationMs: 500 });
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'spawned', pid: 1234 });
    expect(events[1].event).toMatchObject({ kind: 'complete', tokensUsed: 10, durationMs: 500 });
  });

  it('seq is monotonic per instance and resets on new instance', async () => {
    const p1 = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p1.events$.subscribe(e => events.push(e));
    (p1 as unknown as { pushStatus: (s: string) => void }).pushStatus('a');
    (p1 as unknown as { pushStatus: (s: string) => void }).pushStatus('b');
    await new Promise(r => setImmediate(r));
    expect(events.map(e => e.seq)).toEqual([0, 1]);

    const p2 = makeProvider();
    const events2: ProviderRuntimeEventEnvelope[] = [];
    p2.events$.subscribe(e => events2.push(e));
    (p2 as unknown as { pushStatus: (s: string) => void }).pushStatus('a');
    await new Promise(r => setImmediate(r));
    expect(events2[0].seq).toBe(0);
  });
});

describe('BaseProvider subscribe-to-self bridge', () => {
  it('legacy emit() produces an envelope on events$', async () => {
    const p = makeProvider();
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    p.emit('status', 'busy');
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toMatchObject({ kind: 'status', status: 'busy' });
  });
});
