import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  StreamDurabilityCoordinator,
  type StreamResumeSummary,
} from '../stream-durability-coordinator';

function makeCoordinator(resume?: (nodeId: string, cursors: unknown) => Promise<StreamResumeSummary>) {
  const sendAck = vi.fn();
  const sendResume = vi.fn(resume ?? (async () => ({ cursors: [] })));
  const emitGapMarker = vi.fn();
  const coordinator = new StreamDurabilityCoordinator({ sendAck, sendResume, emitGapMarker });
  return { coordinator, sendAck, sendResume, emitGapMarker };
}

describe('StreamDurabilityCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts legacy frames without durableSeq unconditionally', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.accept('n1', 'inst-1', undefined)).toBe(true);
    expect(coordinator.accept('n1', undefined, 5)).toBe(true);
  });

  it('advances the cursor and drops replay duplicates (seq ≤ cursor)', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.accept('n1', 'inst-1', 1)).toBe(true);
    expect(coordinator.accept('n1', 'inst-1', 2)).toBe(true);
    expect(coordinator.accept('n1', 'inst-1', 2)).toBe(false);
    expect(coordinator.accept('n1', 'inst-1', 1)).toBe(false);
    expect(coordinator.accept('n1', 'inst-1', 3)).toBe(true);
    // Cursors are per (node, instance).
    expect(coordinator.accept('n1', 'inst-2', 1)).toBe(true);
    expect(coordinator.accept('n2', 'inst-1', 1)).toBe(true);
  });

  it('acks the highest dirty cursors on the debounce timer', () => {
    const { coordinator, sendAck } = makeCoordinator();
    coordinator.accept('n1', 'inst-1', 1);
    coordinator.accept('n1', 'inst-1', 2);
    coordinator.accept('n1', 'inst-2', 7);
    expect(sendAck).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_100);
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendAck).toHaveBeenCalledWith('n1', expect.arrayContaining([
      { instanceId: 'inst-1', seq: 2 },
      { instanceId: 'inst-2', seq: 7 },
    ]));

    // Nothing new — no further acks.
    vi.advanceTimersByTime(5_000);
    expect(sendAck).toHaveBeenCalledTimes(1);
  });

  it('an epoch change resets cursors so a restarted worker is never deduped', () => {
    const { coordinator } = makeCoordinator();
    coordinator.noteNodeEpoch('n1', 111);
    coordinator.accept('n1', 'inst-1', 500);
    // Same epoch re-announced — cursors survive.
    coordinator.noteNodeEpoch('n1', 111);
    expect(coordinator.accept('n1', 'inst-1', 400)).toBe(false);
    // New worker process — fresh counters must flow.
    coordinator.noteNodeEpoch('n1', 222);
    expect(coordinator.accept('n1', 'inst-1', 1)).toBe(true);
  });

  it('resumeNode replays after cursors and surfaces gap markers', async () => {
    const { coordinator, sendResume, emitGapMarker } = makeCoordinator(async () => ({
      cursors: [
        { instanceId: 'inst-1', replayed: 3 },
        { instanceId: 'inst-2', replayed: 0, gapThroughSeq: 9 },
      ],
    }));
    coordinator.accept('n1', 'inst-1', 4);
    coordinator.accept('n1', 'inst-2', 2);

    coordinator.resumeNode('n1', 1);
    await vi.runAllTimersAsync();

    expect(sendResume).toHaveBeenCalledWith('n1', expect.arrayContaining([
      { instanceId: 'inst-1', afterSeq: 4 },
      { instanceId: 'inst-2', afterSeq: 2 },
    ]));
    expect(emitGapMarker).toHaveBeenCalledTimes(1);
    expect(emitGapMarker).toHaveBeenCalledWith('n1', 'inst-2', 9);
  });

  it('resumeNode is a no-op for legacy workers and nodes with no cursors', () => {
    const { coordinator, sendResume } = makeCoordinator();
    coordinator.accept('n1', 'inst-1', 4);
    coordinator.resumeNode('n1', undefined); // legacy — no capability
    coordinator.resumeNode('n2', 1); // durable but nothing tracked
    expect(sendResume).not.toHaveBeenCalled();
  });

  it('a failed resume RPC never throws (gap stays lost, matching legacy behavior)', async () => {
    const { coordinator } = makeCoordinator(async () => {
      throw new Error('node fell over again');
    });
    coordinator.accept('n1', 'inst-1', 4);
    expect(() => coordinator.resumeNode('n1', 1)).not.toThrow();
    await vi.runAllTimersAsync();
  });

  it('buildGapMarkerMessage produces a system transcript message', () => {
    const marker = StreamDurabilityCoordinator.buildGapMarkerMessage(42);
    expect(marker['type']).toBe('system');
    expect(String(marker['content'])).toContain('#42');
  });
});
