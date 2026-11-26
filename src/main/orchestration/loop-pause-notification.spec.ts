import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_PAUSE_NOTICE_INTERVAL_MS, flushDeferredLoopPauseNotices, isPauseNoticeSuppressedByFocus,
  loopPauseNotice, notifyLoopPaused, reportLoopViewFocus,
  _resetLoopPauseNotificationsForTesting, _setLoopPauseWindowFocusReaderForTesting,
} from './loop-pause-notification';
import { _resetLoopViewFocusForTesting, setLoopViewFocus } from './loop-view-focus';

const ports = vi.hoisted(() => ({ notify: vi.fn(), setting: vi.fn(), summary: vi.fn() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: ports.setting }) }));
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => ({ notify: ports.notify }) }));
vi.mock('./loop-store', () => ({ getLoopStoreService: () => ({ store: { getRunSummary: ports.summary } }) }));

const base = { loopRunId: 'pause-a', notifyEnabled: true, now: 1_000 } as const;

describe('loopPauseNotice', () => {
  it('names the goal and the reason in a quiet notice', () => {
    const notice = loopPauseNotice({ ...base, goal: 'Fix the flaky test', reason: 'A file is blocked', windowFocused: false });
    expect(notice).toMatchObject({ kind: 'loop-paused', title: 'Loop paused', urgency: 'normal' });
    expect(notice!.body).toContain('Fix the flaky test');
    expect(notice!.body).toContain('A file is blocked');
  });

  it('stays silent when notifications are off and throttles to one per loop per hour', () => {
    expect(loopPauseNotice({ ...base, notifyEnabled: false, windowFocused: false })).toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: false, lastNotifiedAt: 1_000 })).toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: false, now: 899 + LOOP_PAUSE_NOTICE_INTERVAL_MS, lastNotifiedAt: 900 })).toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: false, now: 1_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS, lastNotifiedAt: 1_000 })).not.toBeNull();
  });

  it('stays silent only while the window is focused on that loop (4a change 3)', () => {
    expect(isPauseNoticeSuppressedByFocus({ loopRunId: 'pause-a', windowFocused: true, focusedLoopRunId: 'pause-a' })).toBe(true);
    expect(loopPauseNotice({ ...base, windowFocused: true, focusedLoopRunId: 'pause-a' })).toBeNull();
    expect(loopPauseNotice({ ...base, goal: 'Fix the flaky test', reason: 'A file is blocked', windowFocused: true, focusedLoopRunId: 'pause-a' })).toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: false, focusedLoopRunId: 'pause-a' })).not.toBeNull();
  });

  it('reports a pause that is not on screen even while some other view is focused', () => {
    // Settings, another session or another loop's HUD: the pause is invisible.
    expect(loopPauseNotice({ ...base, windowFocused: true, focusedLoopRunId: null })).not.toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: true, focusedLoopRunId: 'other-loop' })).not.toBeNull();
    expect(loopPauseNotice({ ...base, windowFocused: true })).not.toBeNull();
  });

  it('falls back to a generic name and clips long text', () => {
    const notice = loopPauseNotice({ ...base, windowFocused: false, reason: 'x'.repeat(500) });
    expect(notice!.body.startsWith('A loop run paused:')).toBe(true);
    expect(notice!.body.length).toBeLessThan(200);
    expect(loopPauseNotice({ ...base, windowFocused: false })!.body).toBe('A loop run paused.');
  });
});

describe('notifyLoopPaused runtime retention', () => {
  beforeEach(() => {
    _resetLoopPauseNotificationsForTesting();
    _resetLoopViewFocusForTesting();
    vi.clearAllMocks();
    ports.notify.mockReset();
    ports.setting.mockReturnValue(true);
    ports.summary.mockReturnValue({ initialPrompt: 'Controlled loop goal', status: 'paused' });
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    _setLoopPauseWindowFocusReaderForTesting(() => false);
  });
  afterEach(() => vi.restoreAllMocks());

  // Observe the ordinary Map boundary once; production exposes no state getter.
  function observeThrottle(): Map<string, number> {
    const writes = vi.spyOn(Map.prototype, 'set');
    notifyLoopPaused('pause-churn-first', 'Blocked file');
    const index = writes.mock.calls.findIndex(([key]) => key === 'pause-churn-first');
    const throttle = writes.mock.contexts[index] as Map<string, number>;
    writes.mockRestore();
    expect(throttle).toBeInstanceOf(Map);
    return throttle;
  }

  it('retires expired loop IDs lazily while delivering again at the hourly boundary', () => {
    const throttle = observeThrottle();
    for (let generation = 0; generation < 4; generation++) {
      vi.mocked(Date.now).mockReturnValue(10_000 + generation * LOOP_PAUSE_NOTICE_INTERVAL_MS);
      for (let index = 0; index < 100; index++) notifyLoopPaused(`pause-churn-${generation}-${index}`);
      expect(throttle.size).toBeLessThanOrEqual(101);
    }
    vi.mocked(Date.now).mockReturnValue(10_000 + 4 * LOOP_PAUSE_NOTICE_INTERVAL_MS);
    notifyLoopPaused('pause-churn-first');
    expect(throttle.size).toBe(1);
    expect(ports.notify.mock.calls.filter(([notice]) => notice.fingerprintFields.loopRunId === 'pause-churn-first')).toHaveLength(2);
  });

  it('bounds churn without evicting an active throttle or delivering untracked overflow notices', () => {
    const throttle = observeThrottle();
    for (let index = 0; index < 12_000; index++) notifyLoopPaused(`pause-churn-overflow-${index}`);
    expect(throttle.size).toBeLessThanOrEqual(4096);
    const delivered = ports.notify.mock.calls.length;
    expect(delivered).toBe(throttle.size);
    expect(delivered).toBeGreaterThan(1);
    expect(delivered).toBeLessThan(12_000);
    const lastLoop = ports.notify.mock.calls[delivered - 1][0].fingerprintFields.loopRunId;
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS - 1);
    notifyLoopPaused('pause-churn-first');
    notifyLoopPaused(lastLoop);
    notifyLoopPaused('pause-churn-new-overflow');
    expect(ports.notify).toHaveBeenCalledTimes(delivered);
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS);
    notifyLoopPaused('pause-churn-new-overflow');
    notifyLoopPaused('pause-churn-first');
    expect(ports.notify).toHaveBeenCalledTimes(delivered + 2);
    expect(throttle.size).toBe(2);
  });

  it('keeps the goal, normal urgency and fingerprint, with no duplicate before an hour', () => {
    notifyLoopPaused('pause-runtime-policy', 'Blocked file');
    expect(ports.notify).toHaveBeenCalledWith({ kind: 'loop-paused', title: 'Loop paused',
      body: '“Controlled loop goal” paused: Blocked file', urgency: 'normal',
      fingerprintFields: { loopRunId: 'pause-runtime-policy', cause: 'paused' } });
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS - 1);
    notifyLoopPaused('pause-runtime-policy', 'Another reason');
    expect(ports.notify).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS);
    notifyLoopPaused('pause-runtime-policy');
    expect(ports.notify).toHaveBeenCalledTimes(2);
  });

  it('reports immediately while an unrelated view is focused, with no deferral', () => {
    _setLoopPauseWindowFocusReaderForTesting(() => true);
    setLoopViewFocus('other-loop');
    notifyLoopPaused('pause-runtime-unrelated', 'Blocked file');
    expect(ports.notify).toHaveBeenCalledTimes(1);
    expect(ports.notify.mock.calls[0][0].body).toContain('Controlled loop goal');
    // Nothing was deferred: a later flush adds nothing.
    flushDeferredLoopPauseNotices();
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });

  it('defers a notice while the window is focused on that loop, then delivers on leaving it', () => {
    _setLoopPauseWindowFocusReaderForTesting(() => true);
    setLoopViewFocus('pause-runtime-focus');
    notifyLoopPaused('pause-runtime-focus', 'Blocked file');
    expect(ports.notify).not.toHaveBeenCalled();
    // Still on screen: the deferred notice waits, without consuming the throttle.
    flushDeferredLoopPauseNotices();
    expect(ports.notify).not.toHaveBeenCalled();
    // The operator moves to another view (or the window loses focus).
    setLoopViewFocus(null);
    flushDeferredLoopPauseNotices();
    expect(ports.notify).toHaveBeenCalledTimes(1);
    expect(ports.notify.mock.calls[0][0]).toMatchObject({
      body: '“Controlled loop goal” paused: Blocked file',
      fingerprintFields: { loopRunId: 'pause-runtime-focus', cause: 'paused' },
    });
    // One notice per pause: the delivered one does not repeat.
    flushDeferredLoopPauseNotices();
    expect(ports.notify).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS - 1);
    notifyLoopPaused('pause-runtime-focus', 'Blocked file');
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });

  it('routes the renderer view report into the deferred flush', () => {
    _setLoopPauseWindowFocusReaderForTesting(() => true);
    setLoopViewFocus('pause-runtime-view');
    notifyLoopPaused('pause-runtime-view', 'Blocked file');
    expect(ports.notify).not.toHaveBeenCalled();
    reportLoopViewFocus('some-other-surface');
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });

  it('drops a deferred notice once the run is no longer paused', () => {
    _setLoopPauseWindowFocusReaderForTesting(() => true);
    setLoopViewFocus('pause-runtime-resumed');
    notifyLoopPaused('pause-runtime-resumed', 'Blocked file');
    ports.summary.mockReturnValue({ initialPrompt: 'Controlled loop goal', status: 'running' });
    setLoopViewFocus(null);
    flushDeferredLoopPauseNotices();
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it('drops a deferred notice when the run is gone and delivers when its state is unreadable', () => {
    _setLoopPauseWindowFocusReaderForTesting(() => true);
    setLoopViewFocus('pause-runtime-gone');
    notifyLoopPaused('pause-runtime-gone', 'Blocked file');
    ports.summary.mockReturnValue(null);
    setLoopViewFocus(null);
    flushDeferredLoopPauseNotices();
    expect(ports.notify).not.toHaveBeenCalled();

    setLoopViewFocus('pause-runtime-unknown');
    notifyLoopPaused('pause-runtime-unknown', 'Blocked file');
    ports.summary.mockImplementation(() => { throw new Error('Synthetic store unavailable'); });
    setLoopViewFocus(null);
    flushDeferredLoopPauseNotices();
    expect(ports.notify).toHaveBeenCalledTimes(1);
    expect(ports.notify.mock.calls[0][0].body).toBe('A loop run paused: Blocked file');
  });

  it('expires older entries without clearing a newer loop’s active hourly throttle', () => {
    const throttle = observeThrottle();
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS / 2);
    notifyLoopPaused('pause-churn-newer');
    vi.mocked(Date.now).mockReturnValue(10_000 + LOOP_PAUSE_NOTICE_INTERVAL_MS);
    notifyLoopPaused('pause-churn-first');
    notifyLoopPaused('pause-churn-newer');
    expect(throttle.size).toBe(2);
    expect(ports.notify).toHaveBeenCalledTimes(3);
    expect(ports.notify.mock.calls.filter(([notice]) => notice.fingerprintFields.loopRunId === 'pause-churn-newer')).toHaveLength(1);
  });

  it('does not reserve a slot when disabled and tolerates missing goals and delivery failures', () => {
    ports.setting.mockReturnValue(false);
    notifyLoopPaused('pause-runtime-disabled');
    expect(ports.notify).not.toHaveBeenCalled();
    ports.setting.mockReturnValue(true);
    ports.summary.mockImplementation(() => { throw new Error('Synthetic store unavailable'); });
    ports.notify.mockImplementation(() => { throw new Error('Synthetic desktop unavailable'); });
    expect(() => notifyLoopPaused('pause-runtime-disabled')).not.toThrow();
    expect(ports.notify.mock.calls[0][0].body).toBe('A loop run paused.');
    notifyLoopPaused('pause-runtime-disabled');
    expect(ports.notify).toHaveBeenCalledTimes(1);
  });
});
