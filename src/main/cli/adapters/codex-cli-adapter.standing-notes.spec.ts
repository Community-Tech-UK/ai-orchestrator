import { describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { AppServerNotification } from './codex/app-server-types';

function harness() {
  const adapter = new CodexCliAdapter({ model: 'gpt-5' });
  const listeners = new Set<(n: AppServerNotification) => void>();
  const injected: { threadId: string; text: string }[] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* resident connection */ }),
    subscribeNotifications(listener: (n: AppServerNotification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/inject_items') {
        const items = params['items'] as { content: { text: string }[] }[];
        injected.push({ threadId: String(params['threadId']), text: items[0].content[0].text });
        return {};
      }
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    },
    isRunning: () => true,
  };
  Object.assign(adapter, {
    appServerClient: client,
    appServerThreadId: 'root',
    useAppServer: true,
  });
  client.subscribeNotifications((n) =>
    (adapter as unknown as { handleIdleAppServerNotification(n: AppServerNotification): void })
      .handleIdleAppServerNotification(n));
  return {
    adapter,
    injected,
    notify(notification: AppServerNotification) {
      for (const listener of listeners) listener(notification);
    },
    async seedNote(internalSource: 'plan-queue' | 'child-announcement' | 'context-policy' | 'compaction-continuity', text: string) {
      const target = adapter as unknown as { sendInputImpl: (...args: unknown[]) => Promise<void> };
      vi.spyOn(target, 'sendInputImpl').mockResolvedValue(undefined);
      await (adapter as unknown as {
        sendInput(message: string, attachments?: undefined, options?: { internalSource?: string }): Promise<void>;
      }).sendInput(text, undefined, { internalSource });
    },
  };
}

describe('Codex standing notes after a compaction', () => {
  it('a compaction that completes during an active turn re-injects the standing notes once', async () => {
    const h = harness();
    await h.seedNote('plan-queue', 'Plan queue round 2: fix loop-runner.spec.ts before re-checkpointing.');
    // Codex starts its own turn on the root thread...
    h.notify({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'turn-1' } } });
    // ...and compacts inside it (the inline compaction path).
    h.notify({
      method: 'item/completed',
      params: { threadId: 'root', turnId: 'turn-1', item: { type: 'contextCompaction', id: 'ci-1' } },
    });
    await vi.waitFor(() => expect(h.injected).toHaveLength(1));
    expect(h.injected[0].threadId).toBe('root');
    expect(h.injected[0].text).toContain('fix loop-runner.spec.ts before re-checkpointing');
    expect(h.injected[0].text).toContain('<harness_standing_notes>');
    // The turn ending does not re-inject.
    h.notify({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-1', status: 'completed' } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.injected).toHaveLength(1);
  });

  it('an idle compaction re-injects the standing notes once', async () => {
    const h = harness();
    await h.seedNote('child-announcement', 'Child session child-8812 finished with its findings saved.');
    // A dedicated compaction turn with no regular turn active.
    h.notify({
      method: 'item/started',
      params: { threadId: 'root', turnId: 'turn-c', item: { type: 'contextCompaction', id: 'ci-1' } },
    });
    h.notify({
      method: 'item/completed',
      params: { threadId: 'root', turnId: 'turn-c', item: { type: 'contextCompaction', id: 'ci-1' } },
    });
    await vi.waitFor(() => expect(h.injected).toHaveLength(1));
    expect(h.injected[0].text).toContain('child-8812 finished');
  });

  it('re-sends durable notes only and sends nothing when none exist', async () => {
    const h = harness();
    await h.seedNote('context-policy', 'Wrap up broad exploration.');
    await h.seedNote('compaction-continuity', 'Continuation of the compacted turn.');
    h.notify({
      method: 'item/completed',
      params: { threadId: 'root', turnId: 'turn-1', item: { type: 'contextCompaction', id: 'ci-1' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.injected).toHaveLength(0);

    await h.seedNote('plan-queue', 'The durable follow-up.');
    h.notify({
      method: 'item/completed',
      params: { threadId: 'root', turnId: 'turn-2', item: { type: 'contextCompaction', id: 'ci-2' } },
    });
    await vi.waitFor(() => expect(h.injected).toHaveLength(1));
    expect(h.injected[0].text).toContain('The durable follow-up.');
    expect(h.injected[0].text).not.toContain('Wrap up broad exploration.');
    expect(h.injected[0].text).not.toContain('Continuation of the compacted turn.');
  });
});
