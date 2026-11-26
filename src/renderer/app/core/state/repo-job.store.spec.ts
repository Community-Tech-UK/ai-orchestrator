import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoJobRecord, RepoJobStats } from '../../../../shared/types/repo-job.types';
import { RepoJobIpcService } from '../services/ipc/repo-job-ipc.service';
import { RepoJobStore, ZERO_REPO_JOB_STATS } from './repo-job.store';

function makeJob(id: string): RepoJobRecord {
  return {
    id,
    taskId: `task-${id}`,
    name: `Job ${id}`,
    type: 'pr-review',
    status: 'queued',
    workingDirectory: '/repo',
    workflowTemplateId: 'wf-1',
    useWorktree: false,
    progress: 0,
    createdAt: 0,
    repoContext: { gitAvailable: true, isRepo: true, changedFiles: [] },
    submission: { type: 'pr-review', workingDirectory: '/repo' },
  };
}

function makeStats(overrides: Partial<RepoJobStats> = {}): RepoJobStats {
  return { ...ZERO_REPO_JOB_STATS, ...overrides };
}

describe('RepoJobStore', () => {
  let changed = () => { /* No listener until the store subscribes. */ };
  const unsubscribe = vi.fn();
  const ipc = {
    onChanged: vi.fn((callback: () => void) => { changed = callback; return unsubscribe; }),
    listJobs: vi.fn(),
    getStats: vi.fn(),
    cancelJob: vi.fn(),
    rerunJob: vi.fn(),
    submitJob: vi.fn(),
    getJob: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.listJobs.mockReset();
    ipc.getStats.mockReset();
    changed = () => { /* No listener until the store subscribes. */ };
    TestBed.configureTestingModule({
      providers: [
        RepoJobStore,
        { provide: RepoJobIpcService, useValue: ipc },
      ],
    });
  });

  it('refreshes jobs and stats on a push without toggling loading', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-new')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 1, queued: 1 }) });
    const store = TestBed.inject(RepoJobStore);
    changed();
    expect(store.loading()).toBe(false);
    await vi.waitFor(() => expect(store.jobs().map(job => job.id)).toEqual(['job-new']));
    expect(store.stats().queued).toBe(1);
    expect(ipc.listJobs).toHaveBeenCalledOnce();
    expect(ipc.getStats).toHaveBeenCalledOnce();
  });

  it('keeps a late poll from overwriting the pushed job list and stats', async () => {
    let resolvePoll!: (response: { success: true; data: RepoJobRecord[] }) => void;
    ipc.listJobs.mockReturnValueOnce(new Promise(resolve => { resolvePoll = resolve; }));
    ipc.listJobs.mockResolvedValueOnce({ success: true, data: [makeJob('job-new')] });
    ipc.getStats.mockResolvedValueOnce({ success: true, data: makeStats() });
    ipc.getStats.mockResolvedValueOnce({ success: true, data: makeStats({ total: 1, queued: 1 }) });
    const store = TestBed.inject(RepoJobStore);
    const poll = store.refresh(false);
    changed();
    await vi.waitFor(() => expect(store.stats().total).toBe(1));
    resolvePoll({ success: true, data: [] });
    await poll;
    expect(store.jobs().map(job => job.id)).toEqual(['job-new']);
    expect(store.stats().total).toBe(1);
  });

  it('unsubscribes from pushes when its Angular owner is destroyed', () => {
    TestBed.inject(RepoJobStore);
    TestBed.resetTestingModule();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('starts with empty jobs, zero stats, no loading, no error', () => {
    const store = TestBed.inject(RepoJobStore);

    expect(store.jobs()).toEqual([]);
    expect(store.stats()).toEqual(ZERO_REPO_JOB_STATS);
    expect(store.loading()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('refresh() fetches the job list and stats in parallel and publishes both', async () => {
    let resolveJobs!: (value: { success: true; data: RepoJobRecord[] }) => void;
    let resolveStats!: (value: { success: true; data: RepoJobStats }) => void;
    ipc.listJobs.mockReturnValue(new Promise((resolve) => { resolveJobs = resolve; }));
    ipc.getStats.mockReturnValue(new Promise((resolve) => { resolveStats = resolve; }));

    const store = TestBed.inject(RepoJobStore);
    const refreshPromise = store.refresh();

    // Both underlying IPC calls must already be in flight before either
    // resolves — proves refresh() dispatches them in parallel rather than
    // sequentially awaiting one before starting the other.
    expect(ipc.listJobs).toHaveBeenCalledTimes(1);
    expect(ipc.getStats).toHaveBeenCalledTimes(1);

    resolveJobs({ success: true, data: [makeJob('job-1')] });
    resolveStats({ success: true, data: makeStats({ queued: 1, total: 1 }) });
    const ok = await refreshPromise;

    expect(ok).toBe(true);
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(store.stats()).toEqual(makeStats({ queued: 1, total: 1 }));
    expect(store.loading()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('sets loading true while showLoading refresh is in flight, then false', async () => {
    let resolveJobs!: (value: { success: true; data: RepoJobRecord[] }) => void;
    ipc.listJobs.mockReturnValue(new Promise((resolve) => { resolveJobs = resolve; }));
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats() });

    const store = TestBed.inject(RepoJobStore);
    const refreshPromise = store.refresh(true);

    expect(store.loading()).toBe(true);
    resolveJobs({ success: true, data: [] });
    await refreshPromise;

    expect(store.loading()).toBe(false);
  });

  it('does not toggle loading when showLoading is false', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats() });

    const store = TestBed.inject(RepoJobStore);
    const refreshPromise = store.refresh(false);

    expect(store.loading()).toBe(false);
    await refreshPromise;
    expect(store.loading()).toBe(false);
  });

  it('preserves the succeeding source and records a source error when one response fails', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1')] });
    ipc.getStats.mockResolvedValue({ success: false, error: { message: 'stats unavailable' } });

    const store = TestBed.inject(RepoJobStore);
    const ok = await store.refresh();

    expect(ok).toBe(false);
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(store.stats()).toEqual(ZERO_REPO_JOB_STATS);
    expect(store.error()).toContain('stats unavailable');
  });

  it('preserves the succeeding source when the jobs response fails instead', async () => {
    ipc.listJobs.mockResolvedValue({ success: false, error: { message: 'jobs unavailable' } });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 2 }) });

    const store = TestBed.inject(RepoJobStore);
    const ok = await store.refresh();

    expect(ok).toBe(false);
    expect(store.jobs()).toEqual([]);
    expect(store.stats()).toEqual(makeStats({ total: 2 }));
    expect(store.error()).toContain('jobs unavailable');
  });

  it('preserves previous data when refresh throws', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 1 }) });
    const store = TestBed.inject(RepoJobStore);
    await store.refresh();

    ipc.listJobs.mockRejectedValueOnce(new Error('network down'));
    ipc.getStats.mockResolvedValueOnce({ success: true, data: makeStats({ total: 5 }) });

    const ok = await store.refresh();

    expect(ok).toBe(false);
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(store.stats()).toEqual(makeStats({ total: 1 }));
    expect(store.error()).toContain('network down');
  });

  it('cancel() delegates to IPC and refreshes after success', async () => {
    ipc.cancelJob.mockResolvedValue({ success: true, data: { cancelled: true, job: makeJob('job-1') } });
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ cancelled: 1, total: 1 }) });

    const store = TestBed.inject(RepoJobStore);
    const ok = await store.cancel('job-1');

    expect(ok).toBe(true);
    expect(ipc.cancelJob).toHaveBeenCalledWith('job-1');
    expect(ipc.listJobs).toHaveBeenCalled();
    expect(ipc.getStats).toHaveBeenCalled();
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(store.error()).toBeNull();
  });

  it('rerun() delegates to IPC and refreshes after success', async () => {
    ipc.rerunJob.mockResolvedValue({ success: true, data: makeJob('job-2') });
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1'), makeJob('job-2')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 2 }) });

    const store = TestBed.inject(RepoJobStore);
    const ok = await store.rerun('job-1');

    expect(ok).toBe(true);
    expect(ipc.rerunJob).toHaveBeenCalledWith('job-1');
    expect(ipc.listJobs).toHaveBeenCalled();
    expect(store.jobs()).toHaveLength(2);
  });

  it('cancel() returns false and leaves the current list intact on failure', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 1 }) });
    const store = TestBed.inject(RepoJobStore);
    await store.refresh();

    ipc.cancelJob.mockResolvedValue({ success: false, error: { message: 'cannot cancel' } });

    const ok = await store.cancel('job-1');

    expect(ok).toBe(false);
    expect(store.error()).toBe('cannot cancel');
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(ipc.listJobs).toHaveBeenCalledTimes(1);
  });

  it('rerun() returns false and leaves the current list intact when the IPC call throws', async () => {
    ipc.listJobs.mockResolvedValue({ success: true, data: [makeJob('job-1')] });
    ipc.getStats.mockResolvedValue({ success: true, data: makeStats({ total: 1 }) });
    const store = TestBed.inject(RepoJobStore);
    await store.refresh();

    ipc.rerunJob.mockRejectedValue(new Error('rerun exploded'));

    const ok = await store.rerun('job-1');

    expect(ok).toBe(false);
    expect(store.error()).toContain('rerun exploded');
    expect(store.jobs()).toEqual([makeJob('job-1')]);
    expect(ipc.listJobs).toHaveBeenCalledTimes(1);
  });
});
