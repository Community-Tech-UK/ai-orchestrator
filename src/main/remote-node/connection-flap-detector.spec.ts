import { describe, expect, it } from 'vitest';
import { ConnectionFlapDetector } from './connection-flap-detector';

describe('ConnectionFlapDetector', () => {
  const WINDOW = 60_000;
  const THRESHOLD = 5;

  it('does not signal a storm below the threshold', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    let now = 0;
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const result = detector.record('node-1', now);
      expect(result.stormStarted).toBe(false);
      expect(result.active).toBe(false);
      now += 1_000;
    }
  });

  it('signals exactly once on the rising edge of a storm', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    let now = 0;
    const starts: boolean[] = [];
    for (let i = 0; i < THRESHOLD + 5; i++) {
      starts.push(detector.record('node-1', now).stormStarted);
      now += 1_000;
    }
    // Only the record that crosses the threshold should report stormStarted.
    expect(starts.filter(Boolean)).toHaveLength(1);
    expect(starts[THRESHOLD - 1]).toBe(true);
  });

  it('drops events outside the sliding window', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    // Four events far apart — always outside the window from each other.
    let now = 0;
    for (let i = 0; i < 10; i++) {
      const result = detector.record('node-1', now);
      expect(result.stormStarted).toBe(false);
      expect(result.countInWindow).toBe(1);
      now += WINDOW + 1; // each event evicts the previous
    }
  });

  it('re-arms and can signal a second storm after the window empties', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    let now = 0;
    // First storm.
    for (let i = 0; i < THRESHOLD; i++) {
      detector.record('node-1', now);
      now += 1_000;
    }
    // Let the window fully empty.
    now += WINDOW + 1;
    // Second storm.
    const starts: boolean[] = [];
    for (let i = 0; i < THRESHOLD; i++) {
      starts.push(detector.record('node-1', now).stormStarted);
      now += 1_000;
    }
    expect(starts.filter(Boolean)).toHaveLength(1);
  });

  it('tracks nodes independently', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    let now = 0;
    for (let i = 0; i < THRESHOLD; i++) {
      detector.record('node-1', now);
      now += 100;
    }
    // node-2 has only one event — no storm.
    expect(detector.record('node-2', now).active).toBe(false);
  });

  it('reset forgets a node so it can storm again immediately', () => {
    const detector = new ConnectionFlapDetector(WINDOW, THRESHOLD);
    let now = 0;
    for (let i = 0; i < THRESHOLD; i++) {
      detector.record('node-1', now);
      now += 100;
    }
    detector.reset('node-1');
    const starts: boolean[] = [];
    for (let i = 0; i < THRESHOLD; i++) {
      starts.push(detector.record('node-1', now).stormStarted);
      now += 100;
    }
    expect(starts.filter(Boolean)).toHaveLength(1);
  });
});
