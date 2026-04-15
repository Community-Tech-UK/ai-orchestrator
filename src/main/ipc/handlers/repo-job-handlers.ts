import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  RepoJobSubmitPayloadSchema,
  RepoJobListPayloadSchema,
  RepoJobGetPayloadSchema,
  RepoJobCancelPayloadSchema,
  RepoJobRerunPayloadSchema,
} from '@contracts/schemas';
import type { InstanceManager } from '../../instance/instance-manager';
import { getRepoJobService } from '../../repo-jobs';

export function registerRepoJobHandlers(instanceManager: InstanceManager): void {
  const repoJobService = getRepoJobService();
  repoJobService.initialize({ instanceManager });

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_SUBMIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RepoJobSubmitPayloadSchema, payload, 'REPO_JOB_SUBMIT');
        return {
          success: true,
          data: repoJobService.submitJob(validated),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_SUBMIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RepoJobListPayloadSchema, payload, 'REPO_JOB_LIST');
        return {
          success: true,
          data: repoJobService.listJobs(validated || undefined),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RepoJobGetPayloadSchema, payload, 'REPO_JOB_GET');
        return {
          success: true,
          data: repoJobService.getJob(validated.jobId) || null,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RepoJobCancelPayloadSchema, payload, 'REPO_JOB_CANCEL');
        return {
          success: true,
          data: {
            cancelled: repoJobService.cancelJob(validated.jobId),
            job: repoJobService.getJob(validated.jobId) || null,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_RERUN,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(RepoJobRerunPayloadSchema, payload, 'REPO_JOB_RERUN');
        return {
          success: true,
          data: repoJobService.rerunJob(validated.jobId),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_RERUN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REPO_JOB_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: repoJobService.getStats(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REPO_JOB_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
