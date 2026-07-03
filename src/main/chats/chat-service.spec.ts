import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService, INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { createInstance, type FileAttachment, type Instance, type InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ChatEvent } from '../../shared/types/chat.types';
import { BranchSummarizer } from '../context/branch-summarizer';
import { ChatService } from './chat-service';

const CHAT_PAGINATION_TEST_TIMEOUT_MS = 15_000;

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
    // The cwd-switch replay block is the only context injected — the fresh
    // session's universal rebuild must NOT also fire, or context would be
    // duplicated.
    expect(instanceManager.preambles[1]).toBeUndefined();
  });

  it('rebuilds context from ledger on the turn after a loop epoch bump, exactly once', async () => {
    const { service, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Loop follow-up',
    });

    // Simulate a loop iteration landing in the ledger (Phase 1 — the actual
    // iteration transcript is written by appendLoopIterationTranscript).
    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-iter:loop-1:1',
      nativeTurnId: 'loop:loop-1',
      phase: 'loop_iteration',
      role: 'assistant',
      content: 'Iteration complete. All three reviewer findings have been addressed.',
    });

    // Signal that the loop ran in a diverged session (Phase 2 — called by
    // appendLoopTerminalSummary when the loop was not borrowed).
    service.bumpLineageEpoch(chat.chat.id);

    await service.sendMessage({ chatId: chat.chat.id, text: 'Were these issues resolved?' });
    await service.sendMessage({ chatId: chat.chat.id, text: 'And the second one?' });

    // First turn: instance received a continuity preamble from the ledger rebuild.
    // The preamble contains the loop iteration content so the model can answer.
    expect(instanceManager.preambles[0]).toContain('All three reviewer findings');
    // First turn message itself is unchanged (preamble is queued separately).
    expect(instanceManager.inputs[0].message).toBe('Were these issues resolved?');
    // Second turn: rebuild-once — no preamble on the second send.
    expect(instanceManager.preambles[1]).toBeUndefined();
    expect(instanceManager.inputs[1].message).toBe('And the second one?');
  });

  it('does not double-inject loop context when a cwd switch follows a loop (replay block carries it, flag cleared)', async () => {
    const { service, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/old',
      name: 'Loop then cwd switch',
    });
    await service.sendMessage({ chatId: chat.chat.id, text: 'Kick off' });

    // A loop iteration lands in the ledger, then the loop terminates in a
    // diverged session (sets the durable rebuild flag).
    await service.appendSystemEvent({
      chatId: chat.chat.id,
      nativeMessageId: 'loop-iter:loop-1:1',
      nativeTurnId: 'loop:loop-1',
      phase: 'loop_iteration',
      role: 'assistant',
      content: 'Loop refactored the auth module.',
    });
    service.bumpLineageEpoch(chat.chat.id);

    // Switching the project terminates the instance and appends a cwd-switch
    // event; the next send prepends a cwd replay block that already replays the
    // prior turns (including the loop iteration).
    await service.setCwd(chat.chat.id, '/work/new');
    await service.sendMessage({ chatId: chat.chat.id, text: 'Continue in new project' });

    const cwdSend = instanceManager.inputs.at(-1)!;
    expect(cwdSend.message).toContain('Loop refactored the auth module.');
    // The rebuild preamble must be skipped — the cwd replay already carried it.
    expect(instanceManager.preambles.at(-1)).toBeUndefined();

    // The loop flag was cleared by the cwd path, so the next (non-cwd) send does
    // NOT redundantly rebuild.
    await service.sendMessage({ chatId: chat.chat.id, text: 'And again' });
    expect(instanceManager.inputs.at(-1)!.message).toBe('And again');
    expect(instanceManager.preambles.at(-1)).toBeUndefined();
  });

  it('rebuilds context from the ledger when a model switch forks the provider session', async () => {
    const { service, ledger, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Model switch continuity',
    });
    const first = await service.sendMessage({ chatId: chat.chat.id, text: 'Add a login form' });
    await ledger.appendMessage(first.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'Login form added with email + password fields.',
      createdAt: Date.now(),
    });

    // Switching the model terminates the instance; the next send spawns a fresh
    // provider session that has no memory of the prior turns.
    await service.setModel(chat.chat.id, 'opus-4-7');

    await service.sendMessage({ chatId: chat.chat.id, text: 'Now add validation' });

    expect(instanceManager.creates).toHaveLength(2);
    // The fresh session is seeded with the prior conversation from the ledger.
    const preamble = instanceManager.preambles.at(-1);
    expect(preamble).toContain('Login form added');
    // The user's actual message is unchanged.
    expect(instanceManager.inputs.at(-1)?.message).toBe('Now add validation');
  });

  it('checkpoint-aware rebuild walks [durable summary] + [verbatim after checkpoint] (§4.4)', async () => {
    const { service, ledger, instanceManager } = createHarness();
    const chat = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Checkpoint rebuild',
    });
    // Seed early turns that will be folded into a checkpoint summary.
    const first = await service.sendMessage({ chatId: chat.chat.id, text: 'Early request' });
    await ledger.appendMessage(first.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'ASSISTANT-EARLY: did the early work.',
      createdAt: Date.now(),
    });
    // A checkpoint compacts everything up to the early assistant turn (seq 2).
    await ledger.writeCheckpoint(first.chat.ledgerThreadId, {
      upToSequence: 2,
      upToNativeId: null,
      summary: 'DURABLE-SUMMARY: the early request was completed.',
      summarizedMessageCount: 2,
      summaryTokens: 8,
    });
    // A later assistant turn lands AFTER the checkpoint — must be replayed verbatim.
    await ledger.appendMessage(first.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'ASSISTANT-LATE: then added the follow-up feature.',
      createdAt: Date.now(),
    });
    // Force a fresh provider session so the universal rebuild fires.
    await service.setModel(chat.chat.id, 'opus-4-7');
    await service.sendMessage({ chatId: chat.chat.id, text: 'What is left?' });

    const preamble = instanceManager.preambles.at(-1);
    expect(preamble).toBeDefined();
    // Durable summary of the compacted prefix is present...
    expect(preamble).toContain('DURABLE-SUMMARY');
    // ...as is the verbatim turn after the checkpoint...
    expect(preamble).toContain('ASSISTANT-LATE');
    // ...but the pre-checkpoint verbatim turn was folded into the summary, not replayed.
    expect(preamble).not.toContain('ASSISTANT-EARLY');
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
  }, CHAT_PAGINATION_TEST_TIMEOUT_MS);

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
    // The user's message itself is unchanged...
    expect(secondInstanceManager.inputs[0].message).toBe('Continue now');
    // ...but because the post-restart provider session is brand new and has no
    // memory of the chat, §4.3's universal fallback rebuilds the prior turns
    // from the ledger and injects them as a continuity preamble. Before this
    // fix the fresh session received no context at all (the original "new
    // session has no context" failure).
    expect(secondInstanceManager.preambles[0]).toContain('Remember this after restart');

    // Once the rebound session is reused (not fresh), the native fast path
    // applies and no further preamble is injected.
    await secondService.sendMessage({
      chatId: created.chat.id,
      text: 'And again',
    });
    expect(secondInstanceManager.creates).toHaveLength(1);
    expect(secondInstanceManager.preambles[1]).toBeUndefined();
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

  it('creates a branch chat with a durable parent conversation id', async () => {
    const { service } = createHarness();
    const parent = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Parent branch',
    });

    const child = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Child branch',
      parentChatId: parent.chat.id,
    });

    expect(child.conversation.thread.parentConversationId).toBe(parent.chat.ledgerThreadId);
  });

  it('summarizes a related branch when chat selection moves away and injects it once on destination send', async () => {
    const { service, ledger, instanceManager } = createHarness();
    const parent = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Parent branch',
    });
    const child = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Child branch',
      parentChatId: parent.chat.id,
    });
    await ledger.appendMessage(parent.chat.ledgerThreadId, {
      role: 'user',
      phase: null,
      content: 'Please implement branch summaries.',
      createdAt: 100,
    });
    await ledger.appendMessage(parent.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'Edited src/main/chats/chat-service.ts and wrote src/main/context/branch-summarizer.ts.',
      createdAt: 101,
    });

    service.setUiState({
      selectedChatId: parent.chat.id,
      openChatIds: [parent.chat.id, child.chat.id],
    });
    service.setUiState({
      selectedChatId: child.chat.id,
      openChatIds: [parent.chat.id, child.chat.id],
    });
    await service.drainBranchSummariesForTesting();

    const childDetail = await service.getChat(child.chat.id);
    expect(childDetail.conversation.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        phase: 'branch_summary',
        content: expect.stringContaining('Branch switch summary'),
        rawJson: {
          metadata: expect.objectContaining({
            kind: 'branch-summary',
            fromNodeId: parent.chat.ledgerThreadId,
            toNodeId: child.chat.ledgerThreadId,
            upToSequence: 2,
          }),
        },
      }),
    ]);
    expect(childDetail.conversation.thread.metadata['branchSummaries']).toMatchObject({
      [`${parent.chat.ledgerThreadId}::${child.chat.ledgerThreadId}`]: {
        upToSequence: 2,
        fileOperations: [
          {
            kind: 'write',
            path: 'src/main/chats/chat-service.ts',
            source: 'assistant-text',
          },
          {
            kind: 'write',
            path: 'src/main/context/branch-summarizer.ts',
            source: 'assistant-text',
          },
        ],
      },
    });

    await service.sendMessage({ chatId: child.chat.id, text: 'Continue on this branch' });
    expect(instanceManager.preambles.at(-1)).toContain('Branch switch summary');
    expect(instanceManager.preambles.at(-1)).toContain('src/main/chats/chat-service.ts');
    expect(instanceManager.inputs.at(-1)?.message).toBe('Continue on this branch');

    await service.sendMessage({ chatId: child.chat.id, text: 'Continue again' });
    expect(instanceManager.preambles.at(-1)).toBeUndefined();
  });

  it('does not duplicate branch summaries for unchanged branch turns', async () => {
    const { service, ledger } = createHarness();
    const parent = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Parent branch',
    });
    const child = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/project',
      name: 'Child branch',
      parentChatId: parent.chat.id,
    });
    await ledger.appendMessage(parent.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'Edited src/main/chats/chat-service.ts.',
      createdAt: 1,
    });

    service.setUiState({ selectedChatId: parent.chat.id, openChatIds: [parent.chat.id, child.chat.id] });
    service.setUiState({ selectedChatId: child.chat.id, openChatIds: [parent.chat.id, child.chat.id] });
    await service.drainBranchSummariesForTesting();
    service.setUiState({ selectedChatId: parent.chat.id, openChatIds: [parent.chat.id, child.chat.id] });
    service.setUiState({ selectedChatId: child.chat.id, openChatIds: [parent.chat.id, child.chat.id] });
    await service.drainBranchSummariesForTesting();

    const summaries = (await service.getChat(child.chat.id)).conversation.messages.filter(
      (message) => message.rawJson?.['metadata']?.['kind'] === 'branch-summary',
    );
    expect(summaries).toHaveLength(1);
  });

  it('does not summarize unrelated chat selection changes', async () => {
    const { service, ledger } = createHarness();
    const first = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/first',
      name: 'First',
    });
    const second = await service.createChat({
      provider: 'claude',
      currentCwd: '/work/second',
      name: 'Second',
    });
    await ledger.appendMessage(first.chat.ledgerThreadId, {
      role: 'assistant',
      phase: null,
      content: 'Edited src/main/chats/chat-service.ts.',
      createdAt: 1,
    });

    service.setUiState({ selectedChatId: first.chat.id, openChatIds: [first.chat.id, second.chat.id] });
    service.setUiState({ selectedChatId: second.chat.id, openChatIds: [first.chat.id, second.chat.id] });
    await service.drainBranchSummariesForTesting();

    expect((await service.getChat(second.chat.id)).conversation.messages).toEqual([]);
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

    it('uses Codex xhigh when createChat omits reasoningEffort', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'codex',
        currentCwd: '/work/project',
        name: 'Default reasoning',
      });
      expect(chat.chat.reasoningEffort).toBe('xhigh');

      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });

      const lastCreate = instanceManager.creates[instanceManager.creates.length - 1];
      expect(lastCreate.reasoningEffort).toBe('xhigh');
    });

    it('keeps explicit null reasoningEffort as provider-decided', async () => {
      const { service, instanceManager } = createHarness();
      const chat = await service.createChat({
        provider: 'codex',
        reasoningEffort: null,
        currentCwd: '/work/project',
        name: 'Provider-decided reasoning',
      });
      expect(chat.chat.reasoningEffort).toBeNull();

      await service.sendMessage({ chatId: chat.chat.id, text: 'Hi' });

      const lastCreate = instanceManager.creates[instanceManager.creates.length - 1];
      expect(lastCreate.reasoningEffort).toBeUndefined();
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
      branchSummarizer: new BranchSummarizer(),
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
  /** Preambles indexed by the send call that consumed them. */
  readonly preambles: (string | undefined)[] = [];
  private readonly instances = new Map<string, Instance>();
  private readonly pendingPreambles = new Map<string, string>();

  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    this.creates.push(config);
    const instance = createInstance(config);
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(instanceId: string): Instance | undefined {
    return this.instances.get(instanceId);
  }

  queueContinuityPreamble(instanceId: string, preamble: string): void {
    this.pendingPreambles.set(instanceId, preamble);
  }

  async sendInput(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    const preamble = this.pendingPreambles.get(instanceId);
    this.pendingPreambles.delete(instanceId);
    this.preambles.push(preamble);
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
