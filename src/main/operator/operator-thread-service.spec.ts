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
