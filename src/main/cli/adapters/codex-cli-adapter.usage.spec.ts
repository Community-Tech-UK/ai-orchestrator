import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { CliResponse } from './base-cli-adapter';
import type { AppServerNotification } from './codex/app-server-types';

function harness() {
  const adapter = new CodexCliAdapter({ model: 'gpt-6-astra' });
  const listeners = new Set<(n: AppServerNotification) => void>();
  let notifications: AppServerNotification[] = [];
  let sequence = 0;
  let transportError = false;
  const client = {
    exitPromise: new Promise<void>(() => { /* resident connection */ }),
    subscribeNotifications(listener: (n: AppServerNotification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request() {
      const id = `turn-${++sequence}`;
      for (const listener of listeners) listener({ method: 'turn/started', params: { threadId: 'root', turn: { id } } });
      for (const notification of notifications) for (const listener of listeners) listener(notification);
      if (transportError) throw new Error('connection reset by peer');
      return { turn: { id, status: 'inProgress' } };
    },
  };
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'root' });
  client.subscribeNotifications(notification =>
    (adapter as unknown as { handleIdleAppServerNotification(n: AppServerNotification): void }).handleIdleAppServerNotification(notification));
  const completions: CliResponse[] = [];
  const partials: CliResponse['usage'][] = [];
  const contexts: { used: number; total: number; cumulativeTokens: number }[] = [];
  adapter.on('complete', response => completions.push(response));
  adapter.on('usage', usage => partials.push(usage));
  adapter.on('context', context => contexts.push(context));
  return {
    adapter, completions, partials, contexts,
    notify(notification: AppServerNotification) { for (const listener of listeners) listener(notification); },
    async send(events: AppServerNotification[], status = 'completed', usage?: Record<string, number>) {
      transportError = status === 'transport-error';
      notifications = transportError ? events : [...events, { method: 'turn/completed', params: { threadId: 'root', turn: { id: `turn-${sequence + 1}`, status, usage } } }];
      await (adapter as unknown as { appServerSendMessageInner(message: string): Promise<void> }).appServerSendMessageInner('account usage');
    },
  };
}

function sample(input: number, cached: number, output: number, reasoning = 0) {
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output };
}
function update(total: ReturnType<typeof sample>, last = total, threadId = 'root'): AppServerNotification {
  return { method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total, last, modelContextWindow: 258400 } } };
}

describe('Codex cumulative usage accounting', () => {
  it('retains child native-turn accounting across root turns and stale completions', async () => {
    const h = harness();
    const completed: AppServerNotification = { method: 'turn/completed', params: { threadId: 'child', turn: {
      id: 'child-turn', status: 'completed', usage: sample(150, 100, 30),
    } } };
    await h.send([
      update(sample(100, 80, 20)),
      { method: 'thread/started', params: { thread: { id: 'child' } } },
      { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } },
      update(sample(100, 80, 20), undefined, 'child'),
    ]);
    await h.send([
      update(sample(150, 100, 30), sample(50, 20, 10)),
      update(sample(150, 100, 30), sample(50, 20, 10), 'child'),
      completed,
    ]);
    h.notify(completed);
    await h.send([completed, update(sample(200, 140, 40), sample(50, 40, 10))]);
    expect(h.completions.map(r => r.usage?.totalTokens)).toEqual([240, 120, 60]);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(420);
    expect(h.partials).toHaveLength(0);
  });

  it.each(['idle', 'same-batch'] as const)('retains completion-only child usage at the %s root boundary', async boundary => {
    const h = harness();
    const completed: AppServerNotification = { method: 'turn/completed', params: { threadId: 'child', turn: {
      id: 'child-turn', status: 'completed', usage: sample(50, 20, 10),
    } } };
    await h.send([
      { method: 'thread/started', params: { thread: { id: 'child' } } },
      { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } },
      update(sample(100, 80, 20)),
      ...(boundary === 'same-batch' ? [
        { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-1', status: 'completed' } } } satisfies AppServerNotification, completed,
      ] : []),
    ]);
    h.notify(completed);
    h.notify(completed);
    expect(h.completions[0].usage?.totalTokens).toBe(boundary === 'idle' ? 120 : 180);
    expect(h.partials).toHaveLength(boundary === 'idle' ? 1 : 0);
    if (boundary === 'idle') expect(h.partials[0]).toMatchObject({ totalTokens: 60, isEstimated: true });
    expect(h.contexts.at(-1)).toMatchObject({ used: 120, total: 258400, cumulativeTokens: 180 });
    await h.send([completed, update(sample(150, 100, 30), sample(50, 20, 10))]);
    expect(h.completions[1].usage?.totalTokens).toBe(60);
    h.notify({ ...completed, params: { ...completed.params, threadId: 'foreign' } });
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(240);
  });

  it('keeps same-batch usage trailing turn/completed in the successful response', async () => {
    const h = harness();
    await h.send([
      update(sample(100, 80, 20)),
      { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-1', status: 'completed' } } },
      update(sample(150, 100, 30), sample(50, 20, 10)),
    ]);
    expect(h.completions[0].usage?.totalTokens).toBe(180);
    expect(h.partials).toHaveLength(0);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(180);
  });

  it('persists late idle usage once between completed turns', async () => {
    const h = harness();
    await h.send([update(sample(100, 80, 20, 4))]);
    const idle = update(sample(150, 100, 30, 6), sample(50, 20, 10, 2));
    h.notify(idle);
    h.notify(idle);
    expect(h.partials).toMatchObject([{ totalTokens: 60 }]);
    await h.send([update(sample(200, 140, 40, 8), sample(50, 40, 10, 2))]);
    expect(h.completions.map(r => r.usage?.totalTokens)).toEqual([120, 60]);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(240);
  });

  it('persists idle child increments while preserving root occupancy and window', async () => {
    const h = harness();
    await h.send([
      update(sample(100, 80, 20)),
      { method: 'thread/started', params: { thread: { id: 'child' } } },
      update(sample(100, 80, 20), undefined, 'child'),
    ]);
    const idle = update(sample(150, 100, 30), sample(50, 20, 10), 'child');
    (idle.params['tokenUsage'] as Record<string, unknown>)['modelContextWindow'] = 500;
    h.notify(idle);
    h.notify(idle);
    expect(h.partials).toMatchObject([{ totalTokens: 60, isEstimated: true }]);
    expect(h.contexts.at(-1)).toMatchObject({ used: 120, total: 258400, cumulativeTokens: 300 });
    await h.send([update(sample(150, 100, 30), sample(50, 20, 10))]);
    expect(h.completions[1].usage?.totalTokens).toBe(60);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(360);
  });

  it.each([
    ['failed', false], ['interrupted', false], ['failed', true], ['interrupted', true],
  ] as const)('publishes partial %s cumulative context with notification=%s exactly once', async (status, notified) => {
    const h = harness();
    const result = h.send(notified ? [update(sample(100, 80, 20, 4))] : [], status, {
      input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 4,
    });
    if (status === 'failed') await expect(result).rejects.toThrow('Codex turn failed');
    else await result;
    expect(h.contexts.at(-1)).toMatchObject({
      used: notified ? 120 : 0, cumulativeTokens: 120, costEstimate: 0.00128,
      ...(!notified ? { isEstimated: true } : {}),
    });
    expect(h.partials).toHaveLength(1);
    expect(h.completions).toHaveLength(0);
    const contextCount = h.contexts.length;
    (h.adapter as unknown as { flushPartialUsage(): void }).flushPartialUsage();
    expect(h.contexts).toHaveLength(contextCount);
    expect(h.partials).toHaveLength(1);
  });

  it('reconciles the audit multicall example and deduplicates cumulative snapshots', async () => {
    const h = harness();
    const first = sample(3968712, 3857500, 8108);
    const total = sample(4079980, 3968768, 8235);
    const last = sample(111268, 111268, 127);
    await h.send([update(first), update(total, last), update(total, last)]);
    expect(h.completions[0].usage).toMatchObject({ inputTokens: 111212, cacheReadTokens: 3968768, outputTokens: 8235, totalTokens: 4088215 });
    expect(h.completions[0].usage?.cost).toBeCloseTo(5.492638, 6);
    expect(h.contexts.at(-1)?.used).toBe(111395);
    expect(h.partials).toHaveLength(0);
  });

  it('subtracts cache/reasoning once, differences subsequent turns, and ignores completion duplicate usage', async () => {
    const h = harness();
    await h.send([update(sample(100, 80, 20, 4))], 'completed', { input_tokens: 100, output_tokens: 20 });
    await h.send([update(sample(240, 180, 50, 14), sample(140, 100, 30, 10))]);
    expect(h.completions.map(r => r.usage)).toMatchObject([
      { inputTokens: 20, cacheReadTokens: 80, outputTokens: 16, reasoningTokens: 4, totalTokens: 120 },
      { inputTokens: 40, cacheReadTokens: 100, outputTokens: 20, reasoningTokens: 10, totalTokens: 170 },
    ]);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(290);
  });

  it('starts a new epoch on cumulative reset without losing prior spend', async () => {
    const h = harness();
    await h.send([update(sample(100, 80, 20)), update(sample(10, 0, 5))]);
    expect(h.completions[0].usage).toMatchObject({ inputTokens: 30, cacheReadTokens: 80, outputTokens: 25, totalTokens: 135 });
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(135);
  });

  it('counts child spend independently and keeps root occupancy/window authoritative', async () => {
    const h = harness();
    await h.send([
      update(sample(100, 80, 20)),
      { method: 'thread/started', params: { thread: { id: 'child' } } },
      update(sample(500, 300, 100, 50), undefined, 'child'),
    ]);
    expect(h.completions[0].usage).toMatchObject({ inputTokens: 220, cacheReadTokens: 380, outputTokens: 70, reasoningTokens: 50, totalTokens: 720, isEstimated: true });
    expect(h.contexts.every(c => c.used === 120)).toBe(true);
    expect(h.contexts.at(-1)?.cumulativeTokens).toBe(720);
  });

  it.each(['failed', 'interrupted'])('preserves partial %s spend without completing or charging again next turn', async status => {
    const h = harness();
    const first = h.send([update(sample(100, 80, 20, 4))], status);
    if (status === 'failed') await expect(first).rejects.toThrow('Codex turn failed');
    else await first;
    expect(h.completions).toHaveLength(0);
    expect(h.partials).toMatchObject([{ inputTokens: 20, cacheReadTokens: 80, outputTokens: 16, reasoningTokens: 4, totalTokens: 120 }]);
    await h.send([update(sample(150, 100, 30, 6), sample(50, 20, 10, 2))]);
    expect(h.completions[0].usage?.totalTokens).toBe(60);
    expect(h.partials).toHaveLength(1);
  });

  it('uses an observed idle/resume baseline without charging historical spend', async () => {
    const h = harness();
    (h.adapter as unknown as { handleIdleAppServerNotification(n: AppServerNotification): void }).handleIdleAppServerNotification(update(sample(1000, 800, 200)));
    await h.send([update(sample(1100, 880, 220), sample(100, 80, 20))]);
    expect(h.completions[0].usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 20, totalTokens: 120 });
  });

  it('marks an unbaselined resumed first sample as a lower-bound estimate', async () => {
    const h = harness();
    Object.assign(h.adapter, { lastResumeAttemptResult: { confirmed: true, source: 'native' } });
    await h.send([update(sample(1100, 880, 220), sample(100, 80, 20))]);
    expect(h.completions[0].usage).toMatchObject({ inputTokens: 20, totalTokens: 120, isEstimated: true });
  });

  it('uses completion-only fallback once and aligns a later cumulative snapshot', async () => {
    const h = harness();
    await h.send([], 'completed', { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, reasoning_output_tokens: 4 });
    await h.send([update(sample(150, 100, 30, 6), sample(50, 20, 10, 2))]);
    expect(h.completions.map(r => r.usage?.totalTokens)).toEqual([120, 60]);
  });

  it('flushes abandoned transport-failure usage once and leaves the next turn independent', async () => {
    const h = harness();
    await expect(h.send([update(sample(100, 80, 20))], 'transport-error')).rejects.toThrow('connection reset');
    expect(h.partials).toHaveLength(1);
    expect(h.completions).toHaveLength(0);
    await h.send([update(sample(150, 100, 30), sample(50, 20, 10))]);
    expect(h.completions[0].usage?.totalTokens).toBe(60);
    expect(h.partials).toHaveLength(1);
  });
});
