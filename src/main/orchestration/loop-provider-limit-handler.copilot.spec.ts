import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';
import { routeClassifiedLoopInvocationFailure } from './loop-invocation-error-routing';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { EARLY_RESUME_PROBE_MS } from '../instance/instance-provider-limit-handler';
import { COPILOT_LIMIT_FIXTURES } from '../cli/copilot-limit-fixtures.test-helpers';

function state(): LoopState {
  return { id: 'loop-copilot', chatId: 'chat', status: 'running', endedAt: null, totalIterations: 0,
    config: { ...defaultLoopConfig('/tmp/project', 'continue'), provider: 'copilot' } } as LoopState;
}
function harness() {
  const deps = { emit: vi.fn(), cloneStateForBroadcast: (s: LoopState) => s, setConvergenceNote: vi.fn(),
    terminate: vi.fn(), resumeLoop: vi.fn(() => true), requestContextReset: vi.fn() };
  const handler = new LoopProviderLimitHandler(deps);
  handler.setLoopAccountFailover({ currentProfileId: () => null, trySwitch: () => false });
  const scheduler = vi.fn(() => vi.fn());
  handler.setProviderLimitResumeScheduler(scheduler);
  return { deps, handler, scheduler };
}
describe('Copilot loop limits', () => {
  afterEach(() => vi.useRealTimers());
  it('parks weekly notices for six hours without snapshot refresh or early probing', async () => {
    vi.useFakeTimers();
    const { handler, deps, scheduler } = harness();
    const s = state();
    const refresh = vi.fn(async () => null);
    handler.setQuotaSnapshotRefresher(refresh);
    const derived = await handler.deriveProviderLimitResumeAfterRefresh(s, COPILOT_LIMIT_FIXTURES[3][0]);
    expect(derived).toEqual({ resumeAt: Date.now() + 6 * 3600_000, earlyProbe: false });
    expect(handler.handleProviderLimit(s, { ...derived, reason: 'weekly', source: 'notice', action: 'notice' })).toBe('parked');
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    expect(deps.resumeLoop).not.toHaveBeenCalled();
    expect(scheduler).toHaveBeenCalledTimes(1);
    handler.clearResumeTimer(s.id);
  });
  it('recycles session-spend once, with the guard retained in serialized state', async () => {
    const { handler, deps } = harness();
    const s = state();
    const derived = await handler.deriveProviderLimitResumeAfterRefresh(s, COPILOT_LIMIT_FIXTURES[4][0]);
    expect(derived).toEqual({ resumeAt: null, recycle: true });
    const opts = { ...derived, reason: 'spending limit', source: 'notice' as const, action: 'notice' as const };
    expect(handler.handleProviderLimit(s, opts)).toBe('recycled');
    expect(deps.requestContextReset).toHaveBeenCalledOnce();
    const restored = JSON.parse(JSON.stringify(s)) as LoopState;
    const next = harness();
    expect(next.handler.handleProviderLimit(restored, opts)).toBe('terminated');
    expect(next.deps.terminate).toHaveBeenCalledWith(restored, 'provider-limit', expect.stringContaining('twice'));
  });
  it('routes a weekly-limit error to a park without degraded retries', () => {
    const { handler } = harness();
    const s = state();
    expect(routeClassifiedLoopInvocationFailure({ state: s, error: new Error(COPILOT_LIMIT_FIXTURES[3][0]),
      seq: 0, stage: 'IMPLEMENT', contextOverflowRecoveryAttempted: false, providerLimitHandler: handler, emit: vi.fn() })).toBe('parked');
    expect(s.status).toBe('provider-limit');
    handler.clearResumeTimer(s.id);
  });
});
