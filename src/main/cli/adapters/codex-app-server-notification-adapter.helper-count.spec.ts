import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { AppServerNotification } from './codex/app-server-types';
import { recordSessionPolicy } from '../../core/system/session-policy-log';

vi.mock('../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

/**
 * Notification shapes below follow the generated app-server protocol of the
 * installed Codex (0.163.0, `codex app-server generate-ts`):
 *   ItemStartedNotification   { item, threadId, turnId, startedAtMs }
 *   ItemCompletedNotification { item, threadId, turnId, completedAtMs }
 *   collabAgentToolCall  { type, id, tool: "spawnAgent" | "sendInput" | "wait" | "closeAgent" | ...,
 *                          status: "inProgress" | "completed" | "failed" | "interrupted",
 *                          senderThreadId, receiverThreadIds[], prompt, model, reasoningEffort, agentsStates }
 *   subAgentActivity     { type, id, kind: "started" | "interacted" | "interrupted" | "completed",
 *                          agentThreadId, agentPath, model, reasoningEffort }
 */
/** Replaced with the id of the turn the adapter has just started, as a real server stamps it. */
const CURRENT_TURN = '<current-turn>';

function collab(tool: string, status: string, receiverThreadIds: string[], senderThreadId = 'root', id = `call-${tool}`) {
  return {
    type: 'collabAgentToolCall', id, tool, status, senderThreadId, receiverThreadIds,
    prompt: null, model: null, reasoningEffort: null,
    agentsStates: Object.fromEntries(receiverThreadIds.map(thread => [thread, { status: 'running', message: null }])),
  };
}
function activity(kind: string, agentThreadId: string, id = `activity-${agentThreadId}`) {
  return { type: 'subAgentActivity', id, kind, agentThreadId, agentPath: `/root/${agentThreadId}`, model: null, reasoningEffort: null };
}
function itemEvent(method: 'item/started' | 'item/completed', item: Record<string, unknown>, threadId = 'root'): AppServerNotification {
  return { method, params: { threadId, turnId: CURRENT_TURN, item, ...(method === 'item/started' ? { startedAtMs: 1 } : { completedAtMs: 2 }) } };
}

function harness(config: { harnessInstanceId?: string } = { harnessInstanceId: 'instance-1' }) {
  const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', ...config });
  const listeners = new Set<(n: AppServerNotification) => void>();
  let sequence = 0;
  let pending: AppServerNotification[] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* resident connection */ }),
    subscribeNotifications(listener: (n: AppServerNotification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request() {
      const id = `turn-${++sequence}`;
      for (const listener of listeners) listener({ method: 'turn/started', params: { threadId: 'root', turn: { id } } });
      for (const notification of pending) {
        const stamped = notification.params['turnId'] === CURRENT_TURN
          ? { ...notification, params: { ...notification.params, turnId: id } } : notification;
        for (const listener of listeners) listener(stamped);
      }
      return { turn: { id, status: 'inProgress' } };
    },
  };
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'root' });
  return {
    async turn(events: AppServerNotification[]) {
      pending = [...events, { method: 'turn/completed', params: { threadId: 'root', turn: { id: `turn-${sequence + 1}`, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } } }];
      await (adapter as unknown as { appServerSendMessageInner(message: string): Promise<void> }).appServerSendMessageInner('work');
    },
  };
}

const helperCounts = () => vi.mocked(recordSessionPolicy).mock.calls
  .map(([record]) => record)
  .filter(record => 'recordType' in record && record.recordType === 'helper-count');

describe('Codex helper-thread counter (R3J1)', () => {
  beforeEach(() => { vi.mocked(recordSessionPolicy).mockClear(); });

  it('logs one growing count per root as helpers appear, from both real item types', async () => {
    const h = harness();
    await h.turn([
      itemEvent('item/started', collab('spawnAgent', 'inProgress', [])),
      itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1'])),
      itemEvent('item/started', activity('started', 'child-2')),
    ]);
    expect(helperCounts()).toEqual([
      { provider: 'codex', recordType: 'helper-count', threadId: 'root', instanceId: 'instance-1', helperThreads: 1 },
      { provider: 'codex', recordType: 'helper-count', threadId: 'root', instanceId: 'instance-1', helperThreads: 2 },
    ]);
  });

  it('counts a helper once however many items mention it, and never counts the root', async () => {
    const h = harness();
    await h.turn([
      itemEvent('item/started', collab('spawnAgent', 'inProgress', ['child-1'], 'root', 'spawn')),
      itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1'], 'root', 'spawn')),
      itemEvent('item/started', collab('sendInput', 'inProgress', ['child-1'], 'root', 'send')),
      itemEvent('item/completed', collab('wait', 'completed', ['child-1'], 'root', 'wait')),
      itemEvent('item/completed', activity('interacted', 'child-1', 'a1')),
      itemEvent('item/completed', activity('completed', 'child-1', 'a2')),
      itemEvent('item/completed', collab('closeAgent', 'completed', ['child-1'], 'root', 'close')),
      // A helper writing back to the root names the root as the receiver.
      itemEvent('item/completed', collab('sendMessage', 'completed', ['root'], 'child-1', 'reply'), 'child-1'),
    ]);
    expect(helperCounts().map(record => 'helperThreads' in record && record.helperThreads)).toEqual([1]);
  });

  it('keeps counting across turns instead of starting again from one', async () => {
    const h = harness();
    await h.turn([itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1']))]);
    await h.turn([itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1'], 'root', 'again'))]);
    await h.turn([itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-2'], 'root', 'second'))]);
    expect(helperCounts().map(record => 'helperThreads' in record && record.helperThreads)).toEqual([1, 2]);
  });

  it('counts a helper started by one of the root\'s own helpers, and ignores threads the root does not own', async () => {
    const h = harness();
    await h.turn([
      itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1'])),
      itemEvent('item/completed', collab('spawnAgent', 'completed', ['grand-1'], 'child-1', 'nested'), 'child-1'),
      itemEvent('item/completed', collab('spawnAgent', 'completed', ['stranger-child'], 'stranger', 'foreign'), 'stranger'),
    ]);
    expect(helperCounts().map(record => 'helperThreads' in record && record.helperThreads)).toEqual([1, 2]);
  });

  it('writes nothing when no helper appears, including a failed spawn that named no thread', async () => {
    const h = harness();
    await h.turn([
      itemEvent('item/started', collab('spawnAgent', 'inProgress', [])),
      itemEvent('item/completed', collab('spawnAgent', 'failed', [])),
      itemEvent('item/completed', { type: 'agentMessage', id: 'm1', text: 'done', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }),
      itemEvent('item/completed', { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' }),
    ]);
    expect(helperCounts()).toEqual([]);
  });

  it('omits the instance id when the adapter has none', async () => {
    const h = harness({});
    await h.turn([itemEvent('item/completed', collab('spawnAgent', 'completed', ['child-1']))]);
    expect(helperCounts()).toEqual([
      { provider: 'codex', recordType: 'helper-count', threadId: 'root', helperThreads: 1 },
    ]);
  });
});
