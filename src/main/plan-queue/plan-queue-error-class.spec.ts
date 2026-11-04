import { describe, expect, it } from 'vitest';
import { isTransientQueueTurnFailure } from './plan-queue-error-class';

describe('isTransientQueueTurnFailure', () => {
  it.each([
    'transport closed',
    'provider returned 503',
    'adapter not spawned',
    // The wording workers really parked with in the queue's records.
    'Codex turn stalled: no notifications received for 900000ms',
    'Codex went silent for 900000ms during turn after 974 bytes of output',
    'Selected model is at capacity. Please try a different model.',
  ])('retries %s', (reason) => {
    expect(isTransientQueueTurnFailure(reason)).toBe(true);
  });

  it.each([
    'instance exited with code 1',
    'instance entered error',
    'Instance creation is paused by the resource governor (memory pressure).',
    'instance was removed',
    'Not signed in: run `claude login`',
    'authentication token expired',
    'unrecognized failure',
  ])('does not retry %s', (reason) => {
    expect(isTransientQueueTurnFailure(reason)).toBe(false);
  });
});
