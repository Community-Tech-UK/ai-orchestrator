import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SideChatParentRef } from '../../shared/types/side-chat.types';
import { createSideChatHarness, PLAN_PERMISSIONS, type SideChatHarness } from './side-chat.test-helpers';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

const CLAUDE = { provider: 'claude' as const, model: null };

describe('SideChatService', () => {
  const harnesses: SideChatHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.reverse()) await harness.dispose();
    harnesses.length = 0;
  });

  function harness(): SideChatHarness {
    const created = createSideChatHarness();
    harnesses.push(created);
    return created;
  }

  async function codexParent(h: SideChatHarness, cwd = '/work/aio') {
    const parent = await h.service.createChat({ provider: 'codex', currentCwd: cwd, name: 'Provider Hardening' });
    await h.service.sendMessage({
      chatId: parent.chat.id,
      text: 'Implement docs/plans/provider-hardening_plan.md. Do not touch the billing module.',
    });
    await h.service.appendSystemEvent({
      chatId: parent.chat.id,
      nativeMessageId: 'progress-1',
      role: 'assistant',
      content: 'Phase 1 and 2 are done. Phase 3 (retry budget) is next; phase 4 remains.',
    });
    return parent;
  }

  describe('creation and ownership', () => {
    it('links a sidechat atomically, spawns nothing, and uses the parent workspace', async () => {
      const h = harness();
      const parent = await codexParent(h, '/work/aio');
      const spawnsBefore = h.runtimes.creates.length;

      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id },
        selection: CLAUDE,
        currentCwd: '/somewhere/else',
      });

      expect(h.runtimes.creates).toHaveLength(spawnsBefore);
      expect(side.chat.currentCwd).toBe('/work/aio');
      expect(side.chat.sideChatParentKey).toBe(`chat:${parent.chat.id}`);
      expect(parent.chat.sideChatParentKey).toBeNull();
      expect(side.chat.ledgerThreadId).not.toBe(parent.chat.ledgerThreadId);
      expect(h.service.sideChats.getLink(side.chat.id)).toEqual({
        chatId: side.chat.id,
        parent: { kind: 'chat', chatId: parent.chat.id },
        authority: 'inherit-parent',
        lastReadAssistantSequence: 0,
      });
    });

    it('keeps several concurrently created sidechats independent per parent', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };

      const [a, b] = await Promise.all([
        h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' }),
        h.service.sideChats.create({ parent: ref, selection: { provider: 'codex', model: 'gpt-5.5' }, currentCwd: '/work/aio' }),
      ]);
      await h.service.sendMessage({ chatId: a.chat.id, text: 'Question for A' });

      const list = await h.service.sideChats.list(ref);
      expect(list.map((item) => item.chat.id).sort()).toEqual([a.chat.id, b.chat.id].sort());
      expect(list.find((item) => item.chat.id === b.chat.id)?.chat.provider).toBe('codex');
      expect((await h.service.getChat(b.chat.id)).conversation.messages).toEqual([]);
    });

    it('never shares ownership between two sessions in the same directory', async () => {
      const h = harness();
      h.runtimes.addSession({ historyThreadId: 'thread-a', workingDirectory: '/work/same', displayName: 'Session A' });
      h.runtimes.addSession({ historyThreadId: 'thread-b', workingDirectory: '/work/same', displayName: 'Session B' });
      const refA: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-a', originNodeId: null };
      const refB: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-b', originNodeId: null };

      const sideA = await h.service.sideChats.create({ parent: refA, selection: CLAUDE, currentCwd: '/work/same' });

      expect((await h.service.sideChats.list(refA)).map((item) => item.chat.id)).toEqual([sideA.chat.id]);
      expect(await h.service.sideChats.list(refB)).toEqual([]);
    });

    it('attaches an existing chat only explicitly, without making old answers unread', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };
      const loose = await h.service.createChat({ provider: 'claude', currentCwd: '/work/aio', name: 'Loose' });
      await h.service.appendSystemEvent({
        chatId: loose.chat.id, nativeMessageId: 'old-answer', role: 'assistant', content: 'Old answer',
      });

      await h.service.sideChats.attach(loose.chat.id, ref);
      const attention = await h.service.sideChats.attention(ref);

      expect(h.service.sideChats.getLink(loose.chat.id)?.parent).toEqual(ref);
      expect(h.service.listChats().find((chat) => chat.id === loose.chat.id)?.sideChatParentKey)
        .toBe(`chat:${parent.chat.id}`);
      expect(attention.unread).toBe(0);
      await expect(h.service.sideChats.attach(loose.chat.id, ref)).rejects.toThrow('already a sidechat');
      await expect(h.service.sideChats.attach(parent.chat.id, { kind: 'chat', chatId: loose.chat.id }))
        .rejects.toThrow('own sidechats');
    });

    it('drops an archived sidechat from active counts but keeps it reopenable', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });

      await h.service.archiveChat(side.chat.id);

      expect(await h.service.sideChats.list(ref)).toEqual([]);
      expect((await h.service.sideChats.attention(ref)).total).toBe(0);
      expect(h.service.sideChats.listArchived(ref).map((chat) => chat.id)).toEqual([side.chat.id]);
    });
  });

  describe('parent context delivery', () => {
    it('answers the screenshot question with the parent task and latest progress, without touching the parent', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const parentRuntime = parent.chat.currentInstanceId ?? (await h.service.getChat(parent.chat.id)).chat.currentInstanceId!;
      const parentInputs = h.runtimes.inputsFor(parentRuntime).length;
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });

      const result = await h.service.sideChats.send({
        chatId: side.chat.id, text: 'How far through this are you? What\'s left to do?',
      });

      expect(result).toMatchObject({ ok: true, usedStaleContext: false });
      const sideRuntime = h.runtimes.creates.at(-1)!;
      expect(sideRuntime.provider).toBe('claude');
      const delivered = h.runtimes.preambles.at(-1)!;
      expect(delivered).toContain('<parent_context');
      expect(delivered).toContain('Implement docs/plans/provider-hardening_plan.md');
      expect(delivered).toContain('Phase 3 (retry budget) is next');
      expect(h.runtimes.inputs.at(-1)?.message).toBe('How far through this are you? What\'s left to do?');
      expect(h.runtimes.inputsFor(parentRuntime)).toHaveLength(parentInputs);
      expect(h.runtimes.terminations).not.toContain(parentRuntime);
    });

    it('refreshes context per question and resends only when the parent changed', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First question' });
      const sideRuntime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      h.runtimes.setStatus(sideRuntime, 'idle');

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Anything new?' });
      expect(h.runtimes.preambles.at(-1)).toBeUndefined();

      await h.service.appendSystemEvent({
        chatId: parent.chat.id, nativeMessageId: 'progress-2', role: 'assistant',
        content: 'Phase 3 finished; phase 4 (docs) is underway.',
      });
      h.runtimes.setStatus(sideRuntime, 'idle');
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'And now?' });

      const superseding = h.runtimes.preambles.at(-1)!;
      expect(superseding).toContain('supersedes the earlier snapshot');
      expect(superseding).toContain('phase 4 (docs) is underway');
      expect(h.runtimes.inputsFor(sideRuntime)).toEqual(['First question', 'Anything new?', 'And now?']);
    });

    it('routes a sidechat typed into the main chat view through the same context path', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });

      await h.service.sendMessage({ chatId: side.chat.id, text: 'Asked from the main view' });

      expect(h.runtimes.preambles.at(-1)).toContain('Phase 3 (retry budget) is next');
    });

    it('refuses a context-free question when the parent is gone, then allows an explicit stale send', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First' });
      const sideRuntime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      h.runtimes.setStatus(sideRuntime, 'idle');
      await h.service.deleteChat(parent.chat.id);
      const turnsBefore = (await h.service.getChat(side.chat.id)).conversation.messages.length;

      const refused = await h.service.sideChats.send({ chatId: side.chat.id, text: 'Still there?' });
      expect(refused).toMatchObject({ ok: false, code: 'parent-unavailable', lastSnapshotAvailable: true });
      expect((await h.service.getChat(side.chat.id)).conversation.messages).toHaveLength(turnsBefore);

      const stale = await h.service.sideChats.send(
        { chatId: side.chat.id, text: 'Still there?' },
        { allowStaleContext: true },
      );
      expect(stale).toMatchObject({ ok: true, usedStaleContext: true });
      expect(h.runtimes.preambles.at(-1)).toContain('may be stale');
      expect((await h.service.getChat(side.chat.id)).conversation.messages).toHaveLength(turnsBefore + 1);
    });

    it('retries a question whose delivery failed without saving it twice', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });
      const sendInput = vi.spyOn(h.runtimes, 'sendInput')
        .mockRejectedValueOnce(new Error('runtime refused input'));

      const failed = await h.service.sideChats.send({ chatId: side.chat.id, text: 'What is left?' });
      expect(failed).toMatchObject({ ok: false, code: 'send-failed' });
      const retried = await h.service.sideChats.send({ chatId: side.chat.id, text: 'What is left?' });
      expect(retried).toMatchObject({ ok: true });

      const userTurns = (await h.service.getChat(side.chat.id)).conversation.messages
        .filter((message) => message.role === 'user');
      expect(userTurns.map((message) => message.content)).toEqual(['What is left?']);
      expect(sendInput).toHaveBeenCalledTimes(2);

      // A later rebuild (provider switch) replays the question once.
      const sideRuntime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      h.runtimes.setStatus(sideRuntime, 'idle');
      await h.service.sideChats.setSelection(side.chat.id, { provider: 'codex', model: null });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'And after that?' });
      const rebuild = h.runtimes.preambles.at(-1)!;
      expect(rebuild.split('Human: What is left?')).toHaveLength(2);
    });

    it('keeps each same-directory session\'s context separate', async () => {
      const h = harness();
      h.runtimes.addSession({
        historyThreadId: 'thread-a', workingDirectory: '/work/same', displayName: 'Session A',
        transcript: [{ type: 'user', content: 'Task A: refactor the parser' }],
      });
      h.runtimes.addSession({
        historyThreadId: 'thread-b', workingDirectory: '/work/same', displayName: 'Session B',
        transcript: [{ type: 'user', content: 'Task B: write release notes' }],
      });
      const sideA = await h.service.sideChats.create({
        parent: { kind: 'session', historyThreadId: 'thread-a', originNodeId: null }, selection: CLAUDE, currentCwd: '/work/same',
      });
      const sideB = await h.service.sideChats.create({
        parent: { kind: 'session', historyThreadId: 'thread-b', originNodeId: null }, selection: CLAUDE, currentCwd: '/work/same',
      });

      await h.service.sideChats.send({ chatId: sideA.chat.id, text: 'Status?' });
      const toA = h.runtimes.preambles.at(-1)!;
      await h.service.sideChats.send({ chatId: sideB.chat.id, text: 'Status?' });
      const toB = h.runtimes.preambles.at(-1)!;

      expect(toA).toContain('Task A: refactor the parser');
      expect(toA).not.toContain('Task B');
      expect(toB).toContain('Task B: write release notes');
      expect(toB).not.toContain('Task A');
    });

    it('resolves an archived parent session from history', async () => {
      const h = harness();
      h.runtimes.addSession({ historyThreadId: 'thread-old', workingDirectory: '/work/old', displayName: 'Old session' });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-old', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/old' });
      // The live session ends and moves to the history archive.
      await h.runtimes.terminateInstance(h.runtimes.getAllInstances()[0]!.id);
      h.archive.entries.set('thread-old', {
        title: 'Old session',
        workspacePath: '/work/old',
        messages: [{ id: 'm1', type: 'user', content: 'Archived task: migrate the schema', timestamp: 1 }],
      });

      const result = await h.service.sideChats.send({ chatId: side.chat.id, text: 'What was this about?' });

      expect(result.ok).toBe(true);
      expect(h.runtimes.preambles.at(-1)).toContain('Archived task: migrate the schema');
      expect((await h.service.sideChats.attention(ref)).parentTitle).toBe('Old session');
    });
  });

  describe('provider switching and rebuild', () => {
    it('switches provider after the first message and rebuilds history plus latest parent context', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First question' });
      await h.service.appendSystemEvent({
        chatId: side.chat.id, nativeMessageId: 'side-answer-1', role: 'assistant', content: 'Claude answer one',
      });
      const firstRuntime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      h.runtimes.setStatus(firstRuntime, 'idle');

      const switched = await h.service.sideChats.setSelection(side.chat.id, { provider: 'codex', model: 'gpt-5.5', reasoning: 'medium' });
      expect(switched.chat).toMatchObject({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium', currentInstanceId: null });
      expect(h.runtimes.terminations).toContain(firstRuntime);

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Second question' });

      expect(h.runtimes.creates.at(-1)).toMatchObject({ provider: 'codex', modelOverride: 'gpt-5.5' });
      const rebuild = h.runtimes.preambles.at(-1)!;
      expect(rebuild).toContain('Phase 3 (retry budget) is next');
      expect(rebuild).toContain('Claude answer one');
      expect(rebuild).not.toContain('Second question');
      expect(rebuild.match(/<parent_context/g)).toHaveLength(1);
      expect(h.service.sideChats.getLink(side.chat.id)?.parent).toEqual({ kind: 'chat', chatId: parent.chat.id });
    });

    it('refuses a provider change while an answer is running, without stopping parent or siblings', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };
      const busy = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      const sibling = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: busy.chat.id, text: 'Long question' });
      await h.service.sideChats.send({ chatId: sibling.chat.id, text: 'Other question' });
      const terminationsBefore = [...h.runtimes.terminations];

      await expect(h.service.sideChats.setSelection(busy.chat.id, { provider: 'codex', model: null }))
        .rejects.toThrow('Stop the current answer');
      await expect(h.service.setModel(busy.chat.id, 'opus')).rejects.toThrow('Stop the current answer');
      expect(h.runtimes.terminations).toEqual(terminationsBefore);
    });

    it('has no independent permission toggle', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const side = await h.service.sideChats.create({
        parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
      });

      await expect(h.service.setYolo(side.chat.id, true)).rejects.toThrow('inherited from the parent');
    });
  });

  describe('inherited authority', () => {
    it('spawns a sidechat of a restricted session with the parent\'s denials and approval posture', async () => {
      const h = harness();
      h.runtimes.addSession({
        historyThreadId: 'thread-plan', workingDirectory: '/work/aio', displayName: 'Planner',
        agentId: 'plan', yoloMode: false,
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-plan', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Can you fix the bug?' });

      expect(h.runtimes.creates.at(-1)).toMatchObject({
        provider: 'claude',
        yoloMode: false,
        toolPermissionsOverride: PLAN_PERMISSIONS,
      });
    });

    it('uses a custom agent\'s real permissions rather than the permissive default', async () => {
      const h = harness();
      h.agentPermissions.set('locked-down', { read: 'allow', write: 'deny', bash: 'deny', web: 'deny', task: 'deny' });
      h.runtimes.addSession({
        historyThreadId: 'thread-custom', workingDirectory: '/work/aio', displayName: 'Custom', yoloMode: true,
      }).agentId = 'locked-down';
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-custom', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Edit something' });

      expect(h.runtimes.creates.at(-1)?.toolPermissionsOverride).toEqual({
        read: 'allow', write: 'deny', bash: 'deny', web: 'deny', task: 'deny',
      });
    });

    it('rejects providers that cannot enforce the parent\'s restrictions, before submission', async () => {
      const h = harness();
      h.runtimes.addSession({
        historyThreadId: 'thread-plan', workingDirectory: '/work/aio', displayName: 'Planner',
        agentId: 'plan', yoloMode: false,
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-plan', originNodeId: null };

      const permissions = await h.service.sideChats.permissions(ref);
      const byProvider = Object.fromEntries(permissions.providers.map((entry) => [entry.provider, entry]));
      expect(byProvider['claude']?.available).toBe(true);
      expect(byProvider['codex']).toMatchObject({ available: false, reason: expect.stringContaining('denies write') });
      expect(byProvider['copilot']?.available).toBe(false);
      await expect(h.service.sideChats.create({ parent: ref, selection: { provider: 'codex', model: null }, currentCwd: '/work/aio' }))
        .rejects.toThrow('cannot block individual tool categories');
    });

    it('replaces an idle runtime when the parent\'s permissions change between turns', async () => {
      const h = harness();
      const session = h.runtimes.addSession({
        historyThreadId: 'thread-edit', workingDirectory: '/work/aio', displayName: 'Editor', yoloMode: true,
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-edit', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First' });
      const firstRuntime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      h.runtimes.setStatus(firstRuntime, 'idle');

      session.yoloMode = false;
      session.agentId = 'plan';
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Second' });

      expect(h.runtimes.terminations).toContain(firstRuntime);
      expect(h.runtimes.creates.at(-1)).toMatchObject({ yoloMode: false, toolPermissionsOverride: PLAN_PERMISSIONS });
    });

    it('refuses to replace a busy runtime mid-answer after a permission change', async () => {
      const h = harness();
      const session = h.runtimes.addSession({
        historyThreadId: 'thread-edit', workingDirectory: '/work/aio', displayName: 'Editor', yoloMode: true,
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-edit', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First' });

      session.yoloMode = false;
      const result = await h.service.sideChats.send({ chatId: side.chat.id, text: 'Second' });

      expect(result).toMatchObject({ ok: false, code: 'busy' });
    });

    it('falls back to the verified persisted policy, and refuses when none exists', async () => {
      const h = harness();
      const session = h.runtimes.addSession({
        historyThreadId: 'thread-gone', workingDirectory: '/work/aio', displayName: 'Gone', agentId: 'plan', yoloMode: false,
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-gone', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'First' });
      h.runtimes.setStatus((await h.service.getChat(side.chat.id)).chat.currentInstanceId!, 'idle');
      await h.runtimes.terminateInstance(session.id);

      const persisted = await h.service.sideChats.permissions(ref);
      expect(persisted).toMatchObject({ ok: true, source: 'persisted', policy: { yoloMode: false } });

      h.db.prepare('DELETE FROM side_chat_policies').run();
      const refused = await h.service.sideChats.send({ chatId: side.chat.id, text: 'Edit now' }, { allowStaleContext: true });
      expect(refused).toMatchObject({ ok: false, code: 'unavailable-permissions', lastSnapshotAvailable: true });
      await expect(h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' }))
        .rejects.toThrow('no verified permission policy');
    });

    it('treats a tampered persisted policy as absent', async () => {
      const h = harness();
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-x', originNodeId: null };
      h.db.prepare('INSERT INTO side_chat_policies (parent_key, policy_json, updated_at) VALUES (?, ?, ?)')
        .run('session:thread-x', JSON.stringify({ yoloMode: true }), 1);

      expect(await h.service.sideChats.permissions(ref)).toMatchObject({ ok: false, code: 'unavailable-permissions' });
    });
  });

  describe('workspace routing', () => {
    it('runs a remote parent\'s sidechat on the parent\'s worker with the worker path', async () => {
      const h = harness();
      h.runtimes.addSession({
        historyThreadId: 'thread-remote', workingDirectory: 'C:\\work\\aio', displayName: 'On Windows', workerNodeId: 'windows-pc',
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-remote', originNodeId: 'windows-pc' };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/Users/me/work/aio' });

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Status?' });

      expect(side.chat.currentCwd).toBe('C:\\work\\aio');
      expect(h.runtimes.creates.at(-1)).toMatchObject({ forceNodeId: 'windows-pc', workingDirectory: 'C:\\work\\aio' });
    });

    it('never routes a local parent\'s sidechat to a worker, even with a look-alike path', async () => {
      const h = harness();
      h.runtimes.addSession({ historyThreadId: 'thread-local', workingDirectory: 'C:\\work\\aio', displayName: 'Local' });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-local', originNodeId: null };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: 'C:\\work\\aio' });

      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Status?' });

      expect(h.runtimes.creates.at(-1)?.forceNodeId).toBeUndefined();
    });

    it('rejects a local model that lives on a different machine from the parent workspace', async () => {
      const h = harness();
      h.runtimes.addSession({
        historyThreadId: 'thread-remote', workingDirectory: 'C:\\work', displayName: 'Remote', workerNodeId: 'windows-pc',
      });
      const ref: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-remote', originNodeId: 'windows-pc' };

      await expect(h.service.sideChats.create({
        parent: ref,
        currentCwd: 'C:\\work',
        selection: {
          provider: 'local-model', model: null,
          modelRuntimeTarget: {
            kind: 'local-model', source: 'this-device', endpointProvider: 'ollama',
            endpointId: 'ollama-local', modelId: 'llama3', selectorId: 'sel',
          },
        },
      })).rejects.toThrow('different machine');
    });
  });

  describe('read state and attention', () => {
    it('counts an unread answer once, survives restart, and clears only through the read sequence', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Question' });
      for (const [index, chunk] of ['Part one', 'Part two'].entries()) {
        await h.service.appendSystemEvent({
          chatId: side.chat.id, nativeMessageId: `answer-${index}`, role: 'assistant', content: chunk,
        });
      }

      expect((await h.service.sideChats.attention(ref)).unread).toBe(1);

      const restarted = h.restart();
      harnesses.push(restarted);
      const afterRestart = await restarted.service.sideChats.attention(ref);
      expect(afterRestart).toMatchObject({ unread: 1, running: 0, targetChatId: side.chat.id, parentTitle: 'Provider Hardening' });
      expect(restarted.runtimes.inputs).toEqual([]);

      const latest = (await restarted.service.getChat(side.chat.id)).conversation.messages.at(-1)!.sequence;
      await expect(restarted.service.sideChats.markRead(side.chat.id, latest + 1)).rejects.toThrow('exceeds latest assistant output');
      await restarted.service.sideChats.markRead(side.chat.id, latest - 1);
      expect((await restarted.service.sideChats.attention(ref)).unread).toBe(1);
      await restarted.service.sideChats.markRead(side.chat.id, latest);
      await restarted.service.sideChats.markRead(side.chat.id, latest - 1);
      expect(restarted.service.sideChats.getLink(side.chat.id)?.lastReadAssistantSequence).toBe(latest);
      expect((await restarted.service.sideChats.attention(ref)).unread).toBe(0);
    });

    it('rejects read acknowledgements for ordinary chats', async () => {
      const h = harness();
      const chat = await h.service.createChat({ provider: 'claude', currentCwd: '/work', name: 'Plain' });

      await expect(h.service.sideChats.markRead(chat.chat.id, 0)).rejects.toThrow('not a sidechat');
    });

    it('emits coalesced attention deltas for answers and permission requests', async () => {
      const h = harness();
      const parent = await codexParent(h);
      const ref: SideChatParentRef = { kind: 'chat', chatId: parent.chat.id };
      const side = await h.service.sideChats.create({ parent: ref, selection: CLAUDE, currentCwd: '/work/aio' });
      await h.service.sideChats.send({ chatId: side.chat.id, text: 'Question' });
      const runtime = (await h.service.getChat(side.chat.id)).chat.currentInstanceId!;
      await h.service.sideChats.flushAttention();
      h.events.length = 0;

      h.runtimes.setStatus(runtime, 'waiting_for_permission');
      await h.service.appendSystemEvent({
        chatId: side.chat.id, nativeMessageId: 'a1', role: 'assistant', content: 'May I edit?',
      });
      await h.service.sideChats.flushAttention();

      const deltas = h.events.filter((event) => event.type === 'side-chat-attention');
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({
        attention: { parent: ref, needsAttention: 1, unread: 1, targetChatId: side.chat.id },
      });
    });

    it('lists attention for every parent without a mounted panel', async () => {
      const h = harness();
      const first = await codexParent(h, '/work/one');
      const second = await codexParent(h, '/work/two');
      await h.service.sideChats.create({ parent: { kind: 'chat', chatId: first.chat.id }, selection: CLAUDE, currentCwd: '/work/one' });
      await h.service.sideChats.create({ parent: { kind: 'chat', chatId: second.chat.id }, selection: CLAUDE, currentCwd: '/work/two' });

      const all = await h.service.sideChats.attentionForAll();

      expect(all.map((entry) => entry.parent)).toEqual(expect.arrayContaining([
        { kind: 'chat', chatId: first.chat.id },
        { kind: 'chat', chatId: second.chat.id },
      ]));
      expect(all).toHaveLength(2);
    });
  });

  it('removes the context snapshot when a sidechat is deleted', async () => {
    const h = harness();
    const parent = await codexParent(h);
    const side = await h.service.sideChats.create({
      parent: { kind: 'chat', chatId: parent.chat.id }, selection: CLAUDE, currentCwd: '/work/aio',
    });
    await h.service.sideChats.send({ chatId: side.chat.id, text: 'Question' });

    await h.service.deleteChat(side.chat.id);

    expect(h.db.prepare('SELECT chat_id FROM side_chat_context_snapshots WHERE chat_id = ?').get(side.chat.id)).toBeUndefined();
    expect(h.service.sideChats.getLink(side.chat.id)).toBeNull();
  });
});
