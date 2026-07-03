import { describe, expect, it } from 'vitest';
import {
  RECONNECT_CONFIG,
  nextReconnectDelayMs,
  shouldResetReconnectAttempt,
} from './reconnect-backoff';

describe('shouldResetReconnectAttempt', () => {
  const stable = RECONNECT_CONFIG.stableConnectionResetMs;

  it('does not reset when there was never a stable connection (connectedAt=0)', () => {
    expect(shouldResetReconnectAttempt(0, 999_999)).toBe(false);
  });

  it('does not reset when the connection dropped before the stable threshold', () => {
    const connectedAt = 1_000;
    // Dropped just under the stable window after registering.
    const now = connectedAt + stable - 1;
    expect(shouldResetReconnectAttempt(connectedAt, now)).toBe(false);
  });

  it('does not reset exactly at the threshold (strictly greater required)', () => {
    const connectedAt = 1_000;
    expect(shouldResetReconnectAttempt(connectedAt, connectedAt + stable)).toBe(false);
  });

  it('resets only after >= stable uptime elapsed', () => {
    const connectedAt = 1_000;
    expect(shouldResetReconnectAttempt(connectedAt, connectedAt + stable + 1)).toBe(true);
  });
});

describe('nextReconnectDelayMs escalation', () => {
  // Inject a deterministic rng so no real Math.random() is used (repo convention).
  const maxJitter = () => 0.999999; // pushes the delay to the top of its band
  const noJitter = () => 0; // pushes the delay to the bottom of its band (exp/2)

  it('escalates strictly (upper band) as the attempt increases, until maxMs', () => {
    let previous = -1;
    let reachedCap = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const delay = nextReconnectDelayMs(attempt, maxJitter);
      // Never exceeds the configured cap.
      expect(delay).toBeLessThanOrEqual(RECONNECT_CONFIG.maxMs);
      if (delay >= RECONNECT_CONFIG.maxMs - 1) {
        reachedCap = true;
      } else {
        // Before the cap, each attempt's (jittered-to-top) delay is larger.
        expect(delay).toBeGreaterThan(previous);
      }
      previous = delay;
    }
    expect(reachedCap).toBe(true);
  });

  it('lower band (exp/2) is monotonic non-decreasing and hits the cap floor', () => {
    const first = nextReconnectDelayMs(0, noJitter);
    const second = nextReconnectDelayMs(1, noJitter);
    expect(second).toBeGreaterThan(first);
    // Deep into the schedule the exponential is capped at maxMs → floor = maxMs/2.
    expect(nextReconnectDelayMs(30, noJitter)).toBe(Math.floor(RECONNECT_CONFIG.maxMs / 2));
  });

  it('first attempt starts from the initial interval, not zero', () => {
    // attempt 0, zero jitter → initialMs/2.
    expect(nextReconnectDelayMs(0, noJitter)).toBe(Math.floor(RECONNECT_CONFIG.initialMs / 2));
  });
});
