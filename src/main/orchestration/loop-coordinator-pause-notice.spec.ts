import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./loop-pause-notification', () => ({
  LOOP_PAUSE_NOTICE_INTERVAL_MS: 3_600_000,
  loopPauseNotice: vi.fn(),
  notifyLoopPaused: vi.fn(),
  _resetLoopPauseNotificationsForTesting: vi.fn(),
}));

import { LoopCoordinator } from './loop-coordinator';
import { notifyLoopPaused } from './loop-pause-notification';

describe('LoopCoordinator pause notices', () => {
  beforeEach(() => {
    vi.mocked(notifyLoopPaused).mockClear();
  });

  it('calls notifyLoopPaused once for every pause emit, with the signal message preferred', () => {
    const coordinator = new LoopCoordinator();

    coordinator.emit('loop:paused-no-progress', { loopRunId: 'loop-a', signal: { message: 'No progress after 3 checks' } });
    expect(notifyLoopPaused).toHaveBeenLastCalledWith('loop-a', 'No progress after 3 checks');

    coordinator.emit('loop:paused-no-progress', { loopRunId: 'loop-a', reason: 'resource-governor' });
    expect(notifyLoopPaused).toHaveBeenLastCalledWith('loop-a', 'resource-governor');

    expect(notifyLoopPaused).toHaveBeenCalledTimes(2);
  });

  it('does not notify for other events or payloads without a loop id', () => {
    const coordinator = new LoopCoordinator();

    coordinator.emit('loop:state-changed', { loopRunId: 'loop-a', state: { status: 'paused' } });
    coordinator.emit('loop:paused-no-progress', { reason: 'no id' });

    expect(notifyLoopPaused).not.toHaveBeenCalled();
  });
});
