import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Writable } from 'stream';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { Instance } from '../../../shared/types/instance.types';
import { InstanceCommunicationManager } from '../../instance/instance-communication';
import { InterruptRespawnHandler } from '../../instance/lifecycle/interrupt-respawn-handler';
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

async function fixture() {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', requestTimeoutMs: 10_000 });
  await adapter.spawn();
  const instance = { id: 'ordinary-acp-stop', provider: 'opencode', status: 'idle', sessionId: 'sess-acp-1',
    providerSessionId: 'sess-acp-1', parentId: null, restartCount: 0, errorCount: 0, restartEpoch: 0,
    adapterGeneration: 1, requestCount: 3, lastActivity: 0, outputBuffer: [], contextUsage: { used: 0, total: 100_000 } } as unknown as Instance;
  const errors = vi.fn();
  const statuses: string[] = [];
  const transitions: string[] = [];
  const providerErrors: unknown[] = [];
  const recovery = vi.fn(async () => undefined);
  adapter.on('error', errors);
  adapter.on('status', (status) => statuses.push(status));
  const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
    processOrchestrationOutput: () => undefined, onInterruptedExit: recovery,
    ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined,
    emitProviderRuntimeEvent: (_id, event) => { if (event.kind === 'error') providerErrors.push(event); },
    onInterruptSettled: (id) => handler.noteInterruptSettled(id) });
  // InstanceManager -> InstanceLifecycleManager wires these same delegates.
  const handler = new InterruptRespawnHandler({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: () => undefined, deleteAdapter: () => undefined, queueUpdate: () => undefined,
    markInterrupted: (id) => manager.markInterrupted(id), clearInterrupted: (id) => manager.clearInterrupted(id),
    addToOutputBuffer: (target, message) => manager.addToOutputBuffer(target, message),
    setupAdapterEvents: (id, target) => manager.setupAdapterEvents(id, target),
    transitionState: (target, status) => { transitions.push(status); target.status = status; },
    getAdapterRuntimeCapabilities: () => adapter.getRuntimeCapabilities(), resolveCliTypeForInstance: async () => 'opencode',
    getMcpConfig: () => [], getPermissionHookPath: () => undefined,
    waitForResumeHealth: async () => true, waitForAdapterWritable: async () => true,
    buildReplayContinuityMessage: () => '', buildFallbackHistory: async () => '',
    applyRecoveryRespawn: async () => { recovery(); throw new Error('Unexpected recovery after ACP Stop'); },
    emitOutput: () => undefined });
  manager.setupAdapterEvents(instance.id, adapter);
  const cleanup = vi.spyOn(manager, 'forceCleanupAdapter');
  const service = getSessionAdmissionService();
  return { proc, adapter, instance, manager, handler, errors, statuses, transitions, providerErrors, recovery, cleanup,
    delivered: vi.spyOn(service, 'markDelivered'), failed: vi.spyOn(service, 'markFailed'),
    rows: () => service.listAdmissions({ instanceId: instance.id }) };
}

function heldPrompt(proc: ReturnType<typeof createInitializedAgentHarness>, respondBeforeStop = false) {
  const submitted: string[] = [];
  const native: string[] = [];
  let complete!: (error?: Error | null) => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as { method: string; id: string };
    const method = request.method;
    native.push(method);
    if (method === 'session/prompt') {
      complete = callback;
      if (respondBeforeStop) proc.respond(request.id, { stopReason: 'end_turn' });
      start();
    }
    else callback();
  } });
  const write = stdin.write.bind(stdin);
  vi.spyOn(stdin, 'write').mockImplementation((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    submitted.push(JSON.parse(chunk.toString()).method);
    return typeof encodingOrCallback === 'string' ? write(chunk, encodingOrCallback, callback) : write(chunk, encodingOrCallback);
  });
  (proc as unknown as { stdin: Writable }).stdin = stdin;
  return { started, submitted, native, complete: (error?: Error) => complete(error) };
}

describe('ordinary ACP Stop while native input is pending', () => {
  it.each(['EIO', 'response-before-stop', 'write-timeout'] as const)('keeps failed receipt and lifecycle owner quiet after %s without dispatch controls', async (failureMode) => {
    const f = await fixture();
    const input = heldPrompt(f.proc, failureMode === 'response-before-stop');
    const nativeFailure = Object.assign(new Error('synthetic late stopped EIO'), { code: 'EIO' });
    try {
      const sending = f.manager.sendInput(f.instance.id, 'synthetic ordinary stopped turn');
      await input.started;
      expect(f.handler.interrupt(f.instance.id, 'renderer-ipc')).toBe(true);
      expect(f.instance.status).toBe('interrupting');
      if (failureMode !== 'write-timeout') input.complete(nativeFailure);
      await expect(sending).rejects.toMatchObject({ name: 'AbortError', cause: failureMode === 'write-timeout'
        ? expect.objectContaining({ message: 'stdin write timeout after 5000ms — process may be stuck' }) : nativeFailure });
      await vi.waitFor(() => expect(f.instance.respawnPromise).toBeUndefined());
      expect(input.submitted).toEqual(['session/prompt', 'session/cancel']);
      expect(input.native).toEqual(['session/prompt']);
      expect(f.errors).not.toHaveBeenCalled();
      expect(f.statuses).toEqual(['busy']);
      expect(f.providerErrors).toEqual([]);
      expect(f.cleanup).not.toHaveBeenCalled();
      expect(f.recovery).not.toHaveBeenCalled();
      expect(f.transitions).toEqual(['interrupting', 'cancelling', 'idle']);
      expect(f.instance).toMatchObject({ status: 'idle', interruptPhase: 'completed', lastTurnOutcome: 'interrupted' });
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.failed).toHaveBeenCalledOnce();
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0]).toMatchObject({ state: 'failed', deliveredAt: null });
    } finally { f.handler.noteInterruptSettled(f.instance.id); f.manager.cleanupCircuitBreaker(f.instance.id); f.proc.exit(); }
  }, 10_000);

  it('retains delivered receipt when the pending native callback succeeds after ordinary Stop', async () => {
    const f = await fixture();
    const input = heldPrompt(f.proc);
    try {
      const sending = f.manager.sendInput(f.instance.id, 'synthetic accepted stopped turn');
      await input.started;
      expect(f.handler.interrupt(f.instance.id, 'renderer-ipc')).toBe(true);
      input.complete();
      await expect(sending).resolves.toBeUndefined();
      await vi.waitFor(() => expect(f.instance.respawnPromise).toBeUndefined());
      expect(input.submitted).toEqual(['session/prompt', 'session/cancel']);
      expect(input.native).toEqual(['session/prompt', 'session/cancel']);
      expect(f.errors).not.toHaveBeenCalled();
      expect(f.providerErrors).toEqual([]);
      expect(f.statuses).toEqual(['busy', 'idle']);
      expect(f.cleanup).not.toHaveBeenCalled();
      expect(f.recovery).not.toHaveBeenCalled();
      expect(f.instance).toMatchObject({ status: 'idle', interruptPhase: 'completed', lastTurnOutcome: 'interrupted' });
      expect(f.delivered).toHaveBeenCalledOnce();
      expect(f.failed).not.toHaveBeenCalled();
      expect(f.rows()[0]).toMatchObject({ state: 'delivered', deliveredAt: expect.any(Number) });
    } finally { f.handler.noteInterruptSettled(f.instance.id); f.manager.cleanupCircuitBreaker(f.instance.id); f.proc.exit(); }
  });

  it('reports the original EIO on a subsequent ordinary turn instead of inheriting prior Stop intent', async () => {
    const f = await fixture();
    const input = heldPrompt(f.proc);
    try {
      const stopped = f.manager.sendInput(f.instance.id, 'synthetic stopped predecessor');
      await input.started;
      expect(f.handler.interrupt(f.instance.id, 'renderer-ipc')).toBe(true);
      input.complete(new Error('synthetic predecessor write failure'));
      await expect(stopped).rejects.toMatchObject({ name: 'AbortError', cause: { message: 'synthetic predecessor write failure' } });
      await vi.waitFor(() => expect(f.instance.respawnPromise).toBeUndefined());
      expect(f.errors).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
      const original = Object.assign(new Error('synthetic new ordinary EIO'), { code: 'EIO' });
      const nextMethods: string[] = [];
      (f.proc as unknown as { stdin: Writable }).stdin = new Writable({ write(chunk, _encoding, callback) {
        nextMethods.push(JSON.parse(chunk.toString()).method);
        queueMicrotask(() => callback(original));
      } });
      f.instance.requestCount++;
      await expect(f.manager.sendInput(f.instance.id, 'synthetic new ordinary turn')).rejects.toBe(original);
      expect(nextMethods).toEqual(['session/prompt']);
      expect(f.errors).toHaveBeenCalledExactlyOnceWith(original);
      expect(f.providerErrors).toHaveLength(1);
      expect(f.statuses).toEqual(['busy', 'busy', 'error']);
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.failed).toHaveBeenCalledTimes(2);
      expect(f.rows()).toHaveLength(2);
      expect(f.rows().every((row) => row.state === 'failed' && row.deliveredAt === null)).toBe(true);
      // The later uncancelled EIO keeps its existing event-owned cleanup.
      expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.instance.id);
      expect(f.recovery).not.toHaveBeenCalled();
    } finally { f.handler.noteInterruptSettled(f.instance.id); f.manager.cleanupCircuitBreaker(f.instance.id); f.proc.exit(); }
  });
});
