import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Writable } from 'node:stream';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { LogManager } from '../logging/logger';
import { InputFormatter } from '../cli/input-formatter';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../cli/adapters/acp-cli-adapter.test-helpers';
import { InstanceCommunicationManager } from './instance-communication';
import { settleExitRecoveryFailure } from './instance-communication-recovery-safety';
import { InstanceCommunicationOverflowPolicy } from './instance-communication-overflow-policy';
import { InstanceCommunicationOverflowTracker } from './instance-communication-overflow-tracker';
import { dispatchInstanceLifecycleHook } from './instance-lifecycle-hooks';
import { deferExitToRecoveryOwner, scheduleSuppressedAutoRespawnRetry } from './instance-communication-recent-respawn-retry';
import { getSessionMutex, _resetSessionMutexForTesting } from '../session/session-mutex';
import type { HookManager } from '../hooks/hook-manager';
import { getSessionAdmissionService, _resetSessionAdmissionServiceForTesting } from '../session/session-admission-service';
import { SessionAdmissionStore } from '../session/session-admission-store';

const logging = vi.hoisted(() => ({ manager: null as LogManager | null }));
vi.mock('../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging/logger')>();
  const manager = new actual.LogManager({ enableConsole: false, enableFile: false, globalLevel: 'debug' });
  logging.manager = manager;
  return { ...actual, getLogger: (subsystem: string) => manager.getLogger(subsystem) };
});
let db: Database.Database;
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => db as unknown as SqliteDriver }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));
vi.mock('../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: vi.fn(() => false) }));

const source = 'LOCAL_TEST_SOURCE_SENTINEL';
const title = `echo ${source}`;
let errorArguments: ReturnType<typeof vi.spyOn>;
let logArguments: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = new Database(':memory:');
  SessionAdmissionStore._resetForTesting();
  _resetSessionAdmissionServiceForTesting();
  _resetSessionMutexForTesting();
  logging.manager!.clearBuffer();
  errorArguments = vi.spyOn(logging.manager!, 'logError');
  logArguments = vi.spyOn(logging.manager!, 'log');
});
afterEach(() => {
  _resetSessionAdmissionServiceForTesting();
  SessionAdmissionStore._resetForTesting();
  _resetSessionMutexForTesting();
  db.close();
  vi.restoreAllMocks();
});

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)]))
    : item);
}
function assertPrivateLogs(): void {
  const rows = logging.manager!.getRecentLogs();
  expect(rows.length).toBeGreaterThan(0);
  expect(serialized(rows)).not.toContain(source);
  expect(serialized(logArguments.mock.calls)).not.toContain(source);
  expect(serialized(errorArguments.mock.calls)).not.toContain(source);
  // No renamed metadata field may quietly reintroduce an Error/stack/cause.
  for (const row of rows) expect(row.error).toBeUndefined();
  for (const call of errorArguments.mock.calls) expect(call[3]).toBeUndefined();
}
function requireLog(message: string) {
  const row = logging.manager!.getRecentLogs().find((entry) => entry.message === message);
  expect(row).toBeDefined();
  return row!;
}

async function fixture(config: Partial<ConstructorParameters<typeof TestAcpCliAdapter>[1]> = {}) {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', promptTimeoutMs: 80, activeToolTimeoutMs: 80, stallWarningMs: 10, ...config });
  await adapter.spawn();
  const instance = { id: 'source-diagnostics-instance', provider: 'opencode', status: 'idle', sessionId: 'sess-acp-1',
    providerSessionId: 'sess-acp-1', parentId: null, restartCount: 0, errorCount: 0, restartEpoch: 0,
    adapterGeneration: 1, requestCount: 3, lastActivity: 0, outputBuffer: [], contextUsage: { used: 0, total: 100_000 } } as unknown as Instance;
  const runtime = vi.fn();
  const output = vi.fn();
  const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
    processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
    ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined, emitProviderRuntimeEvent: runtime });
  manager.setupAdapterEvents(instance.id, adapter);
  manager.on('output', output);
  logging.manager!.clearBuffer();
  errorArguments.mockClear(); logArguments.mockClear();
  return { proc, adapter, instance, manager, runtime, output,
    close: () => { manager.cleanupCircuitBreaker(instance.id); proc.exit(); } };
}

describe('source-safe diagnostics through the actual logger sink', () => {
  it.each(['tool', 'permission', 'provider-error'] as const)('preserves native/UI %s text and acknowledged SQLite receipt while projecting every diagnostic', async (kind) => {
    const f = await fixture();
    const errors: Error[] = [];
    f.adapter.on('error', (error) => errors.push(error));
    f.proc.onRequest('session/prompt', (request) => {
      if (kind === 'provider-error') f.proc.respondError(request.id, -32000, source);
      else if (kind === 'tool') f.proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'tool_call', toolCallId: 'local-tool', kind: 'execute', title, status: 'in_progress',
      } });
      else f.proc.request('local-permission', 'session/request_permission', { sessionId: 'sess-acp-1',
        toolCall: { toolCallId: 'local-tool', kind: 'execute', title, status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      });
    });
    try {
      await f.manager.sendInput(f.instance.id, source);
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0].message).toContain(source);
      expect(errors[0].stack).toContain(source);
      expect(serialized(f.runtime.mock.calls)).toContain(source);
      expect(serialized(f.output.mock.calls)).toContain(source);
      const errorOutput = f.instance.outputBuffer.find((message) => message.type === 'error' && message.content.includes(source));
      expect(errorOutput).toBeDefined();
      requireLog('Instance error');
      if (kind === 'provider-error') {
        for (let i = 0; i < 4; i++) f.manager.addToOutputBuffer(f.instance, { ...errorOutput!, id: `repeat-${i}` });
        expect(requireLog('Suppressing repeated error').data).toMatchObject({ count: 4, textChars: errorOutput!.content.length });
      } else {
        expect(requireLog('ACP request timeout').data).toMatchObject({ timeoutMs: 80, cause: { textChars: expect.any(Number), textHash: expect.stringMatching(/^[a-f0-9]{16}$/) } });
        expect(requireLog('Keeping instance recoverable after turn failure').data).toMatchObject({ recoverableKind: 'acp-prompt-timeout' });
        requireLog('Skipping duplicate UI error message after adapter error event');
        requireLog('ACP prompt turn appears stalled');
        expect(f.instance.outputBuffer.some((message) => message.metadata?.['watchdogWarning'] && message.content.includes(title))).toBe(true);
        expect(f.proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/cancel')).toBe(true);
        expect(f.instance.status).toBe('idle');
      }
      const prompt = f.proc.receivedMessages.find((message) => 'method' in message && message.method === 'session/prompt');
      expect(serialized(prompt)).toContain(source);
      const rows = getSessionAdmissionService().listAdmissions({ instanceId: f.instance.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'delivered', deliveredAt: expect.any(Number) });
      assertPrivateLogs();
    } finally { f.close(); }
  });

  it.each(['overflow', 'corrupted'] as const)('keeps unscoped native %s output and warning evidence without logging content', async (kind) => {
    const f = await fixture();
    const text = kind === 'overflow' ? `Prompt is too long ${source}` : `user messages must have non-empty content ${source}`;
    const nativeErrorText = `ACP session/prompt failed: ${text} (-32000)`;
    f.proc.onRequest('session/prompt', (request) => f.proc.respondError(request.id, -32000, text));
    try {
      await f.adapter.sendInput('local initial request');
      const label = kind === 'overflow' ? 'Context overflow detected via output path' : 'Corrupted session detected via output path';
      await vi.waitFor(() => expect(logging.manager!.getRecentLogs().some((row) => row.message === label)).toBe(true));
      expect(requireLog(label).data).toMatchObject({ textChars: nativeErrorText.length, textHash: expect.stringMatching(/^[a-f0-9]{16}$/) });
      expect(f.instance.outputBuffer.some((message) => message.content === nativeErrorText)).toBe(true);
      assertPrivateLogs();
    } finally { f.close(); }
  });

  it('keeps complete prompt and image bytes on native stdin while logging only size/count', async () => {
    const chunks: string[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    try {
      await new InputFormatter(stdin).sendMessage(source, [{ name: 'local-image', type: 'image/png', size: source.length, data: source }]);
      expect(JSON.parse(chunks[0]).message.content).toEqual([{ type: 'text', text: source },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: source } }]);
      expect(requireLog('sendMessage called').data).toEqual({ messageLength: source.length, attachmentsCount: 1 });
      assertPrivateLogs();
    } finally { stdin.destroy(); }
  });

  it('retains monotonically committed source text when a shorter stream update is diagnosed', async () => {
    const f = await fixture();
    const longer = `${source} local longer text`;
    try {
      for (const content of [longer, source]) f.manager.addToOutputBuffer(f.instance, {
        id: 'local-stream', timestamp: Date.now(), type: 'assistant', content, metadata: { streaming: true },
      });
      expect(f.instance.outputBuffer.find((message) => message.id === 'local-stream')?.content).toBe(longer);
      expect(requireLog('[STREAMING_DROP] streaming update shrank content').data).toEqual({
        instanceId: f.instance.id, messageId: 'local-stream', previousLength: longer.length,
        newLength: source.length, hasAccumulatedContentMeta: false,
      });
      assertPrivateLogs();
    } finally { f.close(); }
  });

  it('preserves original Error identity and human exit/hook failures without logging stacks, causes, or custom fields', async () => {
    const f = await fixture();
    const error = Object.assign(new Error(source), { code: source, cause: new Error(source), metadata: { source } });
    error.name = source;
    const received = vi.fn();
    f.adapter.on('error', received);
    vi.spyOn(f.adapter, 'terminate').mockRejectedValueOnce(error);
    try {
      f.adapter.emit('error', error);
      await vi.waitFor(() => expect(requireLog('Error during force cleanup')).toBeDefined());
      expect(received).toHaveBeenCalledExactlyOnceWith(error);
      expect(f.instance.outputBuffer.some((message) => message.content === source)).toBe(true);
      expect(serialized(f.runtime.mock.calls)).toContain(source);
      const queueUpdate = vi.fn();
      settleExitRecoveryFailure({ queueUpdate, transitionInstanceStatus: (instance, status) => { instance.status = status; },
        buildCrashError: (message) => ({ code: 'LOCAL_EXIT', message, timestamp: 1 }) }, f.instance.id, f.instance, error, 'Local exit recovery failed', 'Recovery failed');
      expect(serialized(queueUpdate.mock.calls)).toContain(source);
      const triggerLifecycleHooks = vi.fn().mockRejectedValue(error);
      dispatchInstanceLifecycleHook('StopFailure', f.instance, { errorMessage: source },
        logging.manager!.getLogger('InstanceCommunication'), { triggerLifecycleHooks } as unknown as HookManager);
      await vi.waitFor(() => expect(logging.manager!.getRecentLogs().some((row) => row.message === 'StopFailure hook error')).toBe(true));
      expect(triggerLifecycleHooks).toHaveBeenCalledWith('StopFailure', expect.objectContaining({ errorMessage: source }));
      assertPrivateLogs();
    } finally { f.close(); }
  });

  it.each(['native-retry', 'compaction', 'silent-compaction'] as const)('keeps %s failure ownership and original error while projecting the actual sink', async (kind) => {
    const f = await fixture({ adapterName: 'copilot-acp' });
    const failure = new Error(source);
    const accepted: OutputMessage[] = [];
    const errors = vi.fn(); f.adapter.on('error', errors);
    const methods: string[] = [];
    const compact = vi.fn(async () => { if (kind !== 'native-retry') throw failure; });
    (f.proc as unknown as { stdin: Writable }).stdin = new Writable({ write(chunk, _encoding, callback) {
      methods.push(JSON.parse(chunk.toString()).method); queueMicrotask(() => callback(failure));
    } });
    const tracker = new InstanceCommunicationOverflowTracker();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, { getCompactContext: () => compact,
      addToOutputBuffer: (_instance, message) => accepted.push(message), emitOutput: vi.fn(),
      transitionInstanceStatus: (instance, status) => { instance.status = status; }, queueUpdate: vi.fn(),
      getAdapter: () => f.adapter, resetCircuitBreaker: vi.fn() });
    try {
      if (kind === 'silent-compaction') {
        await expect(policy.compactSilentEmptyResponse({ instanceId: f.instance.id, instance: f.instance, reason: 'near-ceiling' })).resolves.toBe(true);
        expect(f.instance.status).toBe('idle');
        requireLog('Compaction failed during silent overflow recovery');
      } else {
        const result = policy.recoverSendInputOverflow({ instanceId: f.instance.id, instance: f.instance,
          errorText: 'context_length_exceeded', message: source, adapter: f.adapter });
        if (kind === 'native-retry') {
          await expect(result).rejects.toBe(failure);
          expect(methods).toEqual(['session/prompt']);
          expect(errors).toHaveBeenCalledExactlyOnceWith(failure);
          expect(tracker.hasRetried(f.instance.id)).toBe(true);
          requireLog('Retry after compaction failed (sendInput path)');
        } else {
          await expect(result).resolves.toBe(false);
          expect(methods).toEqual([]);
          requireLog('Context compaction failed (sendInput path)');
        }
      }
      expect(compact).toHaveBeenCalledOnce();
      expect(accepted.some((message) => message.metadata?.['contextOverflow'])).toBe(true);
      assertPrivateLogs();
    } finally { f.close(); }
  });

  it('logs deferred respawn rejection safely while retaining the human queued failure', async () => {
    const instance = { id: 'local-deferred-respawn', status: 'idle', restartCount: 0 } as Instance;
    const queueUpdate = vi.fn();
    const onUnexpectedExit = vi.fn(async () => { throw new Error(source); });
    scheduleSuppressedAutoRespawnRetry({ getInstance: () => instance, queueUpdate, onUnexpectedExit,
      transitionInstanceStatus: (current, status) => { current.status = status; },
      buildCrashError: (message) => ({ code: 'LOCAL_EXIT', message, timestamp: 1 }),
    }, instance.id, instance, 0);
    await vi.waitFor(() => expect(instance.status).toBe('error'));
    expect(onUnexpectedExit).toHaveBeenCalledExactlyOnceWith(instance.id);
    expect(serialized(queueUpdate.mock.calls)).toContain(source);
    requireLog('Deferred auto-respawn failed');
    assertPrivateLogs();
  });

  it('keeps the mutex-owned deferred exit replay once when its original failure contains source', async () => {
    const instance = { id: 'local-deferred-exit', status: 'respawning' } as Instance;
    const release = await getSessionMutex().acquire(instance.id, 'local-recovery-owner');
    const replay = vi.fn(() => { throw new Error(source); });
    try {
      expect(deferExitToRecoveryOwner(instance.id, () => instance, replay)).toBe(true);
      expect(replay).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
      requireLog('Deferred adapter exit handling failed');
      expect(instance.status).toBe('respawning');
      assertPrivateLogs();
    } finally { release(); }
  });
});
