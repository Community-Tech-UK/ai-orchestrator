/**
 * Task IPC Service - Task/subagent management operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  TaskPreflightReport,
  TaskPreflightRequest,
} from '../../../../../shared/types/task-preflight.types';

@Injectable({ providedIn: 'root' })
export class TaskIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // Task Management (Subagent Spawning)
  // ============================================

  /**
   * Get task status by ID
   */
  async taskGetStatus(taskId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetStatus(taskId);
  }

  /**
   * Get task history
   */
  async taskGetHistory(parentId?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetHistory(parentId);
  }

  /**
   * Get tasks by parent instance
   */
  async taskGetByParent(parentId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetByParent(parentId);
  }

  /**
   * Get task by child instance
   */
  async taskGetByChild(childId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetByChild(childId);
  }

  /**
   * Cancel a task
   */
  async taskCancel(taskId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskCancel(taskId);
  }

  /**
   * Get task queue stats
   */
  async taskGetQueue(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetQueue();
  }

  async taskGetPreflight(
    request: TaskPreflightRequest,
  ): Promise<IpcResponse<TaskPreflightReport>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.taskGetPreflight(request) as Promise<IpcResponse<TaskPreflightReport>>;
  }
}
