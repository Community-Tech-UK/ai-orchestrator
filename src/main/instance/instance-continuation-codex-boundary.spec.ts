import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance, FileAttachment } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import type { AppServerClient } from '../cli/adapters/codex/app-server-client';
import type { AppServerNotification } from '../cli/adapters/codex/app-server-types';
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
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({
  recordUserSend: () => null, markDelivered: vi.fn(), markFailed: vi.fn(),
}) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FixtureCodexAdapter extends CodexCliAdapter {
  attachmentPreparation: ReturnType<typeof deferred> | undefined;
  attachmentEntered = false;
  bind(client: AppServerClient): void {
    this.appServerClient = client;
    this.appServerThreadId = 'thread-1';
    this.useAppServer = true;
    this.isSpawned = true;
    this.appServerRuntime.attach(client, { threadId: 'thread-1', resumeCursor: null, resumeProof: null },
      (notification) => this.handleIdleAppServerNotification(notification));
  }
  override async prepareAttachmentsForAppServer(message: string, attachments: FileAttachment[]) {
    if (!this.attachmentPreparation) return super.prepareAttachmentsForAppServer(message, attachments);
    this.attachmentEntered = true;
    await this.attachmentPreparation.promise;
    return { input: [], text: message };
  }
  beginCompaction(): void { this.contextCostController.markCompactionRunningFromRejection(null); }
  finishCompaction(): void { this.contextCostController.recordCompactionObserved(0); }
  compactionHasWaiter(): boolean { return this.contextCostController.hasPendingCompactionHandoff(); }
}

function harness() {
  const adapter = new FixtureCodexAdapter();
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  const requests: [string, Record<string, unknown>][] = [];
  let onRequest: ((method: string) => Promise<void> | void) | undefined;
  const emit = (method: AppServerNotification['method'], params: Record<string, unknown>) => {
    for (const listener of [...subscribers]) listener({ method, params });
  };
  const client = {
    exitPromise: new Promise<void>(() => { /* stays connected */ }),
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push([method, params]);
      await onRequest?.(method);
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'turn/start') return { turn: { id: 'harness-turn', status: 'completed', items: [
        { id: 'answer', type: 'agentMessage', text: 'Finished.' },
      ] } };
      return {};
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
    adapter, instance, events, communication, requests, emit, outputs, turnErrors, notices, registry,
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
