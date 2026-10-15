import { describe, expect, it } from 'vitest';
import { prepareUserClose } from './instance-close-all';
describe('prepareUserClose', () => {
  it('pauses the queue synchronously before awaiting loop shutdown', async () => {
    const events: string[] = [];
    const result = await prepareUserClose(['session'], 'all', { stopLoops: async () => { events.push('loops'); return 2; }, queue: { isInitialized: () => true, noteUserClosing: (_ids, scope) => { events.push(scope); return 1; } } });
    expect(events).toEqual(['all', 'loops']);
    expect(result).toEqual({ loopsStopped: 2, planQueueRunsPaused: 1 });
  });
  it('marks one close without pausing uninitialised queues', async () => {
    expect(await prepareUserClose(['session'], 'one', { stopLoops: async () => 0, queue: { isInitialized: () => false, noteUserClosing: () => { throw new Error('not ready'); } } })).toEqual({ loopsStopped: 0, planQueueRunsPaused: 0 });
  });
});
