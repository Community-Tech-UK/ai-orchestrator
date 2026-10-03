import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance, FileAttachment } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import type { AppServerClient } from '../cli/adapters/codex/app-server-client';
import type { AppServerNotification, UserInput } from '../cli/adapters/codex/app-server-types';
import type { SerializedCodexRequestQueue } from '../cli/adapters/codex-app-server-request';
import { InstanceContinuationRuntime } from './instance-continuation-runtime';
import { InstanceCommunicationManager } from './instance-communication';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';

vi.mock('../cli/adapters/codex/app-server-client', async (importOriginal) => ({
  ...await importOriginal<object>(), terminateProcessTree: vi.fn(),
}));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({
  triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
}) }));
const receipts = vi.hoisted(() => ({ records: 0, delivered: 0, failed: 0 }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({
  recordUserSend: () => { receipts.records++; return { id: 'fixture-receipt' }; },
  markDelivered: () => { receipts.delivered++; }, markFailed: () => { receipts.failed++; },
}) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FixtureCodexAdapter extends CodexCliAdapter {
  protected override spawnProcess(): never {
    throw new Error('Fixture only supports fake app-server RPCs; OS child spawning is forbidden');
  }
  attachmentPreparation: ReturnType<typeof deferred> | undefined;
  attachmentEntered = false;
  preparedInput: UserInput[] = [];
  bind(client: AppServerClient, threadId = 'thread-1'): void {
    this.appServerClient = client;
    this.appServerThreadId = threadId;
    this.useAppServer = true;
    this.isSpawned = true;
    this.appServerRuntime.attach(client, { threadId, resumeCursor: null, resumeProof: null },
      (notification) => this.handleIdleAppServerNotification(notification));
  }
  override async prepareAttachmentsForAppServer(message: string, attachments: FileAttachment[]) {
    if (!this.attachmentPreparation) return super.prepareAttachmentsForAppServer(message, attachments);
    this.attachmentEntered = true;
    await this.attachmentPreparation.promise;
    return { input: this.preparedInput, text: message };
  }
  sendNative(message: string): Promise<void> { return this.appServerSendMessageInner(message); }
  async reconnect(client: AppServerClient, threadId: string): Promise<void> {
    await this.appServerRuntime.close();
    this.systemPromptSent = false;
    this.rtkAwarenessSent = false;
    this.bind(client, threadId);
  }
  beginCompaction(): void { this.contextCostController.markCompactionRunningFromRejection(null); }
  finishCompaction(): void { this.contextCostController.recordCompactionObserved(0); }
  compactionHasWaiter(): boolean { return this.contextCostController.hasPendingCompactionHandoff(); }
}

function harness(config: ConstructorParameters<typeof CodexCliAdapter>[0] = {}) {
  const adapter = new FixtureCodexAdapter(config);
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  const requests: [string, Record<string, unknown>][] = [];
  const responses: [string, Promise<unknown>][] = [];
  let onRequest: ((method: string) => Promise<void> | void) | undefined;
  const emit = (method: AppServerNotification['method'], params: Record<string, unknown>) => {
    for (const listener of [...subscribers]) listener({ method, params });
  };
  const client = {
    exitPromise: new Promise<void>(() => { /* stays connected */ }),
    request: (method: string, params: Record<string, unknown>) => {
      const response = (async () => {
      requests.push([method, params]);
      await onRequest?.(method);
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'turn/start') return { turn: { id: 'harness-turn', status: 'completed', items: [
        { id: 'answer', type: 'agentMessage', text: 'Finished.' },
      ] } };
      return {};
      })();
      responses.push([method, response]);
      return response;
    },
    subscribeNotifications: (listener: (notification: AppServerNotification) => void) => {
      subscribers.add(listener); return () => subscribers.delete(listener);
    },
    isRunning: () => true, getPid: () => 4242,
  };
  adapter.bind(client as unknown as AppServerClient);
  const instance = { id: 'root', parentId: null, launchMode: 'orchestrated', provider: 'codex',
    sessionId: 'thread-1', adapterGeneration: 1, status: 'idle', requestCount: 3, lastActivity: 0, outputBuffer: [],
  } as unknown as Instance;
  let currentAdapter: CliAdapter | undefined = adapter;
  const adapters = [adapter];
  const events = new EventEmitter();
  let paused = false;
  let managed = false;
  const registry = new InstanceAsyncWorkRegistry();
  const outputs: unknown[] = [];
  const turnErrors: unknown[] = [];
  const notices: Record<string, unknown>[] = [];
  adapter.on('status', (status) => { instance.status = status; });
  adapter.on('output', (output) => outputs.push(output));
  adapter.on('turn_error', (error) => turnErrors.push(error));
  const communication = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => currentAdapter, setAdapter: () => undefined,
    deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: () => undefined,
    onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined,
  });
  let sent: Promise<void> | undefined;
  let committed = 0;
  const runtime = new InstanceContinuationRuntime(registry, {
    on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance, getAdapter: () => currentAdapter,
    wakeInstance: async () => {
      instance.status = 'waking';
      events.emit('instance:state-changed', { instanceId: 'root', status: 'waking' });
      const fresh = new FixtureCodexAdapter();
      fresh.bind(client as unknown as AppServerClient);
      fresh.on('status', (status) => { instance.status = status; });
      currentAdapter = fresh; adapters.push(fresh);
      instance.adapterGeneration = 2;
      instance.status = 'ready';
      events.emit('instance:state-changed', { instanceId: 'root', status: 'ready', previousStatus: 'waking' });
    },
    waitForInstanceSettled: async () => {
      if (instance.status === 'idle' || instance.status === 'ready') return instance;
      await new Promise<void>((resolve) => {
        const settle = (status: string) => {
          if (status !== 'idle' && status !== 'ready') return;
          adapter.off('status', settle); resolve();
        };
        adapter.on('status', settle);
      });
      return instance;
    },
    emitSystemMessage: (_id, _text, metadata) => { if (metadata) notices.push(metadata); },
    sendInput: async (_id, prompt, _attachments, options) => {
      sent = communication.sendInput('root', prompt, undefined, undefined, { ...options, beforeProviderDispatch: () => {
        options?.beforeProviderDispatch?.(); committed++; instance.requestCount++;
      } });
      await sent;
    },
  }, () => managed, () => paused);
  runtime.start();
  return {
    adapter, client, responses, instance, events, communication, requests, emit, outputs, turnErrors, notices, registry,
    pause: () => { paused = true; }, manage: () => { managed = true; },
    inputRequests: () => requests.filter(([method]) => ['thread/inject_items', 'turn/start', 'turn/steer'].includes(method)),
    committed: () => committed,
    requestHook: (hook: typeof onRequest) => { onRequest = hook; },
    replaceAdapter: () => { currentAdapter = new CodexCliAdapter(); },
    hibernate: () => { instance.status = 'hibernated'; currentAdapter = undefined; },
    cutoff: () => events.emit('provider:normalized-event', { instanceId: 'root', provider: 'codex', event: {
      kind: 'complete', requestCountAtCompletion: instance.requestCount, turnEnding: { reason: 'max_output', evidence: 'native_max_output' },
    } }),
    sent: async () => { await vi.waitFor(() => expect(sent).toBeDefined()); await sent; },
    close: async () => { runtime.stop(); await Promise.all(adapters.map((entry) => entry.terminate(false))); },
  };
}

describe('continuation admission through real communication and Codex queues', () => {
  it.each(['goal-update', 'provider-turn', 'manual-input', 'stop', 'request-replaced', 'adapter-replaced', 'ordinary-completion'] as const)(
    'rejects %s acquired while the real compaction-send gate yields, without charging or publishing an error', async (mode) => {
      const h = harness();
      let taken = false;
      h.adapter.on('status', (status) => {
        if (status !== 'busy' || taken) return;
        taken = true;
        queueMicrotask(() => {
          if (mode === 'manual-input') h.events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
          else if (mode === 'stop') h.events.emit('instance:interrupt-requested', { instanceId: 'root' });
          else if (mode === 'request-replaced') h.instance.requestCount++;
          else if (mode === 'adapter-replaced') h.replaceAdapter();
          else if (mode === 'ordinary-completion') h.events.emit('provider:normalized-event', { instanceId: 'root', provider: 'codex', event: {
            kind: 'complete', requestCountAtCompletion: 3, turnEnding: { reason: 'completed', evidence: 'native_completed' },
          } });
          else {
            h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { status: 'active' } });
            if (mode === 'provider-turn') h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
          }
        });
      });
      try {
        h.cutoff(); await h.sent();
        expect(h.inputRequests()).toEqual([]);
        expect(h.committed()).toBe(0);
        expect(h.instance.requestCount).toBe(mode === 'request-replaced' ? 4 : 3);
        expect(h.outputs).toEqual([]);
        expect(h.turnErrors).toEqual([]);
        expect(h.notices.filter((notice) => notice['attempt'] !== undefined)).toEqual([]);
      } finally { await h.close(); }
    },
  );

  it('preserves a cancelled continuation while waiting on the actual input queue', async () => {
    const h = harness();
    const gate = deferred();
    const queue = (h.adapter as unknown as { inputQueue: SerializedCodexRequestQueue }).inputQueue;
    const predecessor = queue.run(() => gate.promise);
    try {
      h.cutoff();
      await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toEqual(['thread/goal/get']));
      h.events.emit('instance:interrupt-requested', { instanceId: 'root' });
      gate.resolve(); await predecessor; await h.sent();
      expect(h.inputRequests()).toEqual([]);
      expect(h.committed()).toBe(0);
    } finally { gate.resolve(); await h.close(); }
  });

  it('rechecks a native goal after asynchronous attachment preparation', async () => {
    const h = harness();
    const gate = deferred();
    h.adapter.attachmentPreparation = gate;
    const commit = vi.fn();
    try {
      const sending = h.communication.sendInput('root', 'Harness continuation', [{ name: 'fixture.txt', type: 'text/plain', size: 0, data: '' }],
        undefined, { autoContinuation: true, internalSource: 'reasoning-collapse-continuation', signal: new AbortController().signal, beforeProviderDispatch: commit });
      await vi.waitFor(() => expect(h.adapter.attachmentEntered).toBe(true));
      h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { status: 'active' } });
      gate.resolve(); await sending;
      expect(h.inputRequests()).toEqual([]);
      expect(commit).not.toHaveBeenCalled();
    } finally { gate.resolve(); await h.close(); }
  });

  it('cancels a send immediately during real compaction without cancelling provider maintenance', async () => {
    const h = harness();
    const abort = new AbortController();
    const commit = vi.fn();
    try {
      h.adapter.beginCompaction();
      const sending = h.communication.sendInput('root', 'Harness continuation', undefined, undefined,
        { autoContinuation: true, internalSource: 'reasoning-collapse-continuation', signal: abort.signal, beforeProviderDispatch: commit });
      await vi.waitFor(() => expect(h.adapter.compactionHasWaiter()).toBe(true));
      abort.abort(); await sending;
      expect(h.adapter.isProviderCompacting()).toBe(true);
      expect(h.adapter.compactionHasWaiter()).toBe(false);
      expect(h.inputRequests()).toEqual([]);
      expect(commit).not.toHaveBeenCalled();
      expect(h.turnErrors).toEqual([]);
      expect(h.outputs).not.toContainEqual(expect.objectContaining({ metadata: expect.objectContaining({ providerCompactionPaused: true }) }));
      expect(h.outputs).not.toContainEqual(expect.objectContaining({ type: 'error' }));
      h.adapter.finishCompaction();
    } finally { await h.close(); }
  });

  it('commits a safe queued continuation once and never serializes its private controls', async () => {
    const h = harness();
    try {
      h.cutoff(); await h.sent();
      expect(h.committed()).toBe(1);
      expect(h.instance.requestCount).toBe(4);
      expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items', 'turn/start']);
      expect(h.inputRequests()[1][1]).toEqual({ threadId: 'thread-1', input: [] });
      expect(h.inputRequests()[0][1]).toEqual({ threadId: 'thread-1', items: [expect.objectContaining({ role: 'developer' })] });
      expect(JSON.stringify(h.requests)).not.toMatch(/signal|beforeProviderDispatch|autoContinuation|dispatch/);
    } finally { await h.close(); }
  });

  it('retains manual input steering into a provider-owned turn', async () => {
    const h = harness();
    try {
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
      h.requestHook((method) => {
        if (method === 'turn/steer') queueMicrotask(() => h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } }));
      });
      const committed = vi.fn();
      await h.communication.sendInput('root', 'Also inspect this change.', undefined, undefined,
        { signal: new AbortController().signal, beforeProviderDispatch: committed });
      expect(committed).toHaveBeenCalledOnce();
      expect(h.inputRequests()).toEqual([['turn/steer', { threadId: 'thread-1', expectedTurnId: 'native-turn',
        input: [{ type: 'text', text: 'Also inspect this change.', text_elements: [] }],
      }]]);
    } finally { await h.close(); }
  });

  it('delivers a legitimate background wake through communication to its newly created Codex adapter', async () => {
    const h = harness();
    try {
      h.instance.parentId = 'parent';
      h.hibernate();
      h.registry.observe('root', { phase: 'terminal', workId: 'finished-work', kind: 'background-shell', status: 'completed' });
      await h.sent();
      expect(h.instance.adapterGeneration).toBe(2);
      expect(h.committed()).toBe(1);
      expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items', 'turn/start']);
      expect(h.registry.hasInhibitor('root')).toBe(false);
    } finally { await h.close(); }
  });

  it.each(['stop', 'manual-input', 'goal-update', 'provider-turn', 'request-replaced', 'adapter-replaced', 'pause', 'managed', 'inhibitor'] as const)(
    'keeps the %s fence across developer injection acknowledgement', async (mode) => {
      const h = harness();
      const injected = deferred();
      h.requestHook((method) => method === 'thread/inject_items' ? injected.promise : undefined);
      try {
        h.cutoff();
        await vi.waitFor(() => expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items']));
        if (mode === 'stop') h.events.emit('instance:interrupt-requested', { instanceId: 'root' });
        else if (mode === 'manual-input') h.events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
        else if (mode === 'request-replaced') h.instance.requestCount++;
        else if (mode === 'adapter-replaced') h.replaceAdapter();
        else if (mode === 'pause') h.pause();
        else if (mode === 'managed') h.manage();
        else if (mode === 'inhibitor') h.registry.observe('root', { phase: 'started', workId: 'new-work', kind: 'background-shell' });
        else if (mode === 'goal-update') h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { status: 'active' } });
        else h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
        injected.resolve(); await h.sent();
        expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items']);
        expect(h.committed()).toBe(1);
        expect(h.turnErrors).toEqual([]);
        if (mode === 'provider-turn') expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(true);
      } finally { injected.resolve(); await h.close(); }
    },
  );

  it('allows a synchronous completion successor on the newly committed request', async () => {
    const h = harness();
    let continuationCount = 0;
    h.adapter.on('complete', () => {
      if (++continuationCount < 2) h.cutoff();
    });
    try {
      h.cutoff();
      await vi.waitFor(() => expect(h.committed()).toBe(2));
      await h.sent();
      expect(h.instance.requestCount).toBe(5);
      expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items', 'turn/start', 'thread/inject_items', 'turn/start']);
      expect(h.notices.filter((notice) => notice['attempt'] !== undefined).map((notice) => notice['attempt'])).toEqual([1, 2]);
    } finally { await h.close(); }
  });
});

describe('Codex first-turn instruction acceptance', () => {
  it('successful first native RPC contains system and RTK instructions with one admitted delivered receipt', async () => {
    receipts.records = receipts.delivered = receipts.failed = 0;
    const h = harness({ systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true });
    const commit = vi.fn();
    try {
      await h.communication.sendInput('root', 'LOCAL_USER_INPUT', undefined, undefined,
        { signal: new AbortController().signal, beforeProviderDispatch: commit });
      const starts = h.requests.filter(([method]) => method === 'turn/start');
      const text = JSON.stringify(starts);
      expect(starts).toHaveLength(1);
      expect(text).toContain('LOCAL_FIRST_SYSTEM_MARKER');
      expect(text).toMatch(/RTK|rtk/);
      expect(commit).toHaveBeenCalledOnce();
      expect(receipts).toEqual({ records: 1, delivered: 1, failed: 0 });
      expect(h.turnErrors).toEqual([]);
    } finally { await h.close(); }
  });
  it('cancelled attachment preparation must retain first-turn native instructions for subsequent successful send', async () => {
    receipts.records = receipts.delivered = receipts.failed = 0;
    const h = harness({ systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true });
    const gate = deferred();
    const abort = new AbortController();
    const cancelledCommit = vi.fn();
    h.adapter.attachmentPreparation = gate;
    try {
      const cancelled = h.communication.sendInput('root', 'LOCAL_CANCELLED_INPUT',
        [{ name: 'fixture.txt', type: 'text/plain', size: 0, data: '' }], undefined,
        { signal: abort.signal, autoContinuation: true, internalSource: 'reasoning-collapse-continuation', beforeProviderDispatch: cancelledCommit });
      await vi.waitFor(() => expect(h.adapter.attachmentEntered).toBe(true));
      abort.abort(); gate.resolve(); await cancelled;
      expect(h.inputRequests()).toEqual([]);
      expect(cancelledCommit).not.toHaveBeenCalled();
      expect(receipts).toEqual({ records: 0, delivered: 0, failed: 0 });
      const commit = vi.fn();
      await h.communication.sendInput('root', 'LOCAL_NEXT_INPUT', undefined, undefined,
        { signal: new AbortController().signal, beforeProviderDispatch: commit });
      const starts = h.requests.filter(([method]) => method === 'turn/start');
      expect(starts).toHaveLength(1);
      expect(commit).toHaveBeenCalledOnce();
      expect(receipts).toEqual({ records: 1, delivered: 1, failed: 0 });
      expect(h.turnErrors).toEqual([]);
      const written = JSON.stringify(starts);
      expect({ system: written.includes('LOCAL_FIRST_SYSTEM_MARKER'), rtk: /RTK|rtk/.test(written) })
        .toEqual({ system: true, rtk: true });
    } finally { gate.resolve(); await h.close(); }
  });
});

describe('Codex rejected first-turn instruction acceptance', () => {
  it.each(['turn-start-rejection', 'developer-injection-rejection', 'provider-steer-rejection'] as const)('preserves unsent first-turn instructions after %s', async mode => {
    receipts.records = receipts.delivered = receipts.failed = 0;
    const h = harness({ systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true });
    const commit = vi.fn();
    const method = mode === 'turn-start-rejection' ? 'turn/start' : mode === 'developer-injection-rejection' ? 'thread/inject_items' : 'turn/steer';
    if (mode === 'provider-steer-rejection') h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
    h.requestHook(request => { if (request === method) throw new Error('failed to submit turn input: LOCAL_RPC_REJECTED_BEFORE_NATIVE_ACCEPTANCE'); });
    try {
      await expect(h.communication.sendInput('root', 'LOCAL_FAILED_INPUT', undefined, undefined,
        { signal: new AbortController().signal, beforeProviderDispatch: commit,
          ...(mode === 'developer-injection-rejection' ? { internalSource: 'context-policy' } : {}) }))
        .rejects.toThrow('LOCAL_RPC_REJECTED_BEFORE_NATIVE_ACCEPTANCE');
      expect(h.inputRequests().map(([request]) => request)).toEqual([method]);
      expect(commit).toHaveBeenCalledOnce();
      expect(receipts).toEqual({ records: 1, delivered: 0, failed: 1 });
      if (mode === 'provider-steer-rejection') {
        h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } });
        await vi.waitFor(() => expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false));
      }
      h.requestHook(() => undefined);
      const nextCommit = vi.fn();
      await h.communication.sendInput('root', 'LOCAL_NEXT_INPUT', undefined, undefined,
        { signal: new AbortController().signal, beforeProviderDispatch: nextCommit });
      expect(nextCommit).toHaveBeenCalledOnce();
      expect(receipts).toEqual({ records: 2, delivered: 1, failed: 1 });
      const lastStart = h.requests.filter(([request]) => request === 'turn/start').at(-1);
      expect(lastStart).toBeDefined();
      const written = JSON.stringify(lastStart);
      expect({ system: written.includes('LOCAL_FIRST_SYSTEM_MARKER'), rtk: /RTK|rtk/.test(written) })
        .toEqual({ system: true, rtk: true });
    } finally { await h.close(); }
  });
  it('accepted developer injection survives provider join completion and is consumed once', async () => {
    receipts.records = receipts.delivered = receipts.failed = 0;
    const h = harness({ systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true });
    const commit = vi.fn();
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
    h.requestHook(request => { if (request === 'thread/inject_items') h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } }); });
    try {
      await h.communication.sendInput('root', 'LOCAL_JOIN_INPUT', undefined, undefined,
        { signal: new AbortController().signal, internalSource: 'context-policy', beforeProviderDispatch: commit });
      expect(commit).toHaveBeenCalledOnce();
      expect(h.inputRequests().map(([request]) => request)).toEqual(['thread/inject_items']);
      expect(JSON.stringify(h.inputRequests())).toContain('LOCAL_FIRST_SYSTEM_MARKER');
      expect(JSON.stringify(h.inputRequests())).toMatch(/RTK|rtk/);
      expect(receipts).toEqual({ records: 1, delivered: 1, failed: 0 });
      h.requestHook(() => undefined);
      await h.communication.sendInput('root', 'LOCAL_NEXT_INPUT');
      expect(receipts).toEqual({ records: 2, delivered: 2, failed: 0 });
      const starts = h.requests.filter(([request]) => request === 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts)).not.toContain('LOCAL_FIRST_SYSTEM_MARKER');
      expect(JSON.stringify(starts)).not.toMatch(/RTK|rtk/);
    } finally { await h.close(); }
  });
});


describe('Codex accepted first-turn instruction ownership', () => {
  const firstTurnConfig = { systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true };
  function blocks(request: unknown) {
    const written = JSON.stringify(request);
    return { system: written.includes('LOCAL_FIRST_SYSTEM_MARKER'), rtk: /RTK|rtk/.test(written) };
  }

  it('retains consumption after an acknowledged start later reports a failed native turn', async () => {
    const h = harness(firstTurnConfig);
    h.requestHook(method => {
      if (method === 'turn/start') h.emit('turn/completed', { threadId: 'thread-1',
        turn: { id: 'harness-turn', status: 'failed', error: { message: 'LOCAL_NATIVE_FAILURE' } },
      });
    });
    try {
      await expect(h.adapter.sendNative('first')).rejects.toThrow('LOCAL_NATIVE_FAILURE');
      expect(blocks(h.inputRequests()[0])).toEqual({ system: true, rtk: true });
      h.requestHook(() => undefined);
      await h.adapter.sendNative('next');
      expect(blocks(h.inputRequests().at(-1))).toEqual({ system: false, rtk: false });
    } finally { await h.close(); }
  });

  it('retains consumption after acknowledged developer injection and subsequent input cancellation', async () => {
    const h = harness(firstTurnConfig);
    const abort = new AbortController();
    h.requestHook(method => { if (method === 'thread/inject_items') abort.abort(); });
    try {
      await expect(h.communication.sendInput('root', 'instructions', undefined, undefined,
        { internalSource: 'context-policy', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items']);
      expect(blocks(h.inputRequests()[0])).toEqual({ system: true, rtk: true });
      h.requestHook(() => undefined);
      await h.communication.sendInput('root', 'next');
      expect(blocks(h.inputRequests().at(-1))).toEqual({ system: false, rtk: false });
    } finally { await h.close(); }
  });

  it('serializes queued sends and includes first-turn blocks only on the acknowledged predecessor', async () => {
    const h = harness(firstTurnConfig);
    const gate = deferred();
    let submitted = false;
    h.requestHook(async method => { if (method === 'turn/start' && !submitted) { submitted = true; await gate.promise; } });
    try {
      const first = h.adapter.sendInput('first');
      const next = h.adapter.sendInput('next');
      await vi.waitFor(() => expect(h.inputRequests()).toHaveLength(1));
      gate.resolve();
      await Promise.all([first, next]);
      expect(h.inputRequests()).toHaveLength(2);
      expect(h.inputRequests().map(blocks)).toEqual([{ system: true, rtk: true }, { system: false, rtk: false }]);
    } finally { gate.resolve(); await h.close(); }
  });

  it.each([
    { systemPrompt: '   ', rtkEnabled: false },
    { systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: false },
    { systemPrompt: '   ', rtkEnabled: true },
  ])('only consumes configured blocks for %j', async config => {
    const h = harness(config);
    try {
      await h.adapter.sendInput('first');
      await h.adapter.sendInput('next');
      expect(h.inputRequests().map(blocks)).toEqual([
        { system: !!config.systemPrompt.trim(), rtk: config.rtkEnabled }, { system: false, rtk: false },
      ]);
    } finally { await h.close(); }
  });

  it.each(['client', 'thread'] as const)('ignores old acknowledgment after native %s binding changes', async mode => {
    const h = harness(firstTurnConfig);
    const gate = deferred();
    h.requestHook(async method => { if (method === 'turn/start') await gate.promise; });
    try {
      const first = h.adapter.sendNative('old');
      const rejected = expect(first).rejects.toThrow('runtime closed');
      await vi.waitFor(() => expect(h.inputRequests()).toHaveLength(1));
      await h.adapter.reconnect((mode === 'client' ? { ...h.client } : h.client) as unknown as AppServerClient,
        mode === 'thread' ? 'thread-2' : 'thread-1');
      await rejected;
      gate.resolve();
      // Its acknowledgment callback was registered before this await.
      await h.responses.find(([method]) => method === 'turn/start')![1];
      h.requestHook(() => undefined);
      await h.adapter.sendNative('new');
      expect(blocks(h.inputRequests().at(-1))).toEqual({ system: true, rtk: true });
    } finally { gate.resolve(); await h.close(); }
  });
});


describe('Codex fake-native fixture and accepted steering', () => {
  it('rejects an accidental exec route before any OS child can spawn', async () => {
    const h = harness();
    try {
      await expect(h.adapter.sendMessage({ content: 'fixture', role: 'user' }))
        .rejects.toThrow('OS child spawning is forbidden');
      expect(h.inputRequests()).toEqual([]);
    } finally { await h.close(); }
  });

  it.each(['user-steer', 'developer-injection-then-rejected-steer'] as const)(
    'consumes first-turn instructions accepted by %s exactly once', async mode => {
      const h = harness({ systemPrompt: 'LOCAL_FIRST_SYSTEM_MARKER', rtkEnabled: true });
      const gate = deferred();
      if (mode === 'developer-injection-then-rejected-steer') {
        h.adapter.attachmentPreparation = gate;
        h.adapter.preparedInput = [{ type: 'localImage', path: '/tmp/fixture-image.png' }];
        gate.resolve();
      }
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'inProgress' } });
      h.requestHook(method => {
        if (method !== 'turn/steer') return;
        if (mode === 'developer-injection-then-rejected-steer') throw new Error('failed to submit turn input: LOCAL_STEER_REJECTED');
        h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } });
      });
      try {
        const sending = h.communication.sendInput('root', 'first', mode === 'user-steer' ? undefined :
          [{ name: 'fixture-image.png', type: 'image/png', size: 0, data: '' }], undefined,
          mode === 'user-steer' ? undefined : { internalSource: 'context-policy' });
        if (mode === 'user-steer') await sending;
        else {
          await expect(sending).rejects.toThrow('LOCAL_STEER_REJECTED');
          h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } });
          await vi.waitFor(() => expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false));
        }
        const first = JSON.stringify(h.inputRequests()[0]);
        expect(first).toContain('LOCAL_FIRST_SYSTEM_MARKER');
        expect(first).toMatch(/RTK|rtk/);
        if (mode !== 'user-steer') {
          expect(h.inputRequests().map(([method]) => method)).toEqual(['thread/inject_items', 'turn/steer']);
          expect(h.inputRequests()[0][1]['items']).toEqual([{
            type: 'message', role: 'developer', content: [{ type: 'input_text', text: expect.any(String) }],
          }]);
          expect(h.inputRequests()[1][1]['input']).toEqual([{ type: 'localImage', path: '/tmp/fixture-image.png' }]);
        }
        h.requestHook(() => undefined);
        await h.communication.sendInput('root', 'next');
        const next = JSON.stringify(h.inputRequests().at(-1));
        expect(next).not.toContain('LOCAL_FIRST_SYSTEM_MARKER');
        expect(next).not.toMatch(/RTK|rtk/);
      } finally { gate.resolve(); await h.close(); }
    });
});
