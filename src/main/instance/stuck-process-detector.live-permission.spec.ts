import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterHasPendingLiveAsk, StuckProcessDetector } from './stuck-process-detector';

describe('live permission watchdog suppression', () => {
  afterEach(() => vi.useRealTimers());
  it('recognizes only a running adapter with a pending broker', () => {
    expect(adapterHasPendingLiveAsk(undefined)).toBe(false);
    expect(adapterHasPendingLiveAsk({})).toBe(false);
    expect(adapterHasPendingLiveAsk({ isRunning: () => false, livePermissions: { hasPending: () => true } })).toBe(false);
    expect(adapterHasPendingLiveAsk({ isRunning: () => true, livePermissions: { hasPending: () => false } })).toBe(false);
    expect(adapterHasPendingLiveAsk({ isRunning: () => true, livePermissions: { hasPending: () => true } })).toBe(true);
  });
  it('also treats a tool call the hook deferred for a person as a pending ask', () => {
    // LT-823: a held deferred Bash card was flagged "may be stuck" at 20 minutes and its CLI killed at 40.
    const deferred = { toolName: 'Bash', toolUseId: 'toolu_1', sessionId: 's-1' };
    expect(adapterHasPendingLiveAsk({ isRunning: () => true, getDeferredToolUse: () => deferred })).toBe(true);
    expect(adapterHasPendingLiveAsk({ isRunning: () => true, getDeferredToolUse: () => null })).toBe(false);
    expect(adapterHasPendingLiveAsk({ isRunning: () => false, getDeferredToolUse: () => deferred })).toBe(false);
  });
  it('suppresses notices and restarts past 40 minutes, then starts a fresh silence clock', () => {
    vi.useFakeTimers();
    let pending = true;
    const adapter = { isRunning: () => true, livePermissions: { hasPending: () => pending } };
    const detector = new StuckProcessDetector({ isProcessAlive: () => true, hasExternalActivity: () => adapterHasPendingLiveAsk(adapter), getTimeoutMultiplier: () => 1 });
    const suspect = vi.fn(); const stuck = vi.fn();
    detector.on('process:suspect-stuck', suspect); detector.on('process:stuck', stuck);
    detector.startTracking('instance-placeholder'); detector.updateState('instance-placeholder', 'tool_executing');
    vi.advanceTimersByTime(45 * 60_000);
    expect(suspect).not.toHaveBeenCalled(); expect(stuck).not.toHaveBeenCalled();
    pending = false; vi.advanceTimersByTime(60_000);
    expect(suspect).not.toHaveBeenCalled(); expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40 * 60_000);
    expect(stuck).toHaveBeenCalledOnce();
    detector.shutdown();
  });
});
