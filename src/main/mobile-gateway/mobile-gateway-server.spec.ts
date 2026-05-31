import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { WebSocket } from 'ws';
import {
  MobileGatewayServer,
  serializeInstance,
  buildProjects,
  serializeHistorySession,
  serializeHistoryMessage,
  serializeInstanceHistorySession,
  type GatewayInstanceSource,
  type GatewayPauseSource,
  type GatewayRecentDirsSource,
} from './mobile-gateway-server';
import { MobileDeviceRegistry, type MobileDevicePersistence } from './mobile-device-registry';
import { MobileApnsSender } from './mobile-apns-sender';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { MobilePauseDto } from '../../shared/types/mobile-gateway.types';

function inst(partial: Partial<Instance>): Instance {
  return {
    id: 'i1',
    displayName: 'Agent',
    status: 'idle',
    provider: 'claude',
    workingDirectory: '/repo/alpha',
    createdAt: 1,
    lastActivity: 1,
    parentId: null,
    contextUsage: { used: 0, total: 0, percentage: 0 },
    outputBuffer: [],
    ...partial,
  } as unknown as Instance;
}

class FakeInstanceSource extends EventEmitter implements GatewayInstanceSource {
  instances: Instance[] = [];
  readonly orchestration = new (class extends EventEmitter {
    respondToUserAction = vi.fn();
  })();

  sendInput = vi.fn(async () => undefined);
  interruptInstance = vi.fn(() => true);
  terminateInstance = vi.fn(async () => undefined);
  resumeAfterDeferredPermission = vi.fn(async () => undefined);
  recordInputRequiredPermissionDecision = vi.fn();
  clearPendingInputRequiredPermission = vi.fn();
  renameInstance = vi.fn((id: string, displayName: string) => {
    const found = this.instances.find((i) => i.id === id);
    if (found) found.displayName = displayName;
  });
  createInstance = vi.fn(async (config: InstanceCreateConfig) => {
    const created = inst({
      id: `new-${this.instances.length}`,
      workingDirectory: config.workingDirectory,
      displayName: config.initialPrompt?.slice(0, 20) || 'New',
    });
    this.instances.push(created);
    return created;
  });

  getAllInstances(): Instance[] {
    return this.instances;
  }
  getInstance(id: string): Instance | undefined {
    return this.instances.find((i) => i.id === id);
  }
  getOrchestrationHandler() {
    return this.orchestration;
  }
}

class FakePause extends EventEmitter implements GatewayPauseSource {
  state: MobilePauseDto = { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };
  toPayload(): MobilePauseDto {
    return this.state;
  }
  addReason(): void {
    this.state = { isPaused: true, reasons: ['user'], pausedAt: 100, lastChange: 200 };
    this.emit('change');
  }
  removeReason(): void {
    this.state = { isPaused: false, reasons: [], pausedAt: null, lastChange: 300 };
    this.emit('change');
  }
}

const fakeRecentDirs: GatewayRecentDirsSource = {
  getDirectories: async () => [
    { path: '/repo/alpha', displayName: 'alpha', lastAccessed: 5, isPinned: true },
    { path: '/repo/beta', displayName: 'beta', lastAccessed: 4, isPinned: false },
  ],
};

function memPersistence(): MobileDevicePersistence {
  let store: string | undefined;
  return {
    load: () => store,
    save: (j: string) => {
      store = j;
    },
  };
}

/** An APNs sender that records sends instead of hitting Apple. */
function fakeApnsSender(configured: boolean) {
  const posts: { deviceToken: string; payload: string }[] = [];
  const sender = new MobileApnsSender({
    now: () => 1_700_000_000_000,
    configProvider: () =>
      configured
        ? {
            keyP8: TEST_P8,
            keyId: 'ABCDE12345',
            teamId: 'TEAM123456',
            bundleId: 'com.example.app',
            production: false,
          }
        : { keyP8: '', keyId: '', teamId: '', bundleId: '', production: false },
    transport: {
      post: async (args) => {
        posts.push({ deviceToken: args.deviceToken, payload: args.payload });
        return { status: 200 };
      },
    },
  });
  return { sender, posts };
}

// A throwaway P-256 private key in PKCS#8 PEM, generated fresh for these tests.
const TEST_P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

interface MessageCollector {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Buffer messages from creation so we never miss the server's eager snapshot. */
function collectMessages(ws: WebSocket): MessageCollector {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => void)[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    next(timeoutMs = 2000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

/** Await a WS frame of a given type, ignoring (and buffering) others. */
async function nextOfType(
  messages: MessageCollector,
  type: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(50, deadline - Date.now());
    const msg = await messages.next(remaining);
    if (msg.type === type) return msg;
  }
}

describe('serializeInstance / buildProjects', () => {
  it('derives approval from status and groups by working directory', () => {
    const instances = [
      inst({ id: 'a', workingDirectory: '/repo/alpha', status: 'busy' }),
      inst({ id: 'b', workingDirectory: '/repo/alpha', status: 'waiting_for_permission' }),
      inst({ id: 'c', workingDirectory: '/repo/beta', status: 'idle', lastActivity: 99 }),
    ].map(serializeInstance);

    expect(instances[0].projectName).toBe('alpha');
    expect(instances[1].pendingApprovalCount).toBe(1);

    const projectsList = buildProjects(instances);
    const alpha = projectsList.find((p) => p.path === '/repo/alpha');
    expect(alpha?.sessionCount).toBe(2);
    expect(alpha?.busyCount).toBe(1);
    expect(alpha?.pendingApprovalCount).toBe(1);
    // beta has the most recent activity, so it sorts first
    expect(projectsList[0].path).toBe('/repo/beta');
  });
});

describe('history serializers', () => {
  it('marks chat sessions archived vs live and derives the project name', () => {
    const archived = serializeHistorySession({
      id: 'c1',
      name: 'Old refactor',
      provider: 'claude',
      model: 'opus',
      currentCwd: '/repo/alpha',
      createdAt: 10,
      lastActiveAt: 20,
      archivedAt: 30,
      currentInstanceId: null,
    });
    expect(archived.archived).toBe(true);
    expect(archived.live).toBe(false);
    expect(archived.instanceId).toBeUndefined();
    expect(archived.projectName).toBe('alpha');

    const live = serializeHistorySession({
      id: 'c2',
      name: 'Active',
      provider: 'codex',
      model: null,
      currentCwd: null,
      createdAt: 1,
      lastActiveAt: 2,
      archivedAt: null,
      currentInstanceId: 'i-live',
    });
    expect(live.live).toBe(true);
    expect(live.archived).toBe(false);
    expect(live.instanceId).toBe('i-live');
    expect(live.workingDirectory).toBe('');
    expect(live.projectName).toBe('No workspace');
  });

  it('maps ledger roles onto phone message types', () => {
    expect(serializeHistoryMessage({ id: 'm1', role: 'assistant', content: 'hi', createdAt: 1 }).type).toBe('assistant');
    expect(serializeHistoryMessage({ id: 'm2', role: 'user', content: 'yo', createdAt: 2 }).type).toBe('user');
    expect(serializeHistoryMessage({ id: 'm3', role: 'tool', content: 'ran', createdAt: 3 }).type).toBe('tool_result');
    expect(serializeHistoryMessage({ id: 'm4', role: 'event', content: 'x', createdAt: 4 }).type).toBe('system');
    const mapped = serializeHistoryMessage({ id: 'm5', role: 'user', content: 'c', createdAt: 9 });
    expect(mapped.timestamp).toBe(9);
    expect(mapped.hasAttachments).toBe(false);
  });

  it('serializes an archived instance-history entry (always closed, title fallback)', () => {
    const titled = serializeInstanceHistorySession({
      id: 'e1',
      displayName: 'Agent 3',
      aiTitle: 'Fix the floor logic',
      provider: 'claude',
      currentModel: 'opus',
      workingDirectory: '/repo/one-more-floor',
      createdAt: 100,
      endedAt: 200,
    });
    expect(titled.name).toBe('Fix the floor logic');
    expect(titled.projectName).toBe('one-more-floor');
    expect(titled.archived).toBe(true);
    expect(titled.live).toBe(false);
    expect(titled.lastActiveAt).toBe(200);

    // Falls back displayName → firstUserMessage when no aiTitle.
    const fallback = serializeInstanceHistorySession({
      id: 'e2',
      displayName: '',
      firstUserMessage: 'add a lift',
      workingDirectory: '',
      createdAt: 1,
      endedAt: 2,
    });
    expect(fallback.name).toBe('add a lift');
    expect(fallback.projectName).toBe('No workspace');
    expect(fallback.provider).toBeNull();
  });
});

describe('MobileGatewayServer', () => {
  let server: MobileGatewayServer;
  let source: FakeInstanceSource;
  let registry: MobileDeviceRegistry;
  let pause: FakePause;
  let port: number;

  function initServer(apnsConfigured = false): { posts: { deviceToken: string; payload: string }[] } {
    const { sender, posts } = fakeApnsSender(apnsConfigured);
    server.initialize({
      instanceManager: source,
      registry,
      pauseCoordinator: pause,
      recentDirs: fakeRecentDirs,
      apnsSender: sender,
    });
    return { posts };
  }

  beforeEach(async () => {
    source = new FakeInstanceSource();
    source.instances = [inst({ id: 'a', status: 'busy' })];
    registry = new MobileDeviceRegistry(memPersistence());
    pause = new FakePause();
    server = new MobileGatewayServer();
    initServer(false);
    const status = await server.start({ port: 0, bindInterface: 'all' });
    port = status.port!;
    expect(status.running).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  async function pairToken(): Promise<string> {
    const pairing = registry.issuePairing();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: pairing.pairingToken, label: 'Test iPhone' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; deviceId: string };
    return body.token;
  }

  function authed(token: string, path: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  }

  it('serves /health without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('rejects an invalid pairing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: 'bogus' }),
    });
    expect(res.status).toBe(403);
  });

  it('requires a bearer token for /api/instances', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/instances`);
    expect(res.status).toBe(401);
  });

  it('pairs then lists instances with the device token', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances');
    expect(res.status).toBe(200);
    const instances = (await res.json()) as { id: string }[];
    expect(instances.map((i) => i.id)).toEqual(['a']);
  });

  it('reports push as unconfigured in status', async () => {
    expect(server.getStatus().pushConfigured).toBe(false);
  });

  // ---- Phase 1: messages + input + live output ----

  it('returns an instance transcript from the output buffer', async () => {
    source.instances = [
      inst({
        id: 'a',
        outputBuffer: [
          { id: 'm1', timestamp: 1, type: 'user', content: 'hi' },
          { id: 'm2', timestamp: 2, type: 'assistant', content: 'hello' },
        ],
      } as Partial<Instance>),
    ];
    const token = await pairToken();
    const res = await authed(token, '/api/instances/a/messages');
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as { id: string; content: string }[];
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('404s messages for an unknown instance', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances/nope/messages');
    expect(res.status).toBe(404);
  });

  it('routes input to sendInput', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances/a/input', {
      method: 'POST',
      body: JSON.stringify({ message: 'do the thing' }),
    });
    expect(res.status).toBe(200);
    expect(source.sendInput).toHaveBeenCalledWith('a', 'do the thing', undefined);
  });

  it('rejects empty input', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances/a/input', {
      method: 'POST',
      body: JSON.stringify({ message: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('streams a live instance-output frame on provider:normalized-event', async () => {
    const token = await pairToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      await nextOfType(messages, 'snapshot');
      source.emit('provider:normalized-event', {
        eventId: 'e1',
        seq: 7,
        timestamp: 123,
        provider: 'claude',
        instanceId: 'a',
        event: { kind: 'output', content: 'streamed', messageType: 'assistant', messageId: 'mm1' },
      });
      const frame = await nextOfType(messages, 'instance-output');
      const data = frame.data as { instanceId: string; seq: number; message: { content: string } };
      expect(data.instanceId).toBe('a');
      expect(data.seq).toBe(7);
      expect(data.message.content).toBe('streamed');
    } finally {
      ws.close();
    }
  });

  // ---- Phase 2: prompts, respond, interrupt, terminate, pause ----

  it('records a prompt on instance:input-required and exposes it via /api/prompts', async () => {
    const token = await pairToken();
    source.emit('instance:input-required', {
      instanceId: 'a',
      requestId: 'req-1',
      prompt: 'Allow bash?',
      timestamp: 10,
      metadata: { type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'ls' } },
    });
    const res = await authed(token, '/api/prompts');
    const prompts = (await res.json()) as { requestId: string; toolName: string }[];
    expect(prompts).toHaveLength(1);
    expect(prompts[0].requestId).toBe('req-1');
    expect(prompts[0].toolName).toBe('Bash');
  });

  it('broadcasts permission-prompt over WS and clears it after respond', async () => {
    const token = await pairToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      await nextOfType(messages, 'snapshot');
      source.emit('instance:input-required', {
        instanceId: 'a',
        requestId: 'req-2',
        prompt: 'Allow Bash?',
        metadata: { type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'rm' } },
      });
      const promptFrame = await nextOfType(messages, 'permission-prompt');
      expect((promptFrame.data as { requestId: string }).requestId).toBe('req-2');

      const res = await authed(token, '/api/instances/a/respond', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-2', decisionAction: 'allow', decisionScope: 'once' }),
      });
      expect(res.status).toBe(200);
      expect(source.resumeAfterDeferredPermission).toHaveBeenCalledWith('a', true);
      expect(source.recordInputRequiredPermissionDecision).toHaveBeenCalledWith({
        instanceId: 'a',
        requestId: 'req-2',
        action: 'allow',
        scope: 'once',
      });
      const cleared = await nextOfType(messages, 'permission-cleared');
      expect((cleared.data as { requestId: string }).requestId).toBe('req-2');
    } finally {
      ws.close();
    }
  });

  it('preserves user-action option ids and routes responses to orchestration', async () => {
    const token = await pairToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      await nextOfType(messages, 'snapshot');
      source.orchestration.emit('user-action-request', {
        id: 'uar-1',
        instanceId: 'a',
        requestType: 'select_option',
        title: 'Tool Permission Required',
        message: 'Choose how to proceed',
        options: [
          { id: 'allow_session', label: 'Allow for session', description: 'Auto-allow in this session.' },
          { id: 'deny_once', label: 'Deny once', description: 'Block this call one time.' },
        ],
      });

      const promptFrame = await nextOfType(messages, 'permission-prompt');
      const prompt = promptFrame.data as {
        requestId: string;
        requestType: string;
        options: Array<{ id: string; label: string; description?: string }>;
      };
      expect(prompt.requestId).toBe('uar-1');
      expect(prompt.requestType).toBe('select_option');
      expect(prompt.options).toEqual([
        {
          id: 'allow_session',
          label: 'Allow for session',
          description: 'Auto-allow in this session.',
        },
        {
          id: 'deny_once',
          label: 'Deny once',
          description: 'Block this call one time.',
        },
      ]);

      const res = await authed(token, '/api/instances/a/respond', {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'uar-1',
          decisionAction: 'allow',
          response: 'allow_session',
        }),
      });
      expect(res.status).toBe(200);
      expect(source.orchestration.respondToUserAction).toHaveBeenCalledWith(
        'uar-1',
        true,
        'allow_session',
      );
      expect(source.resumeAfterDeferredPermission).not.toHaveBeenCalledWith('a', true);
      const cleared = await nextOfType(messages, 'permission-cleared');
      expect((cleared.data as { requestId: string }).requestId).toBe('uar-1');
    } finally {
      ws.close();
    }
  });

  it('rejects respond without a valid decisionAction', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances/a/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('clears prompts when the instance leaves a waiting status', async () => {
    const token = await pairToken();
    source.emit('instance:input-required', {
      instanceId: 'a',
      requestId: 'req-3',
      metadata: { type: 'deferred_permission', tool_name: 'Bash' },
    });
    expect((await (await authed(token, '/api/prompts')).json()).length).toBe(1);
    source.emit('instance:state-update', { instanceId: 'a', status: 'busy' });
    expect((await (await authed(token, '/api/prompts')).json()).length).toBe(0);
  });

  it('interrupts and terminates an instance', async () => {
    const token = await pairToken();
    const intr = await authed(token, '/api/instances/a/interrupt', { method: 'POST' });
    expect(intr.status).toBe(200);
    expect(source.interruptInstance).toHaveBeenCalledWith('a');

    const term = await authed(token, '/api/instances/a/terminate', {
      method: 'POST',
      body: JSON.stringify({ graceful: false }),
    });
    expect(term.status).toBe(200);
    expect(source.terminateInstance).toHaveBeenCalledWith('a', false);
  });

  it('gets and sets pause state', async () => {
    const token = await pairToken();
    expect((await (await authed(token, '/api/pause')).json()).isPaused).toBe(false);
    const res = await authed(token, '/api/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: true }),
    });
    const state = (await res.json()) as MobilePauseDto;
    expect(state.isPaused).toBe(true);
    expect(state.reasons).toContain('user');
  });

  it('records an APNs token only for the authenticated device', async () => {
    const token = await pairToken();
    const device = registry.listDevices()[0];
    const ok = await authed(token, `/api/devices/${device.deviceId}/apns-token`, {
      method: 'POST',
      body: JSON.stringify({ apnsToken: 'apns-xyz' }),
    });
    expect(ok.status).toBe(200);
    expect(registry.getDeviceById(device.deviceId)?.apnsToken).toBe('apns-xyz');

    const forbidden = await authed(token, `/api/devices/someone-else/apns-token`, {
      method: 'POST',
      body: JSON.stringify({ apnsToken: 'nope' }),
    });
    expect(forbidden.status).toBe(403);
  });

  // ---- Phase 3: create, rename, recent-dirs ----

  it('creates an instance', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances', {
      method: 'POST',
      body: JSON.stringify({ workingDirectory: '/repo/gamma', provider: 'claude', initialPrompt: 'go' }),
    });
    expect(res.status).toBe(200);
    expect(source.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/repo/gamma', provider: 'claude', initialPrompt: 'go' }),
    );
  });

  it('requires workingDirectory to create', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('passes an explicit forceNodeId through to createInstance', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances', {
      method: 'POST',
      body: JSON.stringify({
        workingDirectory: '/repo/gamma',
        initialPrompt: 'run the tests',
        forceNodeId: 'node-123',
      }),
    });
    expect(res.status).toBe(200);
    expect(source.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/repo/gamma', forceNodeId: 'node-123' }),
    );
  });

  it('resolves nodeName to a forceNodeId via the injected resolver', async () => {
    const nodeResolver = vi.fn((nameOrId: string) =>
      nameOrId === 'windows-pc' ? 'node-win' : null,
    );
    server.initialize({
      instanceManager: source,
      registry,
      pauseCoordinator: pause,
      recentDirs: fakeRecentDirs,
      nodeResolver,
    });
    const token = await pairToken();
    const res = await authed(token, '/api/instances', {
      method: 'POST',
      body: JSON.stringify({ workingDirectory: '/repo/gamma', nodeName: 'windows-pc' }),
    });
    expect(res.status).toBe(200);
    expect(nodeResolver).toHaveBeenCalledWith('windows-pc');
    expect(source.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ forceNodeId: 'node-win' }),
    );
  });

  it('returns 404 when nodeName cannot be resolved', async () => {
    server.initialize({
      instanceManager: source,
      registry,
      pauseCoordinator: pause,
      recentDirs: fakeRecentDirs,
      nodeResolver: () => null,
    });
    const token = await pairToken();
    const res = await authed(token, '/api/instances', {
      method: 'POST',
      body: JSON.stringify({ workingDirectory: '/repo/gamma', nodeName: 'ghost-pc' }),
    });
    expect(res.status).toBe(404);
    expect(source.createInstance).not.toHaveBeenCalled();
  });

  it('renames an instance', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/instances/a/rename', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(source.renameInstance).toHaveBeenCalledWith('a', 'Renamed');
  });

  it('lists host recent directories', async () => {
    const token = await pairToken();
    const res = await authed(token, '/api/recent-dirs');
    const dirs = (await res.json()) as { path: string }[];
    expect(dirs.map((d) => d.path)).toEqual(['/repo/alpha', '/repo/beta']);
  });

  // ---- WS snapshot + auth (Phase 0 regression) ----

  it('pushes a snapshot on WS connect and again on instance change', async () => {
    const token = await pairToken();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      const first = await nextOfType(messages, 'snapshot');
      expect((first.data as { instances: unknown[] }).instances).toHaveLength(1);
      expect((first.data as { pause: MobilePauseDto }).pause.isPaused).toBe(false);

      source.instances = [...source.instances, inst({ id: 'b', status: 'idle' })];
      source.emit('instance:created');
      const second = await nextOfType(messages, 'snapshot');
      expect((second.data as { instances: unknown[] }).instances).toHaveLength(2);
    } finally {
      ws.close();
    }
  });

  it('refuses a WS upgrade without a valid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`);
    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    expect(outcome).toBe('error');
    ws.close();
  });

  // ---- APNs push integration ----

  it('sends an APNs push when a prompt arrives and push is configured', async () => {
    await server.stop();
    const { posts } = initServer(true);
    const status = await server.start({ port: 0, bindInterface: 'all' });
    port = status.port!;
    expect(server.getStatus().pushConfigured).toBe(true);

    const token = await pairToken();
    const device = registry.listDevices()[0];
    await authed(token, `/api/devices/${device.deviceId}/apns-token`, {
      method: 'POST',
      body: JSON.stringify({ apnsToken: 'apns-device-1' }),
    });

    source.emit('instance:input-required', {
      instanceId: 'a',
      requestId: 'req-push',
      metadata: { type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'ls' } },
    });
    // push is fire-and-forget; let the microtask/timer settle
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
    expect(posts[0].deviceToken).toBe('apns-device-1');
    expect(JSON.parse(posts[0].payload).aps.alert.title).toContain('Bash');
  });
});
