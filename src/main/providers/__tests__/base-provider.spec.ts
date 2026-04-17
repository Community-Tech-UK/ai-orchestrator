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
