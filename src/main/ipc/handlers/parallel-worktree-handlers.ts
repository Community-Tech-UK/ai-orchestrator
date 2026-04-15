/**
 * Parallel Worktree IPC Handlers
 * Handles parallel worktree execution coordination via IPC
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  ParallelWorktreeStartPayloadSchema,
  ParallelWorktreeGetStatusPayloadSchema,
  ParallelWorktreeCancelPayloadSchema,
  ParallelWorktreeGetResultsPayloadSchema,
  ParallelWorktreeResolveConflictPayloadSchema,
  ParallelWorktreeMergePayloadSchema,
} from '@contracts/schemas';
import { getParallelWorktreeCoordinator } from '../../orchestration/parallel-worktree-coordinator';

export function registerParallelWorktreeHandlers(): void {
  // Start a new parallel worktree execution
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeStartPayloadSchema,
          payload,
          'PARALLEL_WORKTREE_START'
        );
        const coordinator = getParallelWorktreeCoordinator();
        const executionId = await coordinator.startParallelExecution(
          validated.tasks,
          validated.instanceId,
          validated.repoPath
        );
        return {
          success: true,
          data: { executionId }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get status of a parallel execution
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_GET_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeGetStatusPayloadSchema,
          payload,
          'PARALLEL_WORKTREE_GET_STATUS'
        );
        const coordinator = getParallelWorktreeCoordinator();
        const execution = coordinator.getExecution(validated.executionId);
        if (!execution) {
          return {
            success: false,
            error: {
              code: 'PARALLEL_WORKTREE_NOT_FOUND',
              message: `Execution ${validated.executionId} not found`,
              timestamp: Date.now()
            }
          };
        }
        return {
          success: true,
          data: {
            id: execution.id,
            status: execution.status,
            taskCount: execution.tasks.length,
            sessionCount: execution.sessions.size,
            conflicts: execution.conflicts,
            mergeOrder: execution.mergeOrder,
            startTime: execution.startTime,
            endTime: execution.endTime,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cancel a parallel execution
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeCancelPayloadSchema,
          payload,
          'PARALLEL_WORKTREE_CANCEL'
        );
        const coordinator = getParallelWorktreeCoordinator();
        await coordinator.cancelExecution(validated.executionId);
        return {
          success: true,
          data: { executionId: validated.executionId }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get results of a completed parallel execution
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_GET_RESULTS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeGetResultsPayloadSchema,
          payload,
          'PARALLEL_WORKTREE_GET_RESULTS'
        );
        const coordinator = getParallelWorktreeCoordinator();
        const execution = coordinator.getExecution(validated.executionId);
        if (!execution) {
          return {
            success: false,
            error: {
              code: 'PARALLEL_WORKTREE_NOT_FOUND',
              message: `Execution ${validated.executionId} not found`,
              timestamp: Date.now()
            }
          };
        }
        const taskSessions = execution.tasks.map(task => ({
          taskId: task.id,
          taskDescription: task.description,
          session: coordinator.getTaskSession(execution.id, task.id),
        }));
        return {
          success: true,
          data: {
            id: execution.id,
            status: execution.status,
            tasks: taskSessions,
            conflicts: execution.conflicts,
            mergeOrder: execution.mergeOrder,
            startTime: execution.startTime,
            endTime: execution.endTime,
            duration: execution.endTime
              ? execution.endTime - execution.startTime
              : undefined,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_GET_RESULTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List all active parallel executions
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const coordinator = getParallelWorktreeCoordinator();
        const executions = coordinator.getActiveExecutions();
        return {
          success: true,
          data: executions.map(e => ({
            id: e.id,
            status: e.status,
            taskCount: e.tasks.length,
            conflicts: e.conflicts,
            startTime: e.startTime,
          }))
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Resolve a conflict in a parallel execution
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_RESOLVE_CONFLICT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeResolveConflictPayloadSchema,
          payload,
          'PARALLEL_WORKTREE_RESOLVE_CONFLICT'
        );
        const coordinator = getParallelWorktreeCoordinator();
        await coordinator.resolveConflict(
          validated.executionId,
          validated.taskId,
          validated.resolution
        );
        const execution = coordinator.getExecution(validated.executionId);
        return {
          success: true,
          data: {
            executionId: validated.executionId,
            remainingConflicts: execution?.conflicts.length ?? 0,
            status: execution?.status,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_RESOLVE_CONFLICT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Trigger merge for a parallel execution (after conflicts are resolved or force merge)
  ipcMain.handle(
    IPC_CHANNELS.PARALLEL_WORKTREE_MERGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ParallelWorktreeMergePayloadSchema,
          payload,
          'PARALLEL_WORKTREE_MERGE'
        );
        const coordinator = getParallelWorktreeCoordinator();
        await coordinator.forceMerge(validated.executionId, validated.strategy);
        const execution = coordinator.getExecution(validated.executionId);
        return {
          success: true,
          data: {
            executionId: validated.executionId,
            status: execution?.status,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PARALLEL_WORKTREE_MERGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
