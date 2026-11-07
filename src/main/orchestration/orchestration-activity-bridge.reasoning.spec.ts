import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrchestrationActivityBridge, OrchestrationActivityBridge } from './orchestration-activity-bridge';
import { OrchestrationActivityEventSchema } from '@contracts/schemas/orchestration.schemas';

afterEach(() => { OrchestrationActivityBridge._resetForTesting(); vi.useRealTimers(); });
describe('reasoning activity', () => {
  it('sends reasoning at most once per instance per 2.5 seconds and clears throttles on cleanup', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const sendToRenderer = vi.fn();
    const bridge = getOrchestrationActivityBridge();
    bridge.initialize({ sendToRenderer } as never, new EventEmitter() as never, new EventEmitter() as never, new EventEmitter() as never);
    bridge.reportReasoning('session-a', 'Checking migrations');
    bridge.reportReasoning('session-a', 'Next thought');
    bridge.reportReasoning('session-b', 'Other thought');
    expect(sendToRenderer).toHaveBeenCalledTimes(2);
    expect(sendToRenderer).toHaveBeenCalledWith('orchestration:activity', { instanceId: 'session-a', activity: 'Thinking · Checking migrations', category: 'reasoning' });
    vi.advanceTimersByTime(2500); bridge.reportReasoning('session-a', 'Next thought');
    expect(sendToRenderer).toHaveBeenCalledTimes(3);
    bridge.cleanup();
  });
  it('accepts reasoning in the strict transport schema but rejects unknown categories', () => {
    const payload = { instanceId: 'session-a', activity: 'Thinking · Checking migrations', category: 'reasoning' };
    expect(OrchestrationActivityEventSchema.safeParse(payload).success).toBe(true);
    expect(OrchestrationActivityEventSchema.safeParse({ ...payload, category: 'unknown' }).success).toBe(false);
  });
});
