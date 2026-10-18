import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { LocalAiGuardSnapshotSchema } from '../../shared/validation/local-ai-guard.schemas';
import { AuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { installLocalAiAuxiliaryRuntimeHooks } from './local-ai-auxiliary-bridge';
import { LocalAiGuardRuntime } from './local-ai-runtime';
import { registerLocalAiGuardHandlers } from '../ipc/handlers/local-ai-guard-handlers';
import { AuxiliarySlotBackoff } from '../rlm/auxiliary-slot-backoff';
import { getLocalAiAuxiliaryHooks } from './local-ai-auxiliary-bridge';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>() }));
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => ({ notify: mocks.notify }) }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => mocks.handlers.set(channel, handler), removeHandler: (channel: string) => mocks.handlers.delete(channel) } }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: (text: string) => text.length }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
function runtime(subscribe?: (listener: () => void) => () => void) {
  return new LocalAiGuardRuntime({
    targets: { list: () => [], findByEndpoint: () => undefined },
    health: { listIncidents: () => [], listRecoveryAttempts: () => [] },
    scheduler: { targetChanged: vi.fn(), stop: vi.fn(), subscribe },
    incidents: { dispose: vi.fn() }, approvals: { listPending: () => [], dispose: vi.fn() },
    engine: { aggregate: () => ({ state: 'not-configured', enrolled: 0, healthy: 0, degraded: 0, unavailable: 0, paused: 0 }) },
    routing: { authorizeFallback: async () => ({ allowed: true, disposition: 'allowed', policy: 'allow-silently', routingEventId: 'test' }), recordLocalCompletion: vi.fn() },
    activity: {}, probes: {}, recovery: {},
  } as never);
}
beforeEach(() => { mocks.notify.mockClear(); AuxiliaryLlmService._resetForTesting(); });
afterEach(() => vi.useRealTimers());
describe('helper backoff runtime bridge and retry IPC', () => {
  it.each(['deadline', 'periodic-refresh', 'snapshot-read'] as const)('expires published pauses through %s without claiming recovery', async path => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let periodic!: () => void;
    const guard = runtime(listener => { periodic = listener; return () => undefined; });
    const uninstall = installLocalAiAuxiliaryRuntimeHooks(guard);
    const backoff = new AuxiliarySlotBackoff(Date.now, (pauses, transition) => getLocalAiAuxiliaryHooks().helperBackoffChanged?.(pauses, transition));
    const sendToRenderer = vi.fn();
    const cleanup = registerLocalAiGuardHandlers({ getRuntime: () => guard, windowManager: { sendToRenderer }, ensureTrustedSender: () => null });
    try {
      backoff.recordFailure('compression'); backoff.recordFailure('compression');
      const before = guard.revision;
      if (path === 'deadline') await vi.advanceTimersByTimeAsync(60000);
      else { vi.setSystemTime(61000); if (path === 'periodic-refresh') periodic(); }
      const response = await mocks.handlers.get(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)!({}, undefined) as { data: unknown };
      expect(LocalAiGuardSnapshotSchema.parse(response.data).helperPauses).toEqual([]);
      expect(guard.revision).not.toBe(before);
      expect(backoff.active('compression')).toBeUndefined();
      await Promise.resolve();
      expect(sendToRenderer.mock.calls.at(-1)?.[1].helperPauses).toEqual([]);
      expect(mocks.notify.mock.calls.map(call => call[0].kind)).toEqual(['local-ai-helper-paused']);
      // Retry eligibility is not recovery. A failed retry keeps the delay history.
      backoff.recordFailure('compression');
      expect(guard.helperPauses[0]?.pausedUntil).toBe(181000);
      backoff.retryNow('compression'); expect(guard.helperPauses).toEqual([]);
      backoff.recordSuccess('compression');
      expect(mocks.notify.mock.calls.map(call => call[0].kind)).toEqual(['local-ai-helper-paused', 'local-ai-helper-resumed']);
    } finally { cleanup(); uninstall(); guard.dispose(); }
  });
  it('publishes pauses in snapshots, bumps revisions and sends one notice per outage and recovery', async () => {
    const guard = runtime(); const uninstall = installLocalAiAuxiliaryRuntimeHooks(guard);
    const service = AuxiliaryLlmService.getInstance(); service.configure(DEFAULT_SETTINGS);
    const resolve = vi.spyOn(service as unknown as { resolveEndpointForSlot: () => Promise<unknown> }, 'resolveEndpointForSlot').mockResolvedValue(null);
    await service.generate('compression', 'system', 'user'); await service.generate('compression', 'system', 'user');
    const revision = guard.revision; expect(guard.helperPauses).toMatchObject([{ slot: 'compression', failures: 2 }]);
    await service.generate('compression', 'system', 'user');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({ kind: 'local-ai-helper-paused', title: 'Local helper model offline', fingerprintFields: { slot: 'compression', startedAt: expect.any(Number) } });
    const cleanup = registerLocalAiGuardHandlers({ getRuntime: () => guard, windowManager: { sendToRenderer: vi.fn() }, ensureTrustedSender: () => null });
    const response = await mocks.handlers.get(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)!({}, undefined) as { data: unknown };
    expect(LocalAiGuardSnapshotSchema.parse(response.data).helperPauses).toHaveLength(1);
    service.retryHelperNow('compression'); expect(guard.helperPauses).toEqual([]); expect(guard.revision).not.toBe(revision);
    resolve.mockResolvedValue({ endpoint: { id: 'local', provider: 'ollama', source: 'localhost', label: 'Local' }, model: 'helper' });
    vi.spyOn(service as unknown as { callEndpoint: () => Promise<string> }, 'callEndpoint').mockResolvedValue('summary');
    await service.generate('compression', 'system', 'user');
    expect(mocks.notify.mock.calls.map(call => call[0].kind)).toEqual(['local-ai-helper-paused', 'local-ai-helper-resumed']);
    cleanup(); uninstall(); guard.dispose();
  });
  it('validates trusted Retry now IPC and clears a helper pause', async () => {
    const guard = runtime(); const uninstall = installLocalAiAuxiliaryRuntimeHooks(guard);
    const service = AuxiliaryLlmService.getInstance(); service.configure(DEFAULT_SETTINGS);
    vi.spyOn(service as unknown as { resolveEndpointForSlot: () => Promise<null> }, 'resolveEndpointForSlot').mockResolvedValue(null);
    await service.generate('titleGeneration', 's', 'u'); await service.generate('titleGeneration', 's', 'u');
    const trust = vi.fn(() => null);
    const cleanup = registerLocalAiGuardHandlers({ getRuntime: () => guard, windowManager: { sendToRenderer: vi.fn() }, ensureTrustedSender: trust });
    const handler = mocks.handlers.get(IPC_CHANNELS.LOCAL_AI_GUARD_RETRY_HELPER_NOW)!;
    await expect(handler({}, { slot: 'made-up' })).resolves.toMatchObject({ success: false });
    await expect(handler({}, { slot: 'titleGeneration' })).resolves.toMatchObject({ success: true, data: { helperPauses: [] } });
    expect(trust).toHaveBeenCalledWith({}, IPC_CHANNELS.LOCAL_AI_GUARD_RETRY_HELPER_NOW);
    cleanup(); uninstall(); guard.dispose();
  });
});
