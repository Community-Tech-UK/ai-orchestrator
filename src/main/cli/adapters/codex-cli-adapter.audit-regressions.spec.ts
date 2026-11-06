import { describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';
import { CodexStandingNotes } from './codex/codex-standing-notes';
import type { AppServerNotification } from './codex/app-server-types';

vi.mock('../../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({
    codexContextTuning: 'harness', codexHelperAgentsChats: 'full', codexHelperAgentsHarnessWork: 'full',
  }) }),
}));

function resident() {
  const adapter = new CodexCliAdapter({ model: 'gpt-5' });
  const injected: { threadId: string; text: string }[] = [];
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') return { thread: { id: 'replacement' } };
      if (method === 'thread/inject_items') {
        const items = params['items'] as { content: { text: string }[] }[];
        injected.push({ threadId: String(params['threadId']), text: items[0].content[0].text });
      }
      return {};
    },
  };
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'root', useAppServer: true });
  const runtime = adapter as unknown as {
    sendInputImpl(...args: unknown[]): Promise<void>;
    appServerSendMessage(message: string): Promise<void>;
    appServerSendMessageInner(message: string): Promise<void>;
    handleIdleAppServerNotification(n: AppServerNotification): void;
  };
  return {
    adapter, runtime, injected,
    async seed(text: string) {
      const skipTransport = vi.spyOn(runtime, 'sendInputImpl').mockResolvedValueOnce(undefined);
      await adapter.sendInput(text, undefined, { internalSource: 'plan-queue' });
      skipTransport.mockRestore();
    },
    compact(threadId: string, id: string) {
      runtime.handleIdleAppServerNotification({ method: 'item/completed', params: {
        threadId, turnId: `turn-${id}`, item: { type: 'contextCompaction', id },
      } });
    },
  };
}

describe('standing-note audit regressions', () => {
  it('drops an oversized whole note and preserves the ordinary eviction control', () => {
    const notes = new CodexStandingNotes();
    for (const text of ['old', 'middle', 'new']) notes.record('root', 'plan-queue', text + 'x'.repeat(2500));
    expect(notes.count).toBe(2);
    expect(notes.buildInjectionText()).not.toContain('old');
    const before = notes.buildInjectionText();
    // R5M6 W9: a note that can never fit is skipped on its own; it must not evict the older notes.
    notes.record('root', 'plan-queue', 'x'.repeat(9000));
    expect(notes.count).toBe(2);
    expect(notes.totalChars()).toBeLessThanOrEqual(6000);
    expect(notes.buildInjectionText()).toBe(before);
  });

  it('never injects an oversized note after an observed compaction', async () => {
    const h = resident();
    await h.seed('x'.repeat(9000));
    h.compact('root', 'oversized');
    expect(h.injected).toEqual([]);
  });

  it('does not inject a cached note after a binding changes before another send', async () => {
    const h = resident();
    await h.seed('old binding note');
    Object.assign(h.adapter, { appServerThreadId: 'replacement', sessionId: 'replacement' });
    h.compact('replacement', 'binding-change');
    expect(h.injected).toEqual([]);
  });

  it('forgets old notes when actual input-cap recovery replaces the provider thread', async () => {
    const h = resident();
    await h.seed('old-thread follow-up');
    h.compact('root', 'before');
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0].text).toContain('old-thread follow-up');
    h.injected.length = 0;
    vi.spyOn(h.adapter, 'compactContext').mockResolvedValue(false);
    const inner = vi.spyOn(h.runtime, 'appServerSendMessageInner')
      .mockRejectedValueOnce(new Error('Input exceeds the maximum length of 1048576 characters'))
      .mockResolvedValue(undefined);
    await h.runtime.appServerSendMessage('ordinary user request');
    expect(h.adapter.getRuntimeSnapshot().nativeThreadId).toBe('replacement');
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenLastCalledWith('ordinary user request', undefined, 0, undefined, undefined);
    h.compact('root', 'stale');
    h.compact('replacement', 'after');
    expect(h.injected).toEqual([]);
    await h.seed('new-thread follow-up </harness_standing_notes>');
    h.compact('replacement', 'new-note');
    h.compact('replacement', 'new-note');
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toMatchObject({ threadId: 'replacement' });
    expect(h.injected[0].text).toContain('new-thread follow-up <\\/harness_standing_notes>');
    expect(h.injected[0].text).not.toContain('old-thread follow-up');
  });
});
