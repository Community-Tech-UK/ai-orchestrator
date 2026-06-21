import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService, INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { createInstance, type FileAttachment, type Instance, type InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ChatEvent } from '../../shared/types/chat.types';
import { ChatService } from './chat-service';

describe('ChatService', () => {
  const ledgers: ConversationLedgerService[] = [];
  const dbs: SqliteDriver[] = [];
  const services: ChatService[] = [];

  afterEach(async () => {
    for (const service of services) service.dispose();
    services.length = 0;
    ChatService._resetForTesting();
    for (const ledger of ledgers) await ledger.close();
    ledgers.length = 0;
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it('creates durable chat threads without reusing the legacy global operator native id', async () => {
    const { service } = createHarness();

    const first = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/one',
      name: 'One',
    });
    const second = await service.createChat({
      provider: 'codex',
      currentCwd: '/work/two',
      name: 'Two',
    });

    expect(first.conversation.thread.provider).toBe('orchestrator');
    expect(first.conversation.thread.nativeThreadId).toMatch(/^orchestrator-chat-/);
    expect(second.conversation.thread.nativeThreadId).toMatch(/^orchestrator-chat-/);
    expect(first.conversation.thread.nativeThreadId).not.toBe(INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID);
    expect(second.conversation.thread.nativeThreadId).not.toBe(first.conversation.thread.nativeThreadId);
    expect(first.conversation.thread.metadata).toMatchObject({
      chatId: first.chat.id,
      scope: 'chat',
      operatorThreadKind: 'chat',
    });
  });

  it('spawns the selected provider runtime lazily and persists the visible user turn', async () => {
    const { service, instanceManager } = createHarness();
    const attachment: FileAttachment = {
      name: 'note.txt',
      type: 'text/plain',
      size: 4,
      data: 'data:text/plain;base64,dGVzdA==',
    };
    const chat = await service.createChat({
      provider: 'gemini',
      model: 'gemini-pro',
      currentCwd: '/work/project',
      name: 'Runtime check',
      yolo: true,
    });

    const detail = await service.sendMessage({
      chatId: chat.chat.id,
      text: 'Run tests',
      attachments: [attachment],
    });

    expect(instanceManager.creates).toEqual([
      expect.objectContaining({
        provider: 'gemini',
        modelOverride: 'gemini-pro',
        workingDirectory: '/work/project',
        yoloMode: true,
        agentId: 'build',
      }),
    ]);
    expect(instanceManager.inputs).toEqual([
      {
        instanceId: detail.chat.currentInstanceId,
        message: 'Run tests',
        attachments: [attachment],
      },
    ]);
    expect(detail.currentInstance?.id).toBe(detail.chat.currentInstanceId);
    expect(detail.conversation.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Run tests',
        sequence: 1,
      }),
    ]);
  });

  it('restarts runtime on project switch and replays bounded prior context into the next provider turn', async () => {
    const { service, ledger, instanceManager } = createHarness();
    const created = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/old-project',
      name: 'Switcher',
    });
    const first = await service.sendMessage({
      chatId: created.chat.id,
      text: 'First task',
    });
    await ledger.appendMessage(first.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'First task complete.',
      createdAt: Date.now(),
    });

    const switched = await service.setCwd(created.chat.id, '/work/new-project');
    expect(switched.chat.currentInstanceId).toBeNull();
    expect(instanceManager.terminations).toEqual([first.chat.currentInstanceId]);

    await service.sendMessage({
      chatId: created.chat.id,
      text: 'Continue here',
    });

    expect(instanceManager.creates).toHaveLength(2);
    expect(instanceManager.creates[1]).toEqual(expect.objectContaining({
      workingDirectory: '/work/new-project',
    }));
    expect(instanceManager.inputs[1].message).toContain(
      '[Context from prior conversation, working directory was /work/old-project:]'
    );
    expect(instanceManager.inputs[1].message).toContain('user: First task');
    expect(instanceManager.inputs[1].message).toContain('assistant: First task complete.');
    expect(instanceManager.inputs[1].message).toContain(
      '[Continue, working directory is now /work/new-project.]'
    );
    expect(instanceManager.inputs[1].message).toMatch(/\n\nContinue here$/);
  });

  it('prepends a queued loop handoff to the next message exactly once, then clears it', async () => {
    const { service, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Loop follow-up',
    });

    service.queueLoopHandoff(chat.chat.id, '[Loop context] the loop fixed three findings.');

    await service.sendMessage({ chatId: chat.chat.id, text: 'Were these issues resolved?' });
    await service.sendMessage({ chatId: chat.chat.id, text: 'And the second one?' });

    // First turn after the loop carries the handoff, with the user's text last.
    expect(instanceManager.inputs[0].message).toContain(
      '[Loop context] the loop fixed three findings.',
    );
    expect(instanceManager.inputs[0].message).toMatch(/\n\nWere these issues resolved\?$/);
    // Consume-once: the second turn must not re-inject the handoff.
    expect(instanceManager.inputs[1].message).toBe('And the second one?');
  });

  it('migrates a legacy global operator ledger thread into a setup-required chat', async () => {
    const { service, ledger } = createHarness();
    const legacy = await ledger.startConversation({
      provider: 'orchestrator',
      title: 'Orchestrator',
      metadata: {
        scope: 'global',
        operatorThreadKind: 'root',
      },
    });

    // The legacy backfill now reads the ledger asynchronously; wait for it.
    await service.whenReady();
    const chats = service.listChats();

    expect(chats).toEqual([
      expect.objectContaining({
        name: 'Orchestrator',
        provider: null,
        currentCwd: null,
        ledgerThreadId: legacy.id,
      }),
    ]);
  });

  it('keeps provider identity immutable after the first durable message', async () => {
    const { service } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Immutable provider',
    });
    await service.sendMessage({
      chatId: chat.chat.id,
      text: 'Hello',
    });

    await expect(service.setProvider(chat.chat.id, 'codex')).rejects.toThrow(
      'Chat provider can only be changed before the first message'
    );
  });

  it('rejects whitespace-only messages before appending to the ledger or spawning a runtime', async () => {
    const { service, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Blank guard',
    });

    await expect(service.sendMessage({
      chatId: chat.chat.id,
      text: '   \n\t   ',
    })).rejects.toThrow('Chat message cannot be empty');

    expect((await service.getChat(chat.chat.id)).conversation.messages).toEqual([]);
    expect(instanceManager.creates).toEqual([]);
    expect(instanceManager.inputs).toEqual([]);
  });

  it('appends durable synthetic system events without spawning a runtime', async () => {
    const { service, instanceManager } = createHarness();
    const events: ChatEvent[] = [];
    service.events.on('chat:event', (event: ChatEvent) => events.push(event));
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Loop summary',
    });
    events.length = 0;

    const detail = await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-summary:loop-1',
      nativeTurnId: 'loop:loop-1',
      phase: 'loop_summary',
      content: 'Loop ended - completed\n\nIterations: 2',
      metadata: {
        kind: 'loop-summary',
        loopRunId: 'loop-1',
      },
    });

    expect(instanceManager.creates).toEqual([]);
    expect(detail.conversation.messages).toEqual([
      expect.objectContaining({
        nativeMessageId: 'loop-summary:loop-1',
        nativeTurnId: 'loop:loop-1',
        role: 'system',
        phase: 'loop_summary',
        content: expect.stringContaining('Loop ended - completed'),
        sequence: 1,
        rawJson: {
          metadata: {
            kind: 'loop-summary',
            loopRunId: 'loop-1',
          },
        },
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'transcript-appended',
        chatId: chat.chat.id,
        messages: [
          expect.objectContaining({
            nativeMessageId: 'loop-summary:loop-1',
            role: 'system',
            content: expect.stringContaining('Loop ended - completed'),
            sequence: 1,
          }),
        ],
      }),
    ]);
  });

  it('returns a recent tail by default and can load older chat messages explicitly', async () => {
    const { service } = createHarness();
    const created = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Paged history',
    });

    for (let index = 1; index <= 4; index += 1) {
      await service.appendSystemEvent({
        chatId: created.chat.id,
        nativeMessageId: `msg-${index}`,
        content: `message-${index}`,
      });
    }

    const detail = await service.getChat(created.chat.id);
    expect(detail.conversation.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(detail.conversation.window).toMatchObject({
      totalMessages: 4,
      hasOlder: false,
      oldestSequence: 1,
      newestSequence: 4,
    });

    for (let index = 5; index <= 240; index += 1) {
      await service.appendSystemEvent({
        chatId: created.chat.id,
        nativeMessageId: `msg-${index}`,
        content: `message-${index}`,
      });
    }

    const recent = await service.getChat(created.chat.id);
    expect(recent.conversation.messages).toHaveLength(200);
    expect(recent.conversation.messages[0]?.sequence).toBe(41);
    expect(recent.conversation.messages.at(-1)?.sequence).toBe(240);
    expect(recent.conversation.window).toMatchObject({
      totalMessages: 240,
      hasOlder: true,
      oldestSequence: 41,
      newestSequence: 240,
    });

    const older = await service.loadOlderMessages(created.chat.id, { beforeSequence: 41, limit: 25 });
    expect(older.messages[0]?.sequence).toBe(16);
    expect(older.messages.at(-1)?.sequence).toBe(40);
    expect(older.totalMessages).toBe(240);
    expect(older.hasMore).toBe(true);
  });

  it('auto-renames an Untitled chat from a user-role synthetic event when autoName is true', async () => {
    const { service } = createHarness();
    const events: ChatEvent[] = [];
    service.events.on('chat:event', (event: ChatEvent) => events.push(event));
    // No name → defaults to "Untitled chat"
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
    });
    expect(chat.chat.name).toBe('Untitled chat');
    events.length = 0;

    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-start:loop-99',
      role: 'user',
      content: 'Ship the dark mode fix',
      autoName: true,
      metadata: { kind: 'loop-start', loopRunId: 'loop-99' },
    });

    const refreshed = await service.getChat(chat.chat.id);
    expect(refreshed.chat.name).toBe('Ship the dark mode fix');
    expect(events.some((event) => event.type === 'chat-updated')).toBe(true);
  });

  it('auto-names an Untitled chat from the attachment subject when the text is generic filler', async () => {
    const { service } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
    });
    expect(chat.chat.name).toBe('Untitled chat');

    const detail = await service.sendMessage({
      chatId: chat.chat.id,
      text: 'Please implement this',
      attachments: [
        {
          name: '2026-06-02-chrome-devtools-managed-profile-attach.md',
          type: 'text/markdown',
          size: 3500,
          data: 'data:text/markdown;base64,eA==',
        },
      ],
    });

    // Previously this stored "Please implement this" (and the rail showed only
    // "Implement…"); now it leads with the distinctive file subject (truncated
    // to the stored chat-name length at a word boundary).
    expect(detail.chat.name).toBe('Chrome devtools managed profile attach...');
  });

  it('leaves a manually-named chat alone even when autoName is true (matches sendMessage semantics)', async () => {
    const { service } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'My focused chat',
    });

    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-start:loop-100',
      role: 'user',
      content: 'A new prompt that should not rename',
      autoName: true,
    });

    expect((await service.getChat(chat.chat.id)).chat.name).toBe('My focused chat');
  });

  it('keeps synthetic system events idempotent by native message id', async () => {
    const { service } = createHarness();
    const events: ChatEvent[] = [];
    service.events.on('chat:event', (event: ChatEvent) => events.push(event));
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Loop summary dedupe',
    });
    events.length = 0;

    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-summary:loop-1',
      content: 'first',
      metadata: { kind: 'loop-summary' },
    });
    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-summary:loop-1',
      content: 'second should not replace first',
      metadata: { kind: 'loop-summary' },
    });

    expect((await service.getChat(chat.chat.id)).conversation.messages).toEqual([
      expect.objectContaining({
        nativeMessageId: 'loop-summary:loop-1',
        content: 'first',
        sequence: 1,
      }),
    ]);
    expect(events.filter((event) => event.type === 'transcript-appended')).toHaveLength(1);
  });

  it('recovers chats and transcripts across service restart without restoring stale runtimes', async () => {
    const firstDb = defaultDriverFactory(':memory:');
    createOperatorTables(firstDb);
    dbs.push(firstDb);
    const firstLedger = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    ledgers.push(firstLedger);
    const firstInstanceManager = new FakeInstanceManager();
    const firstService = new ChatService({
      db: firstDb,
      ledger: firstLedger,
      instanceManager: firstInstanceManager as never,
      eventBus: new EventEmitter(),
    });
    services.push(firstService);
    const created = await firstService.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Restart chat',
    });
    const sent = await firstService.sendMessage({
      chatId: created.chat.id,
      text: 'Remember this after restart',
    });
    expect(sent.chat.currentInstanceId).toBeTruthy();

    ChatService._resetForTesting();
    const secondInstanceManager = new FakeInstanceManager();
    const secondService = new ChatService({
      db: firstDb,
      ledger: firstLedger,
      instanceManager: secondInstanceManager as never,
      eventBus: new EventEmitter(),
    });
    services.push(secondService);

    const [restored] = secondService.listChats();
    expect(restored).toEqual(expect.objectContaining({
      id: created.chat.id,
      currentInstanceId: null,
      ledgerThreadId: created.chat.ledgerThreadId,
    }));
    expect((await secondService.getChat(created.chat.id)).conversation.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Remember this after restart',
      }),
    ]);
    expect(secondInstanceManager.creates).toEqual([]);

    await secondService.sendMessage({
      chatId: created.chat.id,
      text: 'Continue now',
    });
    expect(secondInstanceManager.creates).toHaveLength(1);
    expect(secondInstanceManager.inputs[0].message).toBe('Continue now');
  });

  it('persists selected/open chat UI state and filters stale ids on restore', async () => {
    const { service } = createHarness();
    const first = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/first',
      name: 'First',
    });
    const second = await service.createChat({
      provider: 'codex',
      currentCwd: '/work/second',
      name: 'Second',
    });

    expect(service.setUiState({
      selectedChatId: second.chat.id,
      openChatIds: [first.chat.id, second.chat.id, 'missing-chat'],
    })).toMatchObject({
      selectedChatId: second.chat.id,
      openChatIds: [first.chat.id, second.chat.id],
    });

    await service.archiveChat(second.chat.id);

    expect(service.getUiState()).toMatchObject({
      selectedChatId: first.chat.id,
      openChatIds: [first.chat.id],
    });
  });

  it('persists normalized tool events as tool ledger messages for audit attribution', async () => {
    const { service, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Tool audit',
    });
    const detail = await service.sendMessage({
      chatId: chat.chat.id,
      text: 'Pull everything',
    });
    const instanceId = detail.chat.currentInstanceId!;

    // Only watch events emitted by the provider bridge (ignore the user-turn
    // append from sendMessage above).
    const events: ChatEvent[] = [];
    service.events.on('chat:event', (event: ChatEvent) => events.push(event));

    instanceManager.emit('provider:normalized-event', {
      eventId: 'tool-event-1',
      seq: 1,
      timestamp: 1_000,
      provider: 'claude',
      instanceId,
      turnId: 'turn-1',
      event: {
        kind: 'tool_use',
        toolName: 'git_batch_pull',
        toolUseId: 'tool-1',
        input: { root: '/work/project' },
      },
    });
    instanceManager.emit('provider:normalized-event', {
      eventId: 'tool-event-2',
      seq: 2,
      timestamp: 1_001,
      provider: 'claude',
      instanceId,
      turnId: 'turn-1',
      event: {
        kind: 'tool_result',
        toolName: 'git_batch_pull',
        toolUseId: 'tool-1',
        output: 'done',
        success: true,
      },
    });

    // The bridge persists provider events on a coalesced off-thread flush; drain
    // it before asserting the durable transcript + emitted deltas.
    await service.flushTranscript();

    expect((await service.getChat(chat.chat.id)).conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Pull everything' }),
      expect.objectContaining({
        role: 'tool',
        phase: 'tool_call',
        content: 'git_batch_pull({"root":"/work/project"})',
      }),
      expect.objectContaining({
        role: 'tool',
        phase: 'tool_result',
        content: 'done',
      }),
    ]);

    // Deltas carry only the freshly-appended messages — never the full
    // conversation (the old full-transcript fan-out per event was the dominant
    // send-time stall). The bridge now coalesces a burst into ONE batched delta,
    // so the two tool events arrive together with their authoritative sequences.
    const appended = events.filter(
      (event): event is Extract<ChatEvent, { type: 'transcript-appended' }> =>
        event.type === 'transcript-appended',
    );
    const appendedMessages = appended.flatMap((event) => event.messages);
    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[0]).toEqual(
      expect.objectContaining({ role: 'tool', phase: 'tool_call' }),
    );
    expect(appendedMessages[1]).toEqual(
      expect.objectContaining({ role: 'tool', phase: 'tool_result', content: 'done' }),
    );
  });

  describe('terminate-and-respawn on config setters', () => {
    it('clears the runtime and emits runtime-cleared on setModel when an instance is alive', async () => {
      const { service, instanceManager } = createHarness();
      const events: ChatEvent[] = [];
      service.events.on('chat:event', (event: ChatEvent) => events.push(event));

      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Switch model',
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId;
      expect(runningId).toBeTruthy();
      events.length = 0;

      const after = await service.setModel(chat.chat.id, 'opus-4-7');

      expect(instanceManager.terminations).toEqual([runningId]);
      expect(after.chat.currentInstanceId).toBeNull();
      expect(after.chat.model).toBe('opus-4-7');
      const runtimeCleared = events.find((e) => e.type === 'runtime-cleared');
      const chatUpdated = events.find((e) => e.type === 'chat-updated');
      expect(runtimeCleared).toMatchObject({
        type: 'runtime-cleared',
        chatId: chat.chat.id,
        previousInstanceId: runningId,
      });
      expect(chatUpdated).toMatchObject({ type: 'chat-updated', chatId: chat.chat.id });
      expect(events.indexOf(runtimeCleared!)).toBeLessThan(events.indexOf(chatUpdated!));
    });

    it('propagates a YOLO toggle to the live instance so it takes effect immediately', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Yolo toggle',
        yolo: false,
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId!;
      expect(instanceManager.getInstance(runningId)!.yoloMode).toBe(false);

      const after = await service.setYolo(chat.chat.id, true);

      expect(after.chat.yolo).toBe(true);
      expect(instanceManager.yoloChanges).toEqual([{ instanceId: runningId, yolo: true }]);
      expect(instanceManager.getInstance(runningId)!.yoloMode).toBe(true);
    });

    it('does not touch the instance when the YOLO state is unchanged', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Yolo no-op',
        yolo: true,
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });

      await service.setYolo(chat.chat.id, true);

      expect(instanceManager.yoloChanges).toEqual([]);
    });

    it('still persists the chat YOLO change and flips the flag when respawn rejects', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Yolo respawn fails',
        yolo: false,
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId!;
      instanceManager.setYoloMode = async () => {
        throw new Error('instance busy');
      };

      const after = await service.setYolo(chat.chat.id, true);

      expect(after.chat.yolo).toBe(true);
      // Fallback path: flag flipped in place so approval gates honor YOLO now.
      expect(instanceManager.getInstance(runningId)!.yoloMode).toBe(true);
    });

    it('does not call terminateInstance on setModel when no runtime is linked', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'No runtime',
      });

      const after = await service.setModel(chat.chat.id, 'sonnet-4-6');

      expect(instanceManager.terminations).toEqual([]);
      expect(after.chat.model).toBe('sonnet-4-6');
      expect(after.chat.currentInstanceId).toBeNull();
    });

    it('skips terminate when the linked instance is already terminated', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Already terminated',
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId!;
      const inst = instanceManager.getInstance(runningId)!;
      inst.status = 'terminated';
      instanceManager.terminations.length = 0;

      await service.setModel(chat.chat.id, 'sonnet-4-6');

      expect(instanceManager.terminations).toEqual([]);
    });

    it('still updates the chat record when terminateInstance rejects', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Terminate fails',
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId!;
      instanceManager.terminateInstance = async () => {
        throw new Error('boom');
      };

      const after = await service.setModel(chat.chat.id, 'haiku');

      expect(after.chat.model).toBe('haiku');
      expect(after.chat.currentInstanceId).toBeNull();
      // terminate threw, but model still persisted
      expect(runningId).toBeTruthy();
    });

    it('clears the runtime on setProvider when allowed (no messages yet)', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'claude',
        currentCwd: '/work/project',
        name: 'Switch provider',
      });

      const after = await service.setProvider(chat.chat.id, 'codex');

      expect(after.chat.provider).toBe('codex');
      expect(instanceManager.terminations).toEqual([]);
      expect(after.chat.currentInstanceId).toBeNull();
    });

    it('rejects setReasoning when called on a non-existent chat', async () => {
      const { service } = createHarness();
      await expect(
        service.setReasoning('non-existent-chat', 'high'),
      ).rejects.toThrow('Chat non-existent-chat not found');
    });

    it('clears the runtime and persists reasoning on setReasoning', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'codex',
        currentCwd: '/work/project',
        name: 'Reasoning chat',
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });
      const runningId = (await service.getChat(chat.chat.id)).chat.currentInstanceId!;

      const after = await service.setReasoning(chat.chat.id, 'high');

      expect(instanceManager.terminations).toEqual([runningId]);
      expect(after.chat.reasoningEffort).toBe('high');
      expect(after.chat.currentInstanceId).toBeNull();
    });

    it('persists reasoningEffort on createChat and forwards it on next runtime spawn', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'codex',
        reasoningEffort: 'high',
        currentCwd: '/work/project',
        name: 'Pre-set reasoning',
      });
      expect(chat.chat.reasoningEffort).toBe('high');

      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });

      const lastCreate = instanceManager.creates[instanceManager.creates.length - 1];
      expect(lastCreate.reasoningEffort).toBe('high');
    });

    it('forwards updated model and reasoning on the respawned runtime', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'codex',
        currentCwd: '/work/project',
        name: 'Respawn fresh',
      });
      await service.sendMessage({ chatId: chat.chat.id, text: 'first' });
      await service.setModel(chat.chat.id, 'gpt-5.5-mini');
      await service.setReasoning(chat.chat.id, 'medium');

      await service.sendMessage({ chatId: chat.chat.id, text: 'second' });

      const lastCreate = instanceManager.creates[instanceManager.creates.length - 1];
      expect(lastCreate.modelOverride).toBe('gpt-5.5-mini');
      expect(lastCreate.reasoningEffort).toBe('medium');
      expect(instanceManager.creates.length).toBe(2);
    });
  });

  function createHarness(): {
    db: SqliteDriver;
    ledger: ConversationLedgerService;
    instanceManager: FakeInstanceManager;
    service: ChatService;
  } {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    dbs.push(db);
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    ledgers.push(ledger);
    const instanceManager = new FakeInstanceManager();
    const service = new ChatService({
      db,
      ledger,
      instanceManager: instanceManager as never,
      eventBus: new EventEmitter(),
    });
    services.push(service);
    return { db, ledger, instanceManager, service };
  }
});

class FakeInstanceManager extends EventEmitter {
  readonly creates: InstanceCreateConfig[] = [];
  readonly inputs: {
    instanceId: string | null;
    message: string;
    attachments?: FileAttachment[];
  }[] = [];
  readonly terminations: (string | null)[] = [];
  readonly yoloChanges: { instanceId: string; yolo: boolean }[] = [];
  private readonly instances = new Map<string, Instance>();

  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    this.creates.push(config);
    const instance = createInstance(config);
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(instanceId: string): Instance | undefined {
    return this.instances.get(instanceId);
  }

  async sendInput(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    this.inputs.push({ instanceId, message, attachments });
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.status = 'busy';
    }
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminations.push(instanceId);
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.status = 'terminated';
    }
  }

  async setYoloMode(instanceId: string, desiredYoloMode: boolean): Promise<Instance> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    instance.yoloMode = desiredYoloMode;
    this.yoloChanges.push({ instanceId, yolo: desiredYoloMode });
    return instance;
  }
}
