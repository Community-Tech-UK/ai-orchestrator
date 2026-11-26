import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindInboxChangeForwarding } from './inbox-change-forwarding';
import { _resetForTesting, runCleanupFunctions } from '../util/cleanup-registry';

describe('inbox forwarding shutdown', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    _resetForTesting();
  });

  it('drops queued trailing pushes and detaches both inbox and observer delivery on cleanup', async () => {
    const proposals = new EventEmitter();
    const jobs = new EventEmitter();
    const delivered: unknown[] = [];
    const observed: unknown[] = [];
    bindInboxChangeForwarding(proposals, jobs,
      (channel, event) => delivered.push({ channel, event }), job => observed.push(job));
    proposals.emit('proposal:created');
    jobs.emit('repo-job:submitted', { id: 'EXAMPLE_JOB' });
    proposals.emit('proposal:decided');
    jobs.emit('repo-job:completed', { id: 'EXAMPLE_JOB' });
    expect(delivered).toHaveLength(2);
    expect(observed).toHaveLength(2);

    await runCleanupFunctions();
    vi.advanceTimersByTime(2000);
    proposals.emit('proposal:created');
    jobs.emit('repo-job:submitted', { id: 'EXAMPLE_JOB_AFTER_CLEANUP' });
    expect(delivered).toHaveLength(2);
    expect(observed).toHaveLength(2);
  });
});
