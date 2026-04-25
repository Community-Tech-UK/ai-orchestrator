import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  attachQuotaAutoRefresh,
  mapProviderTypeToQuotaId,
  _resetQuotaAutoRefreshForTesting,
} from './quota-auto-refresh';
import type { ProviderId } from '../../../../shared/types/provider-quota.types';

class FakeService {
  readonly calls: ProviderId[] = [];
  readonly refresh = vi.fn(async (provider: ProviderId) => {
    this.calls.push(provider);
  });
}

describe('mapProviderTypeToQuotaId', () => {
  it('maps Claude variants to "claude"', () => {
    expect(mapProviderTypeToQuotaId('claude-cli')).toBe('claude');
    expect(mapProviderTypeToQuotaId('anthropic-api')).toBe('claude');
  });

  it('maps OpenAI variants to "codex"', () => {
    expect(mapProviderTypeToQuotaId('openai')).toBe('codex');
    expect(mapProviderTypeToQuotaId('openai-compatible')).toBe('codex');
  });

  it('maps google to "gemini"', () => {
    expect(mapProviderTypeToQuotaId('google')).toBe('gemini');
  });

  it('maps copilot to "copilot"', () => {
    expect(mapProviderTypeToQuotaId('copilot')).toBe('copilot');
  });

  it('returns null for providers without a quota probe', () => {
    expect(mapProviderTypeToQuotaId('ollama')).toBeNull();
    expect(mapProviderTypeToQuotaId('amazon-bedrock')).toBeNull();
    expect(mapProviderTypeToQuotaId('azure')).toBeNull();
    expect(mapProviderTypeToQuotaId('cursor')).toBeNull();
  });
});

describe('attachQuotaAutoRefresh', () => {
  let adapter: EventEmitter;
  let service: FakeService;

  beforeEach(() => {
    _resetQuotaAutoRefreshForTesting();
    adapter = new EventEmitter();
    service = new FakeService();
  });

  it('triggers refresh on the spawned event', async () => {
    attachQuotaAutoRefresh(adapter, 'claude', { service });
    adapter.emit('spawned', 1234);
    // Allow microtask to drain the .catch() chain
    await Promise.resolve();
    expect(service.calls).toEqual(['claude']);
  });

  it('triggers refresh on the complete event', async () => {
    attachQuotaAutoRefresh(adapter, 'claude', { service });
    adapter.emit('complete', { ok: true });
    await Promise.resolve();
    expect(service.calls).toEqual(['claude']);
  });

  it('debounces repeated spawned events within the window', async () => {
    attachQuotaAutoRefresh(adapter, 'claude', { service, debounceMs: 1000 });
    adapter.emit('spawned', 1);
    adapter.emit('spawned', 2);
    adapter.emit('spawned', 3);
    await Promise.resolve();
    expect(service.calls).toEqual(['claude']);
  });

  it('debounces independently per event class', async () => {
    attachQuotaAutoRefresh(adapter, 'claude', { service, debounceMs: 1000 });
    adapter.emit('spawned', 1);
    adapter.emit('complete', { ok: true });
    await Promise.resolve();
    // Different event classes are debounced separately, so both fire
    expect(service.calls).toEqual(['claude', 'claude']);
  });

  it('debounces independently per provider', async () => {
    const adapter2 = new EventEmitter();
    attachQuotaAutoRefresh(adapter, 'claude', { service, debounceMs: 1000 });
    attachQuotaAutoRefresh(adapter2, 'codex', { service, debounceMs: 1000 });
    adapter.emit('spawned', 1);
    adapter2.emit('spawned', 2);
    await Promise.resolve();
    expect([...service.calls].sort()).toEqual(['claude', 'codex']);
  });

  it('re-fires after the debounce window elapses', async () => {
    vi.useFakeTimers();
    try {
      attachQuotaAutoRefresh(adapter, 'claude', { service, debounceMs: 1000 });
      adapter.emit('spawned', 1);
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
      adapter.emit('spawned', 2);
      await Promise.resolve();
      expect(service.calls).toEqual(['claude', 'claude']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a teardown that detaches listeners', async () => {
    const stop = attachQuotaAutoRefresh(adapter, 'claude', { service });
    stop();
    adapter.emit('spawned', 1);
    adapter.emit('complete', { ok: true });
    await Promise.resolve();
    expect(service.calls).toEqual([]);
  });

  it('is a no-op when providerId is null', async () => {
    const stop = attachQuotaAutoRefresh(adapter, null, { service });
    adapter.emit('spawned', 1);
    adapter.emit('complete', { ok: true });
    await Promise.resolve();
    expect(service.calls).toEqual([]);
    expect(typeof stop).toBe('function');
  });

  it('swallows refresh errors (never crashes the adapter)', async () => {
    const erroringService: FakeService = Object.assign(new FakeService(), {
      refresh: vi.fn(async () => { throw new Error('boom'); }),
    });
    attachQuotaAutoRefresh(adapter, 'claude', { service: erroringService });
    expect(() => adapter.emit('spawned', 1)).not.toThrow();
    // Drain the error-swallowing chain
    await Promise.resolve();
    await Promise.resolve();
  });
});
