import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputTurnRegistry } from '../instance/input-turn-registry';
import { PlanQueueParentMessenger } from './plan-queue-parent-messenger';
import type { PlanQueueInstancePort } from './plan-queue-host';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

function harness(questionsToParent = false) {
  const run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null } as PlanQueueRun;
  const item = { id: 'item', runId: 'run', state: 'awaiting-input', question: { question: 'Which account?', options: [] } } as unknown as PlanQueueItem;
  const sendInput = vi.fn().mockResolvedValue(undefined);
  const postNote = vi.fn();
  const messenger = new PlanQueueParentMessenger({
    instances: { getInstance: () => ({ id: 'parent', status: 'idle', outputBuffer: [] }), getAllInstances: () => [], sendInput, createInstance: vi.fn(), terminateInstance: vi.fn(), restartFreshInstance: vi.fn() } as unknown as PlanQueueInstancePort,
    listItems: () => [item], getRun: () => run, setParent: vi.fn(), isQueueInstance: () => false,
    postNote, questionsToParent: () => questionsToParent,
  });
  return { messenger, run, item, sendInput, postNote };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('queue parent messages', () => {
  it('keeps questions and ownership replays on the queue page by default', () => {
    const h = harness();
    h.messenger.onParentChanged(h.run);
    h.messenger.notify(h.run, 'Question', [h.item]);
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.postNote).not.toHaveBeenCalled();
  });
  it('posts notices quietly and sends one model-visible run summary', async () => {
    const h = harness();
    h.messenger.notify(h.run, 'Routing changed');
    expect(h.postNote).toHaveBeenCalledWith('parent', 'Routing changed');
    expect(h.sendInput).not.toHaveBeenCalled();
    h.messenger.notify(h.run, 'Run ended', undefined, true);
    expect(h.sendInput).toHaveBeenCalledWith('parent', 'Run ended', undefined,
      { automatedInput: true, internalSource: 'plan-queue', userMessageId: expect.any(String) });
  });
  it("announces the run summary as a report, so it does not replace James's latest message", () => {
    const registry = new InputTurnRegistry();
    vi.spyOn(InputTurnRegistry, 'getInstance').mockReturnValue(registry);
    const h = harness();
    registry.setReportsTurnStarts('parent', true);
    registry.noteInput('parent', { messageId: 'james', personTypedAt: 5_000 });
    registry.noteTurnStarted('parent', 'harness-send');

    h.messenger.notify(h.run, 'Run ended', undefined, true);
    const { userMessageId } = h.sendInput.mock.calls[0]![3] as { userMessageId: string };
    registry.noteInput('parent', { messageId: userMessageId, personTypedAt: null });

    expect(registry.checkPersonTurn('parent')).toEqual({ ok: true, messageId: 'james', typedAt: 5_000 });
  });
  it('forgets the announcement when the run summary could not be sent', async () => {
    const registry = new InputTurnRegistry();
    vi.spyOn(InputTurnRegistry, 'getInstance').mockReturnValue(registry);
    const h = harness();
    h.sendInput.mockRejectedValueOnce(new Error('session gone'));
    registry.setReportsTurnStarts('parent', true);
    registry.noteInput('parent', { messageId: 'james', personTypedAt: 5_000 });
    registry.noteTurnStarted('parent', 'harness-send');

    h.messenger.notify(h.run, 'Run ended', undefined, true);
    const { userMessageId } = h.sendInput.mock.calls[0]![3] as { userMessageId: string };
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the failed send settle
    registry.noteInput('parent', { messageId: userMessageId, personTypedAt: null });
    expect(registry.checkPersonTurn('parent')).toEqual({ ok: false, reason: 'latest-input-not-person' });
  });
  it('keeps a failed quiet note from interrupting queue work', () => {
    const h = harness();
    h.postNote.mockImplementation(() => { throw new Error('observer failed'); });
    expect(() => h.messenger.notify(h.run, 'Routing changed')).not.toThrow();
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it('sends questions when the parent chat is selected', () => {
    const h = harness(true);
    h.messenger.notify(h.run, 'Question', [h.item]);
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(h.postNote).not.toHaveBeenCalled();
  });
});
