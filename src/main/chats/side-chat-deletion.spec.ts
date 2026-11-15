import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSideChatHarness, type SideChatHarness } from './side-chat.test-helpers';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({
  getActiveLoops: () => [], cancelLoop: vi.fn(async () => true),
}) }));

describe('sidechat deletion', () => {
  const harnesses: SideChatHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.reverse()) await harness.dispose();
    harnesses.length = 0;
  });

  async function setup(options?: Parameters<typeof createSideChatHarness>[1]) {
    const h = createSideChatHarness(undefined, options);
    harnesses.push(h);
    const { chat: parent } = await h.service.createChat({ provider: 'claude', currentCwd: '/work' });
    const ref = { kind: 'chat' as const, chatId: parent.id };
    const { chat: side } = await h.service.sideChats.create({
      parent: ref, selection: { provider: 'claude', model: null }, currentCwd: '/work',
    });
    return { h, parent, ref, side };
  }

  it('discards a running sidechat, its conversation, context, read state and last policy', async () => {
    const { h, parent, ref, side } = await setup();
    await h.service.sideChats.send({ chatId: side.id, text: 'Explain this task' });
    const runtime = (await h.service.getChat(side.id)).chat.currentInstanceId!;
    h.runtimes.setStatus(runtime, 'waiting_for_permission');

    await h.service.sideChats.discard(side.id);

    expect(h.runtimes.getInstance(runtime)?.status).toBe('terminated');
    expect(h.service.tryGetChat(side.id)).toBeNull();
    expect(await h.ledger.getThread(side.ledgerThreadId)).toBeNull();
    expect(h.db.prepare('SELECT * FROM side_chat_links WHERE chat_id = ?').get(side.id)).toBeUndefined();
    expect(h.db.prepare('SELECT * FROM side_chat_context_snapshots WHERE chat_id = ?').get(side.id)).toBeUndefined();
    expect(h.db.prepare('SELECT * FROM side_chat_policies WHERE parent_key = ?').get(`chat:${parent.id}`)).toBeUndefined();
    expect(await h.service.sideChats.attention(ref)).toMatchObject({ total: 0, needsAttention: 0, unread: 0 });
    expect(h.service.tryGetChat(parent.id)).not.toBeNull();
  });

  it('refuses to discard an ordinary chat through the sidechat action', async () => {
    const { h, parent } = await setup();
    await expect(h.service.sideChats.discard(parent.id)).rejects.toThrow('not a sidechat');
    expect(h.service.tryGetChat(parent.id)).not.toBeNull();
  });

  it('excludes sidechats from persisted main-view tab and selection state', async () => {
    const { h, parent, side } = await setup();
    h.service.setUiState({ selectedChatId: side.id, openChatIds: [parent.id, side.id] });
    expect(h.service.getUiState()).toMatchObject({ selectedChatId: parent.id, openChatIds: [parent.id] });
    expect((await h.service.getChat(side.id)).chat.id).toBe(side.id);
  });

  it('retains shared policy until the last sibling is discarded', async () => {
    const { h, parent, ref, side } = await setup();
    const { chat: sibling } = await h.service.sideChats.create({
      parent: ref, selection: { provider: 'claude', model: null }, currentCwd: '/work',
    });
    await h.service.sideChats.discard(side.id);
    expect(h.db.prepare('SELECT * FROM side_chat_policies WHERE parent_key = ?').get(`chat:${parent.id}`)).toBeDefined();
    await h.service.sideChats.discard(sibling.id);
    expect(h.db.prepare('SELECT * FROM side_chat_policies WHERE parent_key = ?').get(`chat:${parent.id}`)).toBeUndefined();
  });

  it.each(['last-sidechat', 'parent'] as const)('does not restore policy when permission lookup finishes after deleting %s', async (target) => {
    let pause = false;
    let release!: () => void;
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const { h, parent, ref, side } = await setup({
      resolveAgentPermissions: async () => {
        if (pause) {
          started();
          await resume;
        }
        return { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' };
      },
    });
    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toHaveLength(1);
    pause = true;
    const pending = h.service.sideChats.permissions(ref);
    await entering;

    if (target === 'parent') await h.service.deleteChat(parent.id);
    else await h.service.sideChats.discard(side.id);
    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toEqual([]);
    release();
    await pending;

    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_links').all()).toEqual([]);
  });

  it('does not persist a permission preview after the final sidechat is discarded', async () => {
    const { h, ref, side } = await setup();
    await h.service.sideChats.discard(side.id);

    expect(await h.service.sideChats.permissions(ref)).toMatchObject({ ok: true, source: 'live-parent' });

    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toEqual([]);
  });

  it('deletes every owned sidechat with its parent, including archived records', async () => {
    const { h, parent, ref, side } = await setup();
    const { chat: sibling } = await h.service.sideChats.create({
      parent: ref, selection: { provider: 'claude', model: null }, currentCwd: '/work',
    });
    await h.service.archiveChat(sibling.id);
    await h.service.sideChats.send({ chatId: side.id, text: 'Running answer' });

    await h.service.deleteChat(parent.id);

    expect(h.service.listChats({ includeArchived: true })).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_links').all()).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toEqual([]);
    expect(await h.ledger.getThread(side.ledgerThreadId)).toBeNull();
    expect(await h.ledger.getThread(sibling.ledgerThreadId)).toBeNull();
  });

  it('keeps sidechats when their parent is archived', async () => {
    const { h, parent, ref, side } = await setup();
    await h.service.archiveChat(parent.id);
    expect(h.service.tryGetChat(side.id)).not.toBeNull();
    expect((await h.service.sideChats.list(ref)).map((item) => item.chat.id)).toEqual([side.id]);
  });

  it('keeps the parent conversation when its sidechat runtime cannot be stopped', async () => {
    const { h, parent, side } = await setup();
    await h.service.sideChats.send({ chatId: side.id, text: 'Still running' });
    vi.spyOn(h.runtimes, 'terminateInstance').mockRejectedValueOnce(new Error('Stop failed'));

    await expect(h.service.deleteChat(parent.id)).rejects.toThrow('Stop failed');

    expect(h.service.tryGetChat(parent.id)).not.toBeNull();
    expect(await h.ledger.getThread(parent.ledgerThreadId)).not.toBeNull();
    expect(h.service.tryGetChat(side.id)).not.toBeNull();
  });

  it('waits for an admitted send before deleting the runtime it creates', async () => {
    const { h, side } = await setup();
    let release!: () => void;
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const createRuntime = h.runtimes.createInstance.bind(h.runtimes);
    vi.spyOn(h.runtimes, 'createInstance').mockImplementationOnce(async (config) => {
      started();
      await resume;
      return createRuntime(config);
    });
    const send = h.service.sideChats.send({ chatId: side.id, text: 'Race with discard' });
    await entering;
    const discard = h.service.sideChats.discard(side.id);
    release();
    await send;
    await discard;

    expect(h.service.tryGetChat(side.id)).toBeNull();
    expect(h.runtimes.getAllInstances().filter((instance) => instance.status !== 'terminated')).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_context_snapshots').all()).toEqual([]);
  });

  it('rejects a sidechat whose parent was deleted while its ledger thread was being created', async () => {
    const { h, parent, ref, side } = await setup();
    await h.service.sideChats.discard(side.id);
    let release!: () => void;
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const startConversation = h.ledger.startConversation.bind(h.ledger);
    let createdThreadId = '';
    vi.spyOn(h.ledger, 'startConversation').mockImplementationOnce(async (input) => {
      const thread = await startConversation(input);
      createdThreadId = thread.id;
      started();
      await resume;
      return thread;
    });
    const creating = h.service.sideChats.create({
      parent: ref, selection: { provider: 'claude', model: null }, currentCwd: '/work',
    });
    const outcome = creating.then(() => 'created', () => 'refused');
    await entering;
    await h.service.deleteChat(parent.id);
    release();

    expect(await outcome).toBe('refused');
    expect(h.service.listChats({ includeArchived: true })).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_links').all()).toEqual([]);
    expect(await h.ledger.getThread(createdThreadId)).toBeNull();
  });
});
