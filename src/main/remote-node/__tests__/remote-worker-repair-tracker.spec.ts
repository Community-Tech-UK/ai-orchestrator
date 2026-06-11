import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkerRepairTracker } from '../remote-worker-repair-tracker';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('RemoteWorkerRepairTracker', () => {
  let tracker: RemoteWorkerRepairTracker;

  beforeEach(() => {
    tracker = new RemoteWorkerRepairTracker();
  });

  it('records sanitized rejections, accepted platform hints, and increments counts', () => {
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platformHint: 'win32',
      reason: 'Invalid token abcdef0123456789abcdef0123456789',
      now: 100,
    });
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platformHint: 'freebsd',
      reason: 'Invalid token abcdef0123456789abcdef0123456789',
      now: 150,
    });

    expect(tracker.get('node-1', 150)).toEqual({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platformHint: 'win32',
      reason: 'Invalid token [redacted]',
      firstSeenAt: 100,
      lastSeenAt: 150,
      count: 2,
    });
  });

  it('sanitizes unauthenticated node names before storing rejection context', () => {
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      nodeName: `  Windows token=abcdef0123456789abcdef0123456789 ${'x'.repeat(160)}  `,
      reason: 'Invalid or expired pairing token',
      now: 100,
    });

    const rejection = tracker.get('node-1', 100);

    expect(rejection?.nodeName).toMatch(/^Windows token= \[redacted\] x+$/);
    expect(rejection?.nodeName).not.toContain('abcdef0123456789abcdef0123456789');
    expect(rejection?.nodeName).toHaveLength(120);
  });

  it('expires old entries and clears repaired nodes', () => {
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: 100,
    });

    expect(tracker.get('node-1', 100 + 24 * 60 * 60 * 1000 - 1)).toBeTruthy();
    expect(tracker.get('node-1', 100 + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();

    tracker.recordRejectedRegistration({ nodeId: 'node-1', reason: 'again', now: 200 });
    tracker.clear('node-1');
    expect(tracker.get('node-1', 200)).toBeUndefined();
  });

  it('caps retained entries and drops oldest entries first', () => {
    for (let i = 0; i < 205; i++) {
      tracker.recordRejectedRegistration({
        nodeId: `node-${i}`,
        reason: 'Invalid or expired pairing token',
        now: i,
      });
    }

    expect(tracker.getAll(205)).toHaveLength(200);
    expect(tracker.get('node-0', 205)).toBeUndefined();
    expect(tracker.get('node-204', 205)).toBeTruthy();
  });
});
