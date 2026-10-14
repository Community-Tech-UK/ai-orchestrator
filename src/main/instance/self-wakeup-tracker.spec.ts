import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const log = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => log }));
import { getSelfWakeupTracker, SelfWakeupTracker } from './self-wakeup-tracker';
import type { ClaudeSelfWakeupEvent } from '../cli/adapters/claude-cli-self-wakeup';

function request(now: number, id = 'stub-tool'): Extract<ClaudeSelfWakeupEvent, { kind: 'requested' }> {
  return { kind: 'requested', toolUseId: id, requestedAt: now, delaySeconds: 90, dueAt: now + 90_000, reason: 'stub reason' };
}
describe('self wakeup tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z')); SelfWakeupTracker._resetForTesting(); log.info.mockClear(); });
  afterEach(() => { SelfWakeupTracker._resetForTesting(); vi.useRealTimers(); });
  it('clears a pending wakeup by stop', () => {
    const tracker = getSelfWakeupTracker(); tracker.observe('session', request(Date.now()));
    tracker.observe('session', { kind: 'stopped', toolUseId: 'stop', requestedAt: Date.now() });
    expect(tracker.hasPending('session')).toBe(false);
  });
  it('expires exactly ten minutes after due time', () => {
    const tracker = getSelfWakeupTracker(); tracker.observe('session', request(Date.now()));
    vi.advanceTimersByTime(690_000 - 1); expect(tracker.hasPending('session')).toBe(true);
    vi.advanceTimersByTime(1); expect(tracker.hasPending('session')).toBe(false);
  });
  it('tallies per UTC day and does not count duplicate event delivery', () => {
    const tracker = getSelfWakeupTracker(); const event = request(Date.now());
    tracker.observe('session', event); tracker.observe('session', event);
    expect(tracker.tally('2026-10-10')).toBe(1);
    vi.advanceTimersByTime(24 * 60 * 60_000); tracker.observe('session', request(Date.now(), 'second'));
    expect(tracker.tally('2026-10-11')).toBe(1);
    expect(log.info).toHaveBeenCalledTimes(2);
  });
  it('termination reports a pending wakeup only once', () => {
    const tracker = getSelfWakeupTracker(); tracker.observe('session', request(Date.now()));
    expect(tracker.endSession('session')?.content).toBe('This session ended while Claude had a wake-up pending; it will not happen.');
    expect(tracker.endSession('session')).toBeNull();
  });
  it('never keeps or logs a prompt carried by an oversized transport object', () => {
    const tracker = getSelfWakeupTracker();
    tracker.observe('session', { ...request(Date.now()), prompt: 'PRIVATE_PROMPT_PLACEHOLDER' } as unknown as ClaudeSelfWakeupEvent);
    expect(JSON.stringify([...(tracker as unknown as { pending: Map<string, unknown> }).pending.values()])).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
  });
});


describe('refused wakeup outcome', () => {
  afterEach(() => SelfWakeupTracker._resetForTesting());
  it('clears only the matching refused request, preserving a newer one', () => {
    const tracker = getSelfWakeupTracker(); const now = Date.now();
    tracker.observe('session', request(now, 'first'));
    tracker.observe('session', { kind: 'refused', toolUseId: 'first', requestedAt: now });
    expect(tracker.hasPending('session')).toBe(false);
    tracker.observe('session', request(now, 'second'));
    tracker.observe('session', { kind: 'refused', toolUseId: 'old', requestedAt: now });
    expect(tracker.hasPending('session')).toBe(true);
  });
});
