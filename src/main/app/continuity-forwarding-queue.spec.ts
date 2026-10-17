import { beforeEach, describe, expect, it, vi } from 'vitest';
const continuity = vi.hoisted(() => ({
  updateState: vi.fn(async () => undefined),
  addConversationEntry: vi.fn(async (): Promise<boolean> => true),
  patchConversationEntry: vi.fn(async (): Promise<boolean> => true),
  checkpointCompleteConversation: vi.fn(async () => undefined),
  markConversationIncomplete: vi.fn(),
}));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManager: () => continuity }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
import { createContinuityForwardingQueue } from './continuity-forwarding-queue';

const entry = { id: 'message-placeholder', role: 'assistant' as const, content: 'placeholder', timestamp: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  continuity.addConversationEntry.mockResolvedValue(true);
  continuity.patchConversationEntry.mockResolvedValue(true);
  continuity.updateState.mockResolvedValue(undefined);
  continuity.checkpointCompleteConversation.mockResolvedValue(undefined);
});
describe('continuity proof queue', () => {
  it.each(['capacity', 'shutdown'] as const)('invalidates an entry dropped by %s before a later completion can certify it', async (reason) => {
    let release!: (stored: boolean) => void;
    continuity.addConversationEntry.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const queue = createContinuityForwardingQueue(1);
    queue.enqueue({ kind: 'entry', instanceId: 'held', entry });
    queue.enqueue({ kind: 'entry', instanceId: 'lost', entry });
    if (reason === 'capacity') queue.enqueue({ kind: 'entry', instanceId: 'lost', entry });
    else await queue.shutdown({ drain: false });
    expect(continuity.markConversationIncomplete).toHaveBeenCalledWith('lost');
    release(true); await queue.flush();
  });
  it.each(['entry', 'patch'] as const)('invalidates content when a %s write returns false', async (kind) => {
    continuity.addConversationEntry.mockResolvedValueOnce(false);
    continuity.patchConversationEntry.mockResolvedValueOnce(false);
    const queue = createContinuityForwardingQueue();
    queue.enqueue(kind === 'entry'
      ? { kind, instanceId: 'lost', entry }
      : { kind, instanceId: 'lost', entryId: entry.id, patch: { content: 'replacement' }, fallback: entry });
    await queue.flush();
    expect(continuity.markConversationIncomplete).toHaveBeenCalledWith('lost');
  });
});
