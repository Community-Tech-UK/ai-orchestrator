import { describe, expect, it, vi } from 'vitest';
import { OrchestrationEngine } from './orchestration-engine';

describe('OrchestrationEngine', () => {
  it('appends dispatched commands through the event store and supports drain()', async () => {
    const append = vi.fn();
    const engine = new OrchestrationEngine({
      append,
    } as never);

    const event = engine.dispatch({
      type: 'verification.requested',
      aggregateId: 'verify-1',
      payload: { instanceId: 'inst-1' },
      metadata: { source: 'test' },
    });

    await engine.drain();

    expect(append).toHaveBeenCalledWith(event);
  });
});
