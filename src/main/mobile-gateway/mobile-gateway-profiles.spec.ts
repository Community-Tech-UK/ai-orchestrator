import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
import { WebSocket } from 'ws';
import { MobileGatewayServer, type GatewayInstanceSource, type GatewayPauseSource } from './mobile-gateway-server';
import { MobileDeviceRegistry, type MobileDevicePersistence } from './mobile-device-registry';
import { MobileApnsSender } from './mobile-apns-sender';
import { MOBILE_PROFILE_METADATA_KEY } from '../../shared/utils/mobile-profile-stamp';
import { _resetIdempotencyStoreForTesting } from '../transport/idempotency-store';
import type { Instance } from '../../shared/types/instance.types';
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

class FakeInstanceSource extends EventEmitter {
  instances: Instance[] = [];
  readonly orchestration = Object.assign(new EventEmitter(), { respondToUserAction: vi.fn() });
  sendInput = vi.fn(async () => undefined);
  steerInput = vi.fn(async () => undefined);
  interruptInstance = vi.fn(() => true);
  terminateInstance = vi.fn(async () => undefined);
  changeModel = vi.fn();
  resumeAfterDeferredPermission = vi.fn(async () => undefined);
  recordInputRequiredPermissionDecision = vi.fn();
  clearPendingInputRequiredPermission = vi.fn();
  renameInstance = vi.fn();
  createInstance = vi.fn();
  restoreFromHistory = vi.fn();
  wakeInstance = vi.fn(async () => undefined);
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
  addReason = vi.fn();
  removeReason = vi.fn();
}

function memPersistence(): MobileDevicePersistence {
  let devices: string | undefined;
  let profiles: string | undefined;
  return {
    load: () => devices,
    save: (json) => {
      devices = json;
    },
    loadProfiles: () => profiles,
    saveProfiles: (json) => {
      profiles = json;
    },
  };
}

const TEST_P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

function recordingApnsSender() {
  const tokens: string[] = [];
  const sender = new MobileApnsSender({
    now: () => 1_700_000_000_000,
    configProvider: () => ({
      keyP8: TEST_P8,
      keyId: 'ABCDE12345',
      teamId: 'TEAM123456',
      bundleId: 'com.example.app',
      production: false,
    }),
    transport: {
      post: async (args) => {
        tokens.push(args.deviceToken);
        return { status: 200 };
      },
    },
  });
  return { sender, tokens };
}

/** Collects every frame from the moment the socket is created. */
function collect(ws: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return frames;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotIds(frame: Record<string, unknown> | undefined): string[] {
  const data = frame?.['data'] as { instances: { id: string }[] } | undefined;
  return (data?.instances ?? []).map((i) => i.id);
}

describe('MobileGatewayServer with a second person', () => {
  let server: MobileGatewayServer;
  let source: FakeInstanceSource;
  let registry: MobileDeviceRegistry;
  let pushTokens: string[];
  let completionViewed: ReturnType<typeof vi.fn<(instanceId: string) => void>>;
  let port: number;
  let memberProfileId: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    _resetIdempotencyStoreForTesting();
    registry = new MobileDeviceRegistry(memPersistence());
    memberProfileId = registry.addMember('Second person').profileId;
    source = new FakeInstanceSource();
    source.instances = [
      inst({ id: 'owner-session', status: 'idle' }),
      inst({
        id: 'member-session',
        status: 'idle',
        workingDirectory: '/home/member/notes',
        metadata: { [MOBILE_PROFILE_METADATA_KEY]: memberProfileId },
      }),
    ];
    completionViewed = vi.fn<(instanceId: string) => void>();
    const { sender, tokens } = recordingApnsSender();
    pushTokens = tokens;
    server = new MobileGatewayServer();
    server.initialize({
      instanceManager: source as unknown as GatewayInstanceSource,
      registry,
      pauseCoordinator: new FakePause(),
      recentDirs: { getDirectories: async () => [] },
      accountProfiles: () => [
        { id: 'acct-claude', provider: 'claude', label: 'Claude A', enabled: true, isLegacy: false, priority: 0 },
        { id: 'acct-codex', provider: 'codex', label: 'Codex A', enabled: true, isLegacy: false, priority: 0 },
        { id: 'acct-owner-only', provider: 'claude', label: 'Claude B', enabled: true, isLegacy: false, priority: 1 },
      ],
      apnsSender: sender,
      loopCoordinator: Object.assign(new EventEmitter(), { getActiveLoops: () => [] }),
      onCompletionViewed: completionViewed,
    });
    const status = await server.start({ port: 0, bindInterface: 'all' });
    port = status.port!;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server.stop();
  });

  async function pair(profileId?: string): Promise<{ token: string; deviceId: string }> {
    const pairing = registry.issuePairing(profileId ? { profileId } : {});
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: pairing.pairingToken, label: 'Phone' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { token: string; deviceId: string };
  }

  function call(token: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function connect(token: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['aio.v1', `bearer.${token}`]);
    sockets.push(ws);
    const frames = collect(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await until(() => frames.some((f) => f['type'] === 'snapshot'));
    return { ws, frames };
  }

  it('gives each person a snapshot of only their own sessions', async () => {
    const owner = await pair();
    const member = await pair(memberProfileId);

    const ownerSnapshot = (await (await call(owner.token, '/api/snapshot')).json()) as Record<string, unknown>;
    const memberSnapshot = (await (await call(member.token, '/api/snapshot')).json()) as Record<string, unknown>;
    expect(snapshotIds({ data: ownerSnapshot })).toEqual(['owner-session']);
    expect(snapshotIds({ data: memberSnapshot })).toEqual(['member-session']);

    const memberList = (await (await call(member.token, '/api/instances')).json()) as { id: string }[];
    expect(memberList.map((i) => i.id)).toEqual(['member-session']);
    const ownerList = (await (await call(owner.token, '/api/instances')).json()) as { id: string }[];
    expect(ownerList.map((i) => i.id)).toEqual(['owner-session']);
  });

  it("treats the owner's sessions as missing for a member and leaves them untouched", async () => {
    const member = await pair(memberProfileId);

    for (const [path, method, body] of [
      ['/api/instances/owner-session/messages', 'GET', undefined],
      ['/api/instances/owner-session/input', 'POST', { message: 'hello' }],
      ['/api/instances/owner-session/interrupt', 'POST', {}],
      ['/api/instances/owner-session/terminate', 'POST', {}],
      ['/api/instances/owner-session/rename', 'POST', { displayName: 'x' }],
      ['/api/instances/owner-session/viewed', 'POST', {}],
      ['/api/instances/owner-session/queue/q1', 'DELETE', undefined],
      ['/api/instances/no-such-session/messages', 'GET', undefined],
    ] as const) {
      const res = await call(member.token, path, method, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(source.sendInput).not.toHaveBeenCalled();
    expect(source.interruptInstance).not.toHaveBeenCalled();
    expect(source.terminateInstance).not.toHaveBeenCalled();
    expect(source.renameInstance).not.toHaveBeenCalled();
    expect(completionViewed).not.toHaveBeenCalled();
  });

  it('lets a member use their own session', async () => {
    const member = await pair(memberProfileId);

    const res = await call(member.token, '/api/instances/member-session/input', 'POST', { message: 'hello' });

    expect(res.status).toBe(200);
    expect(source.sendInput).toHaveBeenCalledWith('member-session', 'hello', undefined, {
      origin: { kind: 'person', typedAt: expect.any(Number) },
    });
  });

  it('refuses a member everything outside their own sessions', async () => {
    const member = await pair(memberProfileId);

    for (const [path, method, body] of [
      ['/api/pause', 'POST', { paused: true }],
      ['/api/automations', 'GET', undefined],
      ['/api/session-plan', 'GET', undefined],
      ['/api/quota', 'GET', undefined],
      ['/api/loops', 'GET', undefined],
      ['/api/plan-queue', 'GET', undefined],
      ['/api/doc-reviews', 'GET', undefined],
      ['/api/browser-approvals/req-1/respond', 'POST', { approved: true }],
      ['/api/history/entry-1/continue', 'POST', {}],
      // Their own sessions wake when they send a message; the separate wake route has no member check yet.
      ['/api/instances/member-session/wake', 'POST', {}],
      ['/api/something-added-later', 'GET', undefined],
    ] as const) {
      const res = await call(member.token, path, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(source.createInstance).not.toHaveBeenCalled();
    expect(source.restoreFromHistory).not.toHaveBeenCalled();
    expect(source.wakeInstance).not.toHaveBeenCalled();
    // Pausing stops their work too, so they can see it.
    expect((await call(member.token, '/api/pause')).status).toBe(200);
  });

  it("gives a member empty lists instead of the owner's folders and history", async () => {
    const member = await pair(memberProfileId);

    for (const path of ['/api/recent-dirs', '/api/history']) {
      const res = await call(member.token, path);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it("marks a member's snapshot so the phone can hide the owner's areas", async () => {
    const owner = await pair();
    const member = await pair(memberProfileId);

    expect(((await (await call(owner.token, '/api/snapshot')).json()) as { isOwner: boolean }).isOwner).toBe(true);
    expect(((await (await call(member.token, '/api/snapshot')).json()) as { isOwner: boolean }).isOwner).toBe(false);
  });

  describe('starting a session as a member', () => {
    const memberSession = {
      workerNodeId: 'her-worker',
      workingDirectory: '/home/member/work',
      allowedAccountProfileIds: ['acct-claude', 'acct-codex'],
    };

    beforeEach(() => {
      source.createInstance.mockImplementation(async (config: { workingDirectory: string }) =>
        inst({ id: 'new-session', workingDirectory: config.workingDirectory }));
    });

    it('refuses until the owner has set up a computer, a folder and an account', async () => {
      const member = await pair(memberProfileId);

      const res = await call(member.token, '/api/instances', 'POST', { workingDirectory: '/tmp' });

      expect(res.status).toBe(409);
      expect(source.createInstance).not.toHaveBeenCalled();
    });

    it('sets the folder, computer, accounts and approvals itself and ignores what the phone sends', async () => {
      registry.setMemberSession(memberProfileId, memberSession);
      const member = await pair(memberProfileId);

      const res = await call(member.token, '/api/instances', 'POST', {
        workingDirectory: '/Users/owner/work',
        forceNodeId: 'owner-worker',
        nodeName: 'owner-mac',
        yoloMode: false,
        allowedAccountProfileIds: ['acct-owner-only'],
        metadata: { mobileProfileId: 'owner' },
        provider: 'codex',
        model: 'a-model',
        initialPrompt: 'hello',
      });

      expect(res.status).toBe(200);
      expect(source.createInstance).toHaveBeenCalledTimes(1);
      const config = source.createInstance.mock.calls[0][0] as Record<string, unknown>;
      expect(config).toMatchObject({
        workingDirectory: '/home/member/work',
        forceNodeId: 'her-worker',
        allowedAccountProfileIds: ['acct-claude', 'acct-codex'],
        yoloMode: true,
        provider: 'codex',
        modelOverride: 'a-model',
        initialPrompt: 'hello',
        metadata: { [MOBILE_PROFILE_METADATA_KEY]: memberProfileId },
      });
      expect(config['nodeName']).toBeUndefined();
    });

    it('starts on Claude when the phone leaves the provider on Auto', async () => {
      registry.setMemberSession(memberProfileId, memberSession);
      const member = await pair(memberProfileId);

      await call(member.token, '/api/instances', 'POST', { provider: 'auto' });

      expect(source.createInstance.mock.calls[0][0]).toMatchObject({ provider: 'claude' });
    });

    it('refuses a provider the owner cannot limit to one person, or one with no account for them', async () => {
      registry.setMemberSession(memberProfileId, { ...memberSession, allowedAccountProfileIds: ['acct-claude'] });
      const member = await pair(memberProfileId);

      expect((await call(member.token, '/api/instances', 'POST', { provider: 'gemini' })).status).toBe(400);
      expect((await call(member.token, '/api/instances', 'POST', { provider: 'codex' })).status).toBe(409);
      expect(source.createInstance).not.toHaveBeenCalled();
    });

    it('refuses a session start with malformed or oversized attachments, for a member and for the owner', async () => {
      registry.setMemberSession(memberProfileId, memberSession);
      const member = await pair(memberProfileId);
      const owner = await pair();
      const tooMany = Array.from({ length: 11 }, () => ({ name: 'a.png', type: 'image/png', size: 1, data: 'x' }));

      for (const token of [member.token, owner.token]) {
        expect((await call(token, '/api/instances', 'POST', { workingDirectory: '/tmp', attachments: tooMany })).status).toBe(400);
        expect((await call(token, '/api/instances', 'POST', { workingDirectory: '/tmp', attachments: [{ name: 'a', type: 'b', size: -1, data: 'x' }] })).status).toBe(400);
        expect((await call(token, '/api/instances', 'POST', { workingDirectory: '/tmp', attachments: 'nope' })).status).toBe(400);
      }
      expect(source.createInstance).not.toHaveBeenCalled();
    });

    it("starts the owner's sessions in the folder the phone names, as before", async () => {
      const owner = await pair();

      await call(owner.token, '/api/instances', 'POST', { workingDirectory: '/Users/owner/work', forceNodeId: 'owner-worker' });

      expect(source.createInstance.mock.calls[0][0]).toMatchObject({
        workingDirectory: '/Users/owner/work',
        forceNodeId: 'owner-worker',
      });
      expect(source.createInstance.mock.calls[0][0]).not.toHaveProperty('metadata');
    });

    it('leaves a browser approval to the owner even when the member names its session', async () => {
      const member = await pair(memberProfileId);
      (server as unknown as { promptStore: { syncBrowser(prompts: unknown[]): void } }).promptStore.syncBrowser([
        {
          id: 'browser-1', instanceId: 'member-session', requestId: 'browser-1', kind: 'browser',
          title: 'Allow', message: 'Allow', createdAt: 1,
        },
      ]);

      const res = await call(member.token, '/api/instances/member-session/respond', 'POST', {
        requestId: 'browser-1', decisionAction: 'allow',
      });

      expect(res.status).toBe(403);
      expect(source.resumeAfterDeferredPermission).not.toHaveBeenCalled();
    });
  });

  it('streams prompts only to the person whose session asked', async () => {
    const owner = await pair();
    const member = await pair(memberProfileId);
    const ownerSocket = await connect(owner.token);
    const memberSocket = await connect(member.token);
    expect(snapshotIds(ownerSocket.frames.find((f) => f['type'] === 'snapshot'))).toEqual(['owner-session']);
    expect(snapshotIds(memberSocket.frames.find((f) => f['type'] === 'snapshot'))).toEqual(['member-session']);

    source.emit('instance:input-required', { instanceId: 'owner-session', requestId: 'r-owner' });
    source.emit('instance:input-required', { instanceId: 'member-session', requestId: 'r-member' });

    const promptIds = (frames: Record<string, unknown>[]) =>
      frames
        .filter((f) => f['type'] === 'permission-prompt')
        .map((f) => (f['data'] as { requestId: string }).requestId);
    await until(() => promptIds(ownerSocket.frames).length > 0 && promptIds(memberSocket.frames).length > 0);
    await until(() => ownerSocket.frames.filter((f) => f['type'] === 'snapshot').length > 1);
    await until(() => memberSocket.frames.filter((f) => f['type'] === 'snapshot').length > 1);

    expect(promptIds(ownerSocket.frames)).toEqual(['r-owner']);
    expect(promptIds(memberSocket.frames)).toEqual(['r-member']);
    const lastMemberSnapshot = memberSocket.frames.filter((f) => f['type'] === 'snapshot').at(-1);
    const memberPrompts = (lastMemberSnapshot?.['data'] as { prompts: { requestId: string }[] }).prompts;
    expect(memberPrompts.map((p) => p.requestId)).toEqual(['r-member']);
    expect((await (await call(member.token, '/api/prompts')).json()) as unknown[]).toHaveLength(1);
  });

  it('sends alerts only to the phones of the person concerned', async () => {
    const owner = await pair();
    const member = await pair(memberProfileId);
    registry.setApnsToken(owner.deviceId, 'owner-push-placeholder');
    registry.setApnsToken(member.deviceId, 'member-push-placeholder');

    source.emit('instance:input-required', { instanceId: 'member-session', requestId: 'r-member' });
    await until(() => pushTokens.length > 0);
    source.emit('instance:input-required', { instanceId: 'owner-session', requestId: 'r-owner' });
    await until(() => pushTokens.length > 1);

    expect(pushTokens).toEqual(['member-push-placeholder', 'owner-push-placeholder']);
  });

  it("ignores a member's view of the owner's session", async () => {
    const member = await pair(memberProfileId);
    const { ws } = await connect(member.token);

    ws.send(JSON.stringify({ type: 'view', instanceId: 'owner-session' }));
    ws.send(JSON.stringify({ type: 'view', instanceId: 'member-session' }));
    await until(() => completionViewed.mock.calls.length > 0);

    expect(completionViewed.mock.calls).toEqual([['member-session']]);
  });

  it("refuses a member's Live Activity for the owner's session", async () => {
    const member = await pair(memberProfileId);

    const refused = await call(member.token, `/api/devices/${member.deviceId}/live-activity-token`, 'POST', {
      instanceId: 'owner-session',
      token: 'activity-placeholder',
    });
    const accepted = await call(member.token, `/api/devices/${member.deviceId}/live-activity-token`, 'POST', {
      instanceId: 'member-session',
      token: 'activity-placeholder',
    });

    expect(refused.status).toBe(404);
    expect(accepted.status).toBe(200);
  });

  it("removing a person cuts their phone's live connection and its token", async () => {
    const member = await pair(memberProfileId);
    const { ws } = await connect(member.token);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

    expect(registry.removeMember(memberProfileId)).toBe(true);

    expect(await closed).toBe(4001);
    expect((await call(member.token, '/api/snapshot')).status).toBe(401);
  });

  it("hands a removed person's sessions to the owner", async () => {
    const owner = await pair();
    registry.removeMember(memberProfileId);

    const list = (await (await call(owner.token, '/api/instances')).json()) as { id: string }[];

    expect(list.map((i) => i.id).sort()).toEqual(['member-session', 'owner-session']);
  });
});
