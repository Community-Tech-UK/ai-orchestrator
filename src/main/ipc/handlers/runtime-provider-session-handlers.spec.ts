import { Subject } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../../instance/instance-manager';
import { PROVIDER_RESPONSE_IDLE_TIMEOUT_MS } from '../../plugins/plugin-worker-host';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), list: vi.fn(), configs: vi.fn(), create: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../plugins/plugin-manager', () => ({ getOrchestratorPluginManager: () => ({
  listPlugins: mocks.list,
  withProviderSession: (_folder: string, operation: () => Promise<unknown>) => operation(),
}) }));
vi.mock('../../providers/provider-instance-manager', () => ({ getProviderInstanceManager: () => ({ getEnabledProviders: mocks.configs, createProvider: mocks.create }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ error() {}, warn() {} }) }));

import { registerRuntimeProviderSessionHandlers } from './runtime-provider-session-handlers';

describe('runtime provider session boundary', () => {
  let events: Subject<ProviderRuntimeEventEnvelope>;
  let adapter: ReturnType<typeof makeAdapter>;
  const trust = vi.fn(() => null as { success: false; error: { code: string; message: string; timestamp: number } } | null);
  function emit(event: ProviderRuntimeEvent): void {
    events.next({ event, eventId: randomUUID(), seq: 0, timestamp: 1, provider: 'plugin:proof', instanceId: 'fixture-instance' });
  }
  function makeAdapter() {
    return {
      events$: events, capabilities: { permissionPrompts: false, subAgents: false },
      getCapabilities: () => ({ toolExecution: false }),
      initialize: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(async () => { emit({ kind: 'output', content: 'answer' }); emit({ kind: 'complete' }); }),
    };
  }
  function invoke(channel: string, payload: unknown) {
    const listener = mocks.handle.mock.calls.find(([name]) => name === channel)?.[1];
    if (!listener) throw new Error('Handler missing');
    return listener({} as IpcMainInvokeEvent, payload);
  }
  const payload = () => ({ workingDirectory: process.cwd(), provider: 'plugin:proof', message: 'hello' });

  beforeEach(() => {
    vi.clearAllMocks();
    events = new Subject();
    adapter = makeAdapter();
    mocks.create.mockReturnValue(adapter);
    mocks.list.mockResolvedValue({ plugins: [{ slot: 'provider', providerIds: ['plugin:proof'], loadReport: { ready: true } }] });
    mocks.configs.mockReturnValue([{ type: 'plugin:proof', name: 'Fixture' }, { type: 'plugin:foreign', name: 'Other folder' }]);
    trust.mockReturnValue(null);
    registerRuntimeProviderSessionHandlers({ instanceManager: {} as InstanceManager, ensureTrustedSender: trust });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('rejects untrusted senders before loading packages or dispatching work', async () => {
    const denial = { success: false as const, error: { code: 'DENIED', message: 'Denied', timestamp: 1 } };
    trust.mockReturnValue(denial);
    expect(await invoke('runtime-provider:send', payload())).toEqual(denial);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('validates input before loading packages', async () => {
    expect(await invoke('runtime-provider:send', { ...payload(), provider: 'claude' })).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists only ready provider packages activated in the chosen folder', async () => {
    expect(await invoke('runtime-provider:list', { workingDirectory: process.cwd() })).toMatchObject({
      success: true, data: { providers: [{ provider: 'plugin:proof', name: 'Fixture' }], failures: [] },
    });
    expect(await invoke('runtime-provider:send', { ...payload(), provider: 'plugin:foreign' })).toMatchObject({ success: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('waits for normalized completion, returns output and terminates the session', async () => {
    expect(await invoke('runtime-provider:send', payload())).toMatchObject({ success: true, data: { content: 'answer' } });
    expect(adapter.initialize).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: process.cwd() }));
    expect(adapter.terminate).toHaveBeenCalledOnce();
    expect(events.observed).toBe(false);
  });

  it('does not treat partial output as completion', async () => {
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => { dispatched = resolve; });
    adapter.sendMessage.mockImplementation(async () => { emit({ kind: 'output', content: 'partial' }); dispatched(); });
    let settled = false;
    const request = invoke('runtime-provider:send', payload()).then((value: unknown) => { settled = true; return value; });
    await sent;
    await Promise.resolve();
    expect(settled).toBe(false);
    emit({ kind: 'complete' });
    expect(await request).toMatchObject({ success: true, data: { content: 'partial' } });
    expect(adapter.terminate).toHaveBeenCalledOnce();
  });

  it('allows a first answer after thirty seconds and keeps an active stream alive beyond five minutes', async () => {
    vi.useFakeTimers();
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => { dispatched = resolve; });
    adapter.sendMessage.mockImplementation(async () => { dispatched(); });
    let settled = false;
    const request = invoke('runtime-provider:send', payload()).then((value: unknown) => { settled = true; return value; });
    await sent;
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(settled).toBe(false);
      emit({ kind: 'output', content: 'Slow ' });
      await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
      emit({ kind: 'output', content: 'answer' });
      await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      emit({ kind: 'complete' });
      expect(await request).toMatchObject({ success: true, data: { content: 'Slow answer' } });
      expect(adapter.terminate).toHaveBeenCalledOnce();
      expect(events.observed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      emit({ kind: 'complete' });
      await request;
    }
  });

  it('fails and tears down after five minutes of inactivity following partial output', async () => {
    vi.useFakeTimers();
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => { dispatched = resolve; });
    adapter.sendMessage.mockImplementation(async () => { dispatched(); });
    const request = invoke('runtime-provider:send', payload());
    await sent;
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS - 1);
    emit({ kind: 'output', content: 'partial' });
    await vi.advanceTimersByTimeAsync(PROVIDER_RESPONSE_IDLE_TIMEOUT_MS);
    expect(await request).toMatchObject({
      success: false, error: { message: 'The provider has not responded for five minutes.' },
    });
    expect(adapter.terminate).toHaveBeenCalledOnce();
    expect(events.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails truthfully and tears down when the provider reports an error after partial output', async () => {
    adapter.sendMessage.mockImplementation(async () => { emit({ kind: 'output', content: 'partial' }); emit({ kind: 'error', message: 'fixture failure' }); });
    expect(await invoke('runtime-provider:send', payload())).toMatchObject({ success: false });
    expect(adapter.terminate).toHaveBeenCalledOnce();
    expect(events.observed).toBe(false);
  });

  it('cleans up after failed initialization and rejects an empty completed answer', async () => {
    adapter.initialize.mockRejectedValueOnce(new Error('fixture init failure'));
    expect(await invoke('runtime-provider:send', payload())).toMatchObject({ success: false });
    expect(adapter.terminate).toHaveBeenCalledOnce();
    adapter.sendMessage.mockImplementation(async () => { emit({ kind: 'complete' }); });
    expect(await invoke('runtime-provider:send', payload())).toMatchObject({ success: false });
    expect(adapter.terminate).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed worker output instead of presenting it as an assistant response', async () => {
    adapter.sendMessage.mockImplementation(async () => {
      emit({ kind: 'output', content: 123 } as unknown as ProviderRuntimeEvent);
      emit({ kind: 'complete' });
    });
    expect(await invoke('runtime-provider:send', payload())).toMatchObject({ success: false });
    expect(adapter.terminate).toHaveBeenCalledOnce();
  });
});
