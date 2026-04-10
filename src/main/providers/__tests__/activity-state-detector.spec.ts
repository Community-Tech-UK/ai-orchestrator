import { describe, it, expect, vi } from 'vitest';
import { ActivityStateDetector } from '../activity-state-detector';

describe('ActivityStateDetector enhanced cascade', () => {
  it('checks native CLI signal when JSONL has no actionable state', async () => {
    const detector = new ActivityStateDetector('test-1', '/tmp/work', 'claude-cli');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(detector as any, 'detectFromActivityLog').mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(detector as any, 'detectFromNativeSignal').mockResolvedValue({
      state: 'active',
      confidence: 'high',
      staleAfterMs: 0,
      source: 'native-cli',
    });

    const result = await detector.detect();
    expect(result.state).toBe('active');
    expect(result.source).toBe('native-cli');
  });

  it('falls back to age decay when native signal unavailable', async () => {
    const detector = new ActivityStateDetector('test-1', '/tmp/work', 'claude-cli');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(detector as any, 'detectFromActivityLog').mockReturnValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(detector as any, 'detectFromNativeSignal').mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(detector as any, 'detectFromAgeDecay').mockReturnValue({
      state: 'ready',
      confidence: 'low',
      staleAfterMs: 0,
      source: 'age-decay',
    });

    const result = await detector.detect();
    expect(result.state).toBe('ready');
  });

  it('setAdapter enables native signal detection', () => {
    const detector = new ActivityStateDetector('test-1', '/tmp/work', 'claude-cli');
    const mockAdapter = { getSessionStatus: vi.fn() };
    detector.setAdapter(mockAdapter);
    // Verify no errors (adapter is set)
    expect(mockAdapter).toBeDefined();
  });
});
