import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  RepoJobListOptions,
  RepoJobRecord,
  RepoJobStats,
  RepoJobSubmission,
} from '../../../../../shared/types/repo-job.types';

@Injectable({ providedIn: 'root' })
export class RepoJobIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async submitJob(submission: RepoJobSubmission): Promise<IpcResponse<RepoJobRecord>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobSubmit(
      submission as Required<Pick<RepoJobSubmission, 'type' | 'workingDirectory'>> & RepoJobSubmission,
    ) as Promise<IpcResponse<RepoJobRecord>>;
  }

  async listJobs(options?: RepoJobListOptions): Promise<IpcResponse<RepoJobRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobList(options) as Promise<IpcResponse<RepoJobRecord[]>>;
  }

  async getJob(jobId: string): Promise<IpcResponse<RepoJobRecord | null>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobGet(jobId) as Promise<IpcResponse<RepoJobRecord | null>>;
  }

  async cancelJob(jobId: string): Promise<IpcResponse<{ cancelled: boolean; job: RepoJobRecord | null }>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobCancel(jobId) as Promise<IpcResponse<{ cancelled: boolean; job: RepoJobRecord | null }>>;
  }

  async rerunJob(jobId: string): Promise<IpcResponse<RepoJobRecord>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobRerun(jobId) as Promise<IpcResponse<RepoJobRecord>>;
  }

  async getStats(): Promise<IpcResponse<RepoJobStats>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.repoJobGetStats() as Promise<IpcResponse<RepoJobStats>>;
  }
}
