import { Injectable, Signal, inject, signal } from '@angular/core';
import type { RepoJobRecord, RepoJobStats } from '../../../../shared/types/repo-job.types';
import { RepoJobIpcService } from '../services/ipc/repo-job-ipc.service';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';

/** Typed zero-value so consumers never repeat the anonymous stats shape. */
export const ZERO_REPO_JOB_STATS: RepoJobStats = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  total: 0,
};

/**
 * Root-injectable renderer state for repository background jobs. Extracted
 * from `TasksPageComponent` so both Background Jobs and the Workboard share
 * one list/stats/loading/error model backed by `RepoJobIpcService`.
 *
 * Polling stays page-owned: this store never starts its own interval or
 * performs an initial refresh in its constructor. Callers decide when and
 * how often to call `refresh()`.
 */
@Injectable({ providedIn: 'root' })
export class RepoJobStore {
  private readonly ipc = inject(RepoJobIpcService);

  private readonly _jobs = signal<readonly RepoJobRecord[]>([]);
  private readonly _stats = signal<RepoJobStats>(ZERO_REPO_JOB_STATS);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly jobs: Signal<readonly RepoJobRecord[]> = this._jobs.asReadonly();
  readonly stats: Signal<RepoJobStats> = this._stats.asReadonly();
  readonly loading: Signal<boolean> = this._loading.asReadonly();
  readonly error: Signal<string | null> = this._error.asReadonly();

  /**
   * Fetches the job list and stats in parallel and publishes both
   * successful results. A single failed response preserves the data from
   * the other response and records a source error; a thrown refresh (e.g.
   * a rejected IPC call) preserves all previously published data.
   *
   * Returns `true` only when both requests succeeded, so pages can decide
   * their own success/error presentation.
   */
  async refresh(showLoading = true): Promise<boolean> {
    if (showLoading) {
      this._loading.set(true);
    }

    try {
      const [jobsResponse, statsResponse] = await Promise.all([
        this.ipc.listJobs(),
        this.ipc.getStats(),
      ]);

      const errors: string[] = [];

      if (jobsResponse.success && Array.isArray(jobsResponse.data)) {
        this._jobs.set(jobsResponse.data);
      } else {
        errors.push(jobsResponse.error?.message ?? 'Failed to load background jobs.');
      }

      if (statsResponse.success && statsResponse.data) {
        this._stats.set(statsResponse.data);
      } else {
        errors.push(statsResponse.error?.message ?? 'Failed to load background job stats.');
      }

      this._error.set(errors.length > 0 ? errors.join(' ') : null);
      return errors.length === 0;
    } catch (error) {
      this._error.set((error as Error).message);
      return false;
    } finally {
      if (showLoading) {
        this._loading.set(false);
      }
    }
  }

  /**
   * Cancels a job via IPC and refreshes the list/stats after success. A
   * failed cancel returns `false` and leaves the current list intact.
   */
  async cancel(jobId: string): Promise<boolean> {
    const response = await this.invokeSafely(() => this.ipc.cancelJob(jobId));
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to cancel background job.');
      return false;
    }

    this._error.set(null);
    await this.refresh(false);
    return true;
  }

  /**
   * Reruns a job via IPC and refreshes the list/stats after success. A
   * failed rerun returns `false` and leaves the current list intact.
   */
  async rerun(jobId: string): Promise<boolean> {
    const response = await this.invokeSafely(() => this.ipc.rerunJob(jobId));
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to rerun background job.');
      return false;
    }

    this._error.set(null);
    await this.refresh(false);
    return true;
  }

  /** Runs an IPC call, converting a thrown rejection into a failed response. */
  private async invokeSafely<T>(call: () => Promise<IpcResponse<T>>): Promise<IpcResponse<T>> {
    try {
      return await call();
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }
}
