import { describe, expect, it, vi } from 'vitest';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { bindInstanceAsyncWorkPublisher } from './instance-async-work-publisher';

describe('bindInstanceAsyncWorkPublisher', () => {
  it('publishes background work as it starts and clears', () => {
    const registry = new InstanceAsyncWorkRegistry(() => 42);
    const queueInstanceUpdate = vi.fn();
    const unbind = bindInstanceAsyncWorkPublisher(registry, { queueInstanceUpdate });

    registry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
    registry.observe('i1', { phase: 'snapshot', work: [] });
    unbind();
    registry.observe('i1', { phase: 'started', workId: 'bg-2', kind: 'background-shell' });

    expect(queueInstanceUpdate.mock.calls).toEqual([
      ['i1', { backgroundWork: { count: 1, since: 42 } }],
      ['i1', { backgroundWork: null }],
    ]);
  });
});
