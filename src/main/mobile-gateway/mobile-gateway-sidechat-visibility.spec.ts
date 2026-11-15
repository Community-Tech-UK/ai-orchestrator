import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WebSocket } from 'ws';
import type { Instance } from '../../shared/types/instance.types';
import type { MobileServerEvent } from '../../shared/types/mobile-gateway.types';
import { createSideChatHarness, type SideChatHarness } from '../chats/side-chat.test-helpers';
import { MobileGatewayPromptStore } from './mobile-gateway-prompt-store';
import { MobileGatewaySnapshotService } from './mobile-gateway-snapshot';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

describe('phone visibility of a ChatService sidechat runtime', () => {
  let h: SideChatHarness;
  let runtime: Instance;
  let parent: Instance;
  let reviewer: Instance;
  let automation: Instance;
  let other: Instance;
  let service: MobileGatewaySnapshotService;
  let prompts: MobileGatewayPromptStore;
  let received: Record<'owner' | 'member', MobileServerEvent[]>;
  let getInstances: Mock<() => Instance[]>;

  beforeEach(async () => {
    h = createSideChatHarness();
    await h.service.whenReady();
    parent = h.runtimes.addSession({ historyThreadId: 'parent', workingDirectory: '/work', displayName: 'Parent' });
    const detail = await h.service.sideChats.create({
      parent: { kind: 'session', historyThreadId: 'parent', originNodeId: null },
      selection: { provider: 'claude', model: 'sonnet' }, currentCwd: '/work',
    });
    const sent = await h.service.sideChats.send({ chatId: detail.chat.id, text: 'What changed?' });
    expect(sent.ok).toBe(true);
    runtime = h.runtimes.getInstance((await h.service.getChat(detail.chat.id)).chat.currentInstanceId!)!;
    h.runtimes.setStatus(runtime.id, 'waiting_for_permission');
    reviewer = h.runtimes.addSession({ historyThreadId: 'reviewer', workingDirectory: '/work', displayName: 'Reviewer' });
    reviewer.metadata = { hideFromProjectRail: true };
    automation = h.runtimes.addSession({ historyThreadId: 'automation', workingDirectory: '/work', displayName: 'Automation' });
    automation.metadata = { automationHidden: true };
    other = h.runtimes.addSession({ historyThreadId: 'other', workingDirectory: '/other', displayName: 'Other person' });

    received = { owner: [], member: [] };
    const client = (profile: 'owner' | 'member') => ({
      readyState: WebSocket.OPEN,
      send: (raw: string) => received[profile].push(JSON.parse(raw) as MobileServerEvent),
    } as unknown as WebSocket);
    const ownerClient = client('owner');
    const memberClient = client('member');
    prompts = new MobileGatewayPromptStore({
      broadcast: event => service.broadcast(event),
      scheduleSnapshotBroadcast: () => undefined, sendPush: () => undefined,
    });
    getInstances = vi.fn(() => h.runtimes.getAllInstances());
    const deps = {
      clients: new Set([ownerClient, memberClient]), isRunning: () => false,
      getInstances, getInstance: (id: string) => h.runtimes.getInstance(id),
      getPrompts: () => prompts.values(),
      getPauseState: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }),
      getActiveLoops: () => [], hasUnreadCompletion: () => false, getQueuedMessages: () => undefined,
      profileOfClient: (client: WebSocket) => client === ownerClient ? 'owner' : 'member',
      profileOfInstance: (id: string) => id === other.id ? 'owner' : 'member',
    };
    service = new MobileGatewaySnapshotService(deps);
  });

  afterEach(async () => { service?.stop(); await h.dispose(); });

  function ask(instance: Instance): void {
    prompts.handleInputRequired({ instanceId: instance.id, requestId: `approval-${instance.id}`, prompt: 'Allow reading the file?' });
  }

  it('keeps the runtime out of snapshot rows and counts while delivering its approval only to its person', () => {
    ask(runtime);
    ask(reviewer);
    ask(automation);
    ask(other);
    const snapshot = service.buildSnapshot('member');

    expect(snapshot.instances.map(instance => instance.id)).toEqual([parent.id, reviewer.id, automation.id]);
    expect(snapshot.projects.map(project => project.sessionCount)).toEqual([3]);
    expect(snapshot.prompts.map(prompt => prompt.instanceId)).toEqual([runtime.id, reviewer.id, automation.id]);
    expect(service.buildSnapshot('owner').prompts.map(prompt => prompt.instanceId)).toEqual([other.id]);
    expect(received.member.map(event => event.type === 'permission-prompt' ? event.data.instanceId : event.type))
      .toEqual([runtime.id, reviewer.id, automation.id]);
    expect(received.owner.map(event => event.type === 'permission-prompt' ? event.data.instanceId : event.type))
      .toEqual([other.id]);
    prompts.handleInputRequiredResolved({ requestId: `approval-${runtime.id}` });
    expect(service.buildSnapshot('member').prompts.map(prompt => prompt.instanceId)).toEqual([reviewer.id, automation.id]);
    expect(received.member.at(-1)).toEqual({ type: 'permission-cleared', data: { requestId: `approval-${runtime.id}`, instanceId: runtime.id } });
  });

  it.each(['instance-created', 'instance-state'] as const)('filters %s rows before the next snapshot, keeping background approval exceptions', type => {
    ask(runtime);
    ask(reviewer);
    ask(automation);
    received.member = [];
    received.owner = [];
    const instances = [runtime, parent, reviewer, automation, other];
    if (type === 'instance-created') {
      for (const instance of instances) service.broadcast({ type, data: service.serializeInstance(instance) });
    } else {
      service.broadcast({ type, data: instances.map(instance => service.serializeInstance(instance)) });
    }
    const ids = (profile: 'owner' | 'member') => received[profile].flatMap(event =>
      event.type === 'instance-created' ? [event.data.id]
        : event.type === 'instance-state' ? event.data.map(instance => instance.id) : []);
    expect(ids('member')).toEqual([parent.id, reviewer.id, automation.id]);
    expect(ids('owner')).toEqual([other.id]);
    expect(getInstances).not.toHaveBeenCalled();

    prompts.clearForInstance(reviewer.id);
    prompts.clearForInstance(automation.id);
    received.member = [];
    if (type === 'instance-created') {
      for (const instance of [reviewer, automation]) service.broadcast({ type, data: service.serializeInstance(instance) });
    } else {
      service.broadcast({ type, data: [reviewer, automation].map(instance => service.serializeInstance(instance)) });
    }
    expect(received.member).toEqual([]);
  });
});
