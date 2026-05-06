import { afterEach, describe, expect, it } from 'vitest';
import type { OperatorRunGraph } from '../../shared/types/operator.types';
import { ConversationLedgerService } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';
import { OperatorThreadService } from './operator-thread-service';

describe('OperatorThreadService', () => {
  const ledgers: ConversationLedgerService[] = [];

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    ledgers.length = 0;
  });

  it('creates and reuses the global Orchestrator thread', async () => {
    const ledger = createLedger();
    const service = new OperatorThreadService({ ledger, engine: null });

    const first = await service.getThread();
    const second = await service.getThread();

    expect(first.thread.id).toBe(second.thread.id);
    expect(first.thread.provider).toBe('orchestrator');
    expect(first.thread.workspacePath).toBeNull();
    expect(first.thread.metadata).toMatchObject({
      scope: 'global',
      operatorThreadKind: 'root',
    });
  });

  it('appends user messages to the global Orchestrator thread', async () => {
    const ledger = createLedger();
    const service = new OperatorThreadService({ ledger, engine: null });

    const { conversation } = await service.sendMessage({ text: 'Pull all repos' });

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Pull all repos',
      sequence: 1,
    });
  });

  it('passes persisted user messages to the operator engine', async () => {
    const ledger = createLedger();
    const engine = new FakeOperatorEngine();
    const service = new OperatorThreadService({ ledger, engine });

    const { conversation } = await service.sendMessage({ text: 'Please pull all repos' });

    expect(engine.inputs).toEqual([
      {
        threadId: conversation.thread.id,
        sourceMessageId: conversation.messages[0].id,
        text: 'Please pull all repos',
      },
    ]);
  });

  it('returns the started operator run id with the visible conversation', async () => {
    const ledger = createLedger();
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const engine = new RunCreatingOperatorEngine(runStore);
    const service = new OperatorThreadService({ ledger, engine, runStore });

    const result = await service.sendMessage({ text: 'Please pull all repos' });

    expect(result.runId).toBe(engine.createdRunId);
    expect(result.conversation).toMatchObject({
      thread: { id: expect.any(String) },
      messages: [
        expect.objectContaining({ role: 'user', content: 'Please pull all repos' }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('repository operation') }),
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    db.close();
  });

  it('returns a visible Orchestrator acknowledgement when the engine is available', async () => {
    const ledger = createLedger();
    const engine = new FakeOperatorEngine();
    const service = new OperatorThreadService({ ledger, engine });

    const { conversation } = await service.sendMessage({ text: 'hi' });

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('I am here'),
    });
  });

  it('emits a run event after appending the final result message so renderer refreshes the transcript', async () => {
    const ledger = createLedger();
    const engine = new CompletingOperatorEngine();
    const appendedEvents: unknown[] = [];
    const service = new OperatorThreadService({
      ledger,
      engine,
      runStore: {
        appendEvent: (event) => {
          appendedEvents.push(event);
          return {
            id: 'event-1',
            runId: event.runId,
            nodeId: event.nodeId ?? null,
            kind: event.kind,
            payload: event.payload,
            createdAt: 1,
          };
        },
      },
    });

    const { conversation } = await service.sendMessage({ text: 'Please pull all repos' });
    await Promise.resolve();
    await Promise.resolve();

    const updated = ledger.getConversation(conversation.thread.id);
    expect(updated.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: expect.stringContaining('Pulled 1 repositories'),
    }));
    expect(appendedEvents).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        kind: 'progress',
        payload: {
          action: 'transcript-result-appended',
          threadId: conversation.thread.id,
        },
      }),
    ]);
  });

  it('appends an error message when the operator engine throws synchronously', async () => {
    const ledger = createLedger();
    const service = new OperatorThreadService({ ledger, engine: new ThrowingOperatorEngine() });

    const { conversation } = await service.sendMessage({ text: 'Please pull all repos' });
    await Promise.resolve();
    await Promise.resolve();

    const updated = ledger.getConversation(conversation.thread.id);
    expect(updated.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: expect.stringContaining('I could not complete that Operator request: engine exploded'),
      rawJson: expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'operator-error',
        }),
      }),
    }));
  });

  it('appends recovery notices to the global transcript', async () => {
    const ledger = createLedger();
    const service = new OperatorThreadService({ ledger, engine: null });
    const thread = await service.getThread();

    service.appendRecoveryNotice({
      runId: 'run-1',
      title: 'Implement in AI Orchestrator',
      status: 'blocked',
      message: 'Operator run recovery blocked: linked instance missing-instance is no longer active',
    });

    const conversation = ledger.getConversation(thread.thread.id);
    expect(conversation.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Recovered run blocked: Implement in AI Orchestrator'),
        rawJson: expect.objectContaining({
          metadata: expect.objectContaining({
            kind: 'operator-recovery',
            operatorRunId: 'run-1',
          }),
        }),
      }),
    ]);
  });

  function createLedger(): ConversationLedgerService {
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    ledgers.push(ledger);
    return ledger;
  }
});

class FakeOperatorEngine {
  inputs: Array<{ threadId: string; sourceMessageId: string; text: string }> = [];

  async handleUserMessage(input: { threadId: string; sourceMessageId: string; text: string }): Promise<null> {
    this.inputs.push(input);
    return null;
  }
}

class ThrowingOperatorEngine {
  handleUserMessage(): Promise<null> {
    throw new Error('engine exploded');
  }
}

class CompletingOperatorEngine {
  async handleUserMessage(): Promise<OperatorRunGraph> {
    return {
      run: {
        id: 'run-1',
        threadId: 'thread-1',
        sourceMessageId: 'message-1',
        title: 'Pull repositories',
        status: 'completed',
        autonomyMode: 'full',
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        goal: 'Please pull all repos',
        budget: {
          maxNodes: 50,
          maxRetries: 3,
          maxWallClockMs: 7200000,
          maxConcurrentNodes: 3,
        },
        usageJson: {
          nodesStarted: 1,
          nodesCompleted: 1,
          retriesUsed: 0,
          wallClockMs: 1,
        },
        planJson: {},
        resultJson: {
          synthesis: {
            summaryMarkdown: 'Pulled 1 repositories.',
          },
        },
        error: null,
      },
      nodes: [],
      events: [],
    };
  }
}

class RunCreatingOperatorEngine {
  createdRunId: string | null = null;

  constructor(private readonly runStore: OperatorRunStore) {}

  async handleUserMessage(input: { threadId: string; sourceMessageId: string; text: string }): Promise<OperatorRunGraph> {
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: 'Pull repositories',
      goal: input.text,
    });
    this.createdRunId = run.id;
    return { run, nodes: [], events: [] };
  }
}
