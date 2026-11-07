import { describe, expect, it, vi } from 'vitest';
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
    expect(h.sendInput).toHaveBeenCalledWith('parent', 'Run ended', undefined, { automatedInput: true, internalSource: 'plan-queue' });
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
