import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Writable } from 'stream';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { Instance } from '../../../shared/types/instance.types';
import { InstanceCommunicationManager } from '../../instance/instance-communication';
import { getSessionAdmissionService, _resetSessionAdmissionServiceForTesting } from '../../session/session-admission-service';
import { SessionAdmissionStore } from '../../session/session-admission-store';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';

let db: Database.Database;
vi.mock('../../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => db as unknown as SqliteDriver }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));
vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: vi.fn(() => false) }));

beforeEach(() => {
  db = new Database(':memory:');
  SessionAdmissionStore._resetForTesting();
  _resetSessionAdmissionServiceForTesting();
});
afterEach(() => {
  _resetSessionAdmissionServiceForTesting();
  SessionAdmissionStore._resetForTesting();
  db.close();
  vi.restoreAllMocks();
});

async function fixture(config: Partial<ConstructorParameters<typeof TestAcpCliAdapter>[1]> = {}, initialize = true) {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', ...config });
  if (initialize) await adapter.spawn();
  const instance = { id: 'disposable-acp', provider: 'opencode', status: 'idle', sessionId: 'sess-acp-1',
    providerSessionId: 'sess-acp-1', parentId: null, restartCount: 0, errorCount: 0, restartEpoch: 0,
    adapterGeneration: 1, requestCount: 3, lastActivity: 0, outputBuffer: [] } as unknown as Instance;
  adapter.on('error', () => undefined);
  adapter.on('status', (status) => { instance.status = status; });
  const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
    processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
    ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
  const service = getSessionAdmissionService();
  return { proc, adapter, instance, manager, delivered: vi.spyOn(service, 'markDelivered'), failed: vi.spyOn(service, 'markFailed'),
    rows: () => SessionAdmissionStore.getInstance(db as unknown as SqliteDriver).list({ instanceId: instance.id }) };
}

describe('ACP actual input receipt persistence', () => {
  it.each([1, 16384])('fails an asynchronous native EPIPE receipt at highWaterMark %s without taking exit recovery', async (highWaterMark) => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const errors = vi.fn();
    adapter.on('error', errors);
    const streamErrors: Error[] = [];
    const failure = Object.assign(new Error('synthetic asynchronous EPIPE'), { code: 'EPIPE' });
    const stdin = new Writable({ highWaterMark, write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)); } });
    stdin.on('error', (error) => streamErrors.push(error));
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    const admit = vi.fn();
    try {
      await expect(manager.sendInput(instance.id, 'synthetic continuation', undefined, undefined,
        { autoContinuation: true, signal: new AbortController().signal, beforeProviderDispatch: admit })).rejects.toBe(failure);
      expect(admit).toHaveBeenCalledOnce();
      expect(streamErrors).toEqual([failure]);
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
      expect(errors).not.toHaveBeenCalled();
      expect(instance.status).not.toBe('error');
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null, errorText: failure.message });
    } finally { proc.exit(); }
  });

  it('fails a receipt when process exit precedes the native callback, without duplicate recovery', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const errors = vi.fn();
    adapter.on('error', errors);
    const stdin = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => { proc.exit(1); callback(); }); } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      await expect(manager.sendInput(instance.id, 'synthetic input')).rejects.toMatchObject({ code: 'EPIPE' });
      expect(errors).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });

  it.each(['stop', 'manual-input'] as const)('keeps a late failed write quiet after %s revokes dispatch ownership', async (revocation) => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const controller = new AbortController();
    const errors = vi.fn();
    const statuses: string[] = [];
    adapter.on('error', errors);
    adapter.on('status', (status) => statuses.push(status));
    let complete!: (error?: Error | null) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const nativeWrites: string[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) { nativeWrites.push(chunk.toString()); complete = callback; start(); } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      const pending = manager.sendInput(instance.id, 'synthetic cancelled input', undefined, undefined,
        { autoContinuation: true, signal: controller.signal, beforeProviderDispatch: () => undefined });
      await started;
      if (revocation === 'stop') controller.abort();
      else instance.requestCount++;
      instance.status = 'idle';
      complete(new Error('synthetic late failed native callback'));
      await expect(pending).resolves.toBeUndefined();
      expect(nativeWrites).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
      expect(statuses).toEqual(['busy']);
      expect(instance.status).toBe('idle');
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });

  it('retains acknowledged delivery when an aborted prompt is intentionally cancelled', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const controller = new AbortController();
    const errors = vi.fn();
    adapter.on('error', errors);
    let complete!: (error?: Error | null) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const methods: string[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      methods.push(request.method);
      if (request.method === 'session/prompt') { complete = callback; start(); }
      else callback();
    } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      const pending = manager.sendInput(instance.id, 'synthetic eventually accepted input', undefined, undefined,
        { autoContinuation: true, signal: controller.signal, beforeProviderDispatch: () => undefined });
      await started;
      controller.abort();
      const interrupt = adapter.interrupt();
      expect(interrupt).toMatchObject({ status: 'accepted' });
      complete();
      await expect(interrupt.completion).resolves.toMatchObject({ status: 'interrupted' });
      await expect(pending).resolves.toBeUndefined();
      expect(methods).toEqual(['session/prompt', 'session/cancel']);
      expect(errors).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(rows()[0]).toMatchObject({ state: 'delivered', deliveredAt: expect.any(Number) });
    } finally { proc.exit(); }
  });

  it('keeps a bounded native write timeout quiet after Stop cancels dispatch', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const controller = new AbortController();
    const errors = vi.fn();
    const statuses: string[] = [];
    adapter.on('error', errors);
    adapter.on('status', (status) => statuses.push(status));
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const stdin = new Writable({ write() { start(); /* no native acknowledgement */ } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      const pending = manager.sendInput(instance.id, 'synthetic cancelled timeout', undefined, undefined,
        { autoContinuation: true, signal: controller.signal, beforeProviderDispatch: () => undefined });
      await started;
      controller.abort();
      instance.status = 'idle';
      await expect(pending).resolves.toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
      expect(statuses).toEqual(['busy']);
      expect(instance.status).toBe('idle');
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  }, 10_000);

  it('fails a receipt on the original process error with only the process listener reporting it', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const errors = vi.fn();
    adapter.on('error', errors);
    const failure = new Error('synthetic process failure before acknowledgement');
    const stdin = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => { proc.emit('error', failure); callback(); }); } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      await expect(manager.sendInput(instance.id, 'synthetic input')).rejects.toBe(failure);
      expect(errors).toHaveBeenCalledExactlyOnceWith(failure);
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });

  it('does not let a response arriving before a failed callback turn a failed write into delivery', async () => {
    const { proc, instance, manager, rows, delivered, failed } = await fixture();
    const failure = new Error('synthetic callback rejection after response');
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      proc.respond(JSON.parse(chunk.toString()).id, { stopReason: 'end_turn' });
      queueMicrotask(() => callback(failure));
    } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      await expect(manager.sendInput(instance.id, 'synthetic input')).rejects.toBe(failure);
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });

  it.each(['provider-error', 'agent-exit'] as const)('retains delivery after native acknowledgement followed by %s', async (ending) => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    const errors = vi.fn();
    adapter.on('error', errors);
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const id = JSON.parse(chunk.toString()).id;
      callback();
      setImmediate(() => {
        if (ending === 'agent-exit') proc.exit(1);
        else proc.respondError(id, -32000, 'synthetic delivered turn failure');
      });
    } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    try {
      await expect(manager.sendInput(instance.id, 'synthetic accepted input')).resolves.toBeUndefined();
      expect(delivered).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(rows()[0]).toMatchObject({ state: 'delivered', deliveredAt: expect.any(Number) });
      expect(errors).toHaveBeenCalledTimes(ending === 'agent-exit' ? 0 : 1);
    } finally { proc.exit(); }
  });

  it('fails an ordinary receipt when native startup refuses model selection before a prompt write', async () => {
    const { proc, instance, manager, rows, delivered, failed } = await fixture({ generationBudget: {
      model: 'xiaomi-token-plan/mimo-v2.6-pro', combinedOutputTokens: 1024, reasoningBudgetSupported: false,
    } }, false);
    try {
      await expect(manager.sendInput(instance.id, 'synthetic ordinary prompt')).rejects.toThrow('Unable to confirm the selected model');
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });

  it('persists a failed receipt without a delivered timestamp when native stdin rejects', async () => {
    const { proc, instance, manager, rows, delivered, failed } = await fixture();
    const admit = vi.fn();
    proc.stdin.write = () => { throw new Error('synthetic native pipe rejection'); };
    try {
      await expect(manager.sendInput(instance.id, 'synthetic continuation', undefined, undefined,
        { autoContinuation: true, signal: new AbortController().signal, beforeProviderDispatch: admit })).rejects.toThrow('synthetic native pipe rejection');
      expect(admit).toHaveBeenCalledOnce();
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null, errorText: 'synthetic native pipe rejection' });
    } finally { proc.exit(); }
  });

  it('retains intentional cancellation semantics after input actually reaches the provider', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    try {
      const pending = manager.sendInput(instance.id, 'synthetic written request');
      await proc.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
      expect(adapter.interrupt()).toMatchObject({ status: 'accepted' });
      await expect(pending).resolves.toBeUndefined();
      expect(delivered).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ state: 'delivered', deliveredAt: expect.any(Number) });
    } finally { proc.exit(); }
  });

  it('joins the real event owner once when a rejected native write also emits an adapter error', async () => {
    const { proc, adapter, instance, manager, rows, delivered, failed } = await fixture();
    manager.setupAdapterEvents(instance.id, adapter);
    const errors = vi.fn();
    adapter.on('error', errors);
    const admit = vi.fn();
    proc.stdin.write = () => { throw new Error('synthetic native pipe rejection'); };
    try {
      await expect(manager.sendInput(instance.id, 'synthetic continuation', undefined, undefined,
        { autoContinuation: true, signal: new AbortController().signal, beforeProviderDispatch: admit })).rejects.toThrow('synthetic native pipe rejection');
      expect(admit).toHaveBeenCalledOnce();
      expect(errors).toHaveBeenCalledOnce();
      expect(instance.errorCount).toBe(1);
      expect(delivered).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { proc.exit(); }
  });
});
