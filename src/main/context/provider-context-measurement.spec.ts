import { describe, expect, it, vi } from 'vitest';
import { ProviderContextMeasurementService } from './provider-context-measurement';
describe('provider context measurement caching', () => {
  const instance = { id: 'i', sessionId: 's', requestCount: 1, restartEpoch: 0, adapterGeneration: 1 };
  const estimate = async () => ({ instanceId: 'i', computedAt: 0, buckets: [] });
  it('coalesces panel requests and measures only once per turn, then invalidates', async () => {
    const service = new ProviderContextMeasurementService();
    const adapter = { requestContextUsage: vi.fn(async () => ({ ok: true as const, payload: { totalTokens: 100, maxTokens: 1000, categories: [{ name: 'Messages', tokens: 100 }] } })) };
    const [first, second] = await Promise.all([service.measure(instance, adapter, estimate), service.measure(instance, adapter, estimate)]);
    expect(first.status).toBe('measured'); expect(second).toEqual(first); expect(adapter.requestContextUsage).toHaveBeenCalledTimes(1);
    await service.measure({ ...instance, requestCount: 2 }, adapter, estimate);
    expect(adapter.requestContextUsage).toHaveBeenCalledTimes(2);
  });
  it('maps not-running, unsupported, timeout and malformed replies without throwing', async () => {
    for (const code of ['not-running', 'timeout', 'cancelled', 'cli-error'] as const) {
      const reply = await new ProviderContextMeasurementService().measure(instance,
        { requestContextUsage: async () => ({ ok: false, code, message: code }) }, estimate);
      expect(reply.status).toBe(code === 'not-running' || code === 'timeout' ? code : 'error');
    }
    expect((await new ProviderContextMeasurementService().measure(instance, undefined, estimate)).status).toBe('not-running');
    expect((await new ProviderContextMeasurementService().measure(instance, {}, estimate)).status).toBe('not-supported');
    expect((await new ProviderContextMeasurementService().measure(instance, { requestContextUsage: async () => ({ ok: true, payload: {} }) }, estimate)).status).toBe('error');
  });
});
