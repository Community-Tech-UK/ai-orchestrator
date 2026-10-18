import { describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from './codex-cli-adapter';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('Codex loop provider compaction', () => {
  it('counts current contextCompaction completed once for the active turn through the shared notification hook', () => {
    const adapter = new CodexCliAdapter();
    const internals = adapter as unknown as {
      appServerThreadId: string;
      contextOuterSendId: string;
      appServerRuntime: { getCurrentTurnId(): string | null; hasActiveTurn(): boolean };
      handleIdleAppServerNotification(notification: { method: string; params: Record<string, unknown> }): void;
    };
    internals.appServerThreadId = 'test-thread'; internals.contextOuterSendId = 'send-1';
    vi.spyOn(internals.appServerRuntime, 'getCurrentTurnId').mockReturnValue('test-turn');
    vi.spyOn(internals.appServerRuntime, 'hasActiveTurn').mockReturnValue(true);
    const params = { threadId: 'test-thread', turnId: 'test-turn', item: { type: 'contextCompaction', id: 'compact-item' } };
    internals.handleIdleAppServerNotification({ method: 'item/started', params });
    expect(adapter.getTurnCompaction()).toEqual({ count: 0 });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params });
    expect(adapter.getTurnCompaction()).toEqual({ count: 1 });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params });
    internals.handleIdleAppServerNotification({ method: 'thread/compacted', params: { threadId: 'test-thread', turnId: 'test-turn' } });
    internals.handleIdleAppServerNotification({ method: 'item/completed', params: { ...params, threadId: 'different-thread' } });
    expect(adapter.getTurnCompaction()).toEqual({ count: 1 });
    internals.contextOuterSendId = 'send-2';
    expect(adapter.getTurnCompaction()).toEqual({ count: 0 });
  });
});
