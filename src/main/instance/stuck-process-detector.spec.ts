import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { StuckProcessDetector } from './stuck-process-detector';

describe('StuckProcessDetector', () => {
  let detector: StuckProcessDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StuckProcessDetector();
  });

  afterEach(() => {
    detector.shutdown();
    vi.useRealTimers();
  });

  it('does not emit for idle instances', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    vi.advanceTimersByTime(600_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits suspect-stuck after soft timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(130_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('emits stuck after hard timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(250_000);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('uses longer timeouts for tool_executing state', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'tool_executing');
    vi.advanceTimersByTime(200_000);
    expect(softHandler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(110_000);
    expect(softHandler).toHaveBeenCalled();
  });

  it('recordOutput resets timer and clears warning', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    vi.advanceTimersByTime(100_000);
    detector.recordOutput('inst-1');
    vi.advanceTimersByTime(100_000);
    expect(softHandler).not.toHaveBeenCalled();
  });

  it('stopTracking removes instance from detection', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);
    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    detector.stopTracking('inst-1');
    vi.advanceTimersByTime(600_000);
    expect(handler).not.toHaveBeenCalled();
  });
});
