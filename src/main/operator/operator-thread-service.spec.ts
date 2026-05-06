import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
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

    const conversation = await service.sendMessage({ text: 'Pull all repos' });

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

    const conversation = await service.sendMessage({ text: 'Please pull all repos' });

    expect(engine.inputs).toEqual([
      {
        threadId: conversation.thread.id,
        sourceMessageId: conversation.messages[0].id,
        text: 'Please pull all repos',
      },
    ]);
  });

  it('returns a visible Orchestrator acknowledgement when the engine is available', async () => {
    const ledger = createLedger();
    const engine = new FakeOperatorEngine();
    const service = new OperatorThreadService({ ledger, engine });

    const conversation = await service.sendMessage({ text: 'hi' });

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('I am here'),
    });
  });

  it('appends an error message when the operator engine throws synchronously', async () => {
    const ledger = createLedger();
    const service = new OperatorThreadService({ ledger, engine: new ThrowingOperatorEngine() });

    const conversation = await service.sendMessage({ text: 'Please pull all repos' });
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
