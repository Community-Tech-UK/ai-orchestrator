/**
 * Verification IPC Handlers
 * Handles Git Worktree and Multi-Agent Verification
 * NOTE: Supervision handlers have been moved to supervision-handlers.ts
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { getWorktreeManager } from '../workspace/git/worktree-manager';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getAllPersonalities, getPersonalityDescription } from '../orchestration/personalities';
import type { MergeStrategy } from '../../shared/types/worktree.types';
import type { VerificationConfig, PersonalityType, SynthesisStrategy } from '../../shared/types/verification.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  WorktreeCreatePayloadSchema,
  WorktreeSessionPayloadSchema,
  WorktreeMergePayloadSchema,
  WorktreeAbandonPayloadSchema,
  WorktreeDetectConflictsPayloadSchema,
  VerifyStartPayloadSchema,
  VerifyGetResultPayloadSchema,
  VerifyCancelPayloadSchema,
  VerifyConfigurePayloadSchema,
} from '@contracts/schemas/orchestration';

export function registerVerificationHandlers(): void {
  // ============================================
  // Git Worktree Handlers
  // ============================================

  // Create a new worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeCreatePayloadSchema, payload, 'WORKTREE_CREATE');
        const options = {
          baseBranch: validated.baseBranch,
          ...validated.config,
        };
        const session = await getWorktreeManager().createWorktree(
          validated.instanceId,
          validated.taskDescription,
          options
        );
        return { success: true, data: session };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Complete a worktree session (mark as ready for merge)
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_COMPLETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeSessionPayloadSchema, payload, 'WORKTREE_COMPLETE');
        const session = await getWorktreeManager().completeWorktree(validated.sessionId);
        return { success: true, data: session };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_COMPLETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Preview merge for a worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_PREVIEW_MERGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeSessionPayloadSchema, payload, 'WORKTREE_PREVIEW_MERGE');
        const preview = await getWorktreeManager().previewMerge(validated.sessionId);
        return { success: true, data: preview };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_PREVIEW_MERGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Merge a worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_MERGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeMergePayloadSchema, payload, 'WORKTREE_MERGE');
        const options = {
          strategy: validated.strategy as MergeStrategy | undefined,
          commitMessage: validated.commitMessage,
        };
        const result = await getWorktreeManager().mergeWorktree(
          validated.sessionId,
          options
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_MERGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Cleanup a worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CLEANUP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeSessionPayloadSchema, payload, 'WORKTREE_CLEANUP');
        await getWorktreeManager().cleanupWorktree(validated.sessionId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_CLEANUP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Abandon a worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_ABANDON,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeAbandonPayloadSchema, payload, 'WORKTREE_ABANDON');
        const session = await getWorktreeManager().abandonWorktree(
          validated.sessionId,
          validated.reason
        );
        return { success: true, data: session };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_ABANDON_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get a worktree session
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_GET_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeSessionPayloadSchema, payload, 'WORKTREE_GET_SESSION');
        const session = getWorktreeManager().getSession(validated.sessionId);
        if (!session) {
          return {
            success: false,
            error: {
              code: 'WORKTREE_SESSION_NOT_FOUND',
              message: `Worktree session not found: ${validated.sessionId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: session };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_GET_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // List all worktree sessions
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_LIST_SESSIONS,
    async (): Promise<IpcResponse> => {
      try {
        const sessions = getWorktreeManager().listSessions();
        return { success: true, data: sessions };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_LIST_SESSIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Detect cross-worktree conflicts
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_DETECT_CONFLICTS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeDetectConflictsPayloadSchema, payload, 'WORKTREE_DETECT_CONFLICTS');
        // Get the first session to detect conflicts for
        const sessionId = validated.sessionIds[0];
        if (!sessionId) {
          return { success: true, data: [] };
        }

        const session = getWorktreeManager().getSession(sessionId);
        if (!session) {
          return {
            success: false,
            error: {
              code: 'WORKTREE_SESSION_NOT_FOUND',
              message: `Worktree session not found: ${sessionId}`,
              timestamp: Date.now(),
            },
          };
        }

        // Get the files changed in this session
        const conflicts = await getWorktreeManager().detectCrossWorktreeConflicts(
          sessionId,
          session.filesChanged || []
        );
        return { success: true, data: conflicts };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_DETECT_CONFLICTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Sync worktree with remote
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_SYNC,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorktreeSessionPayloadSchema, payload, 'WORKTREE_SYNC');
        await getWorktreeManager().syncWithRemote(validated.sessionId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKTREE_SYNC_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Multi-Agent Verification Handlers
  // ============================================

  // Start a verification
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VerifyStartPayloadSchema, payload, 'VERIFY_START');
        const config: Partial<VerificationConfig> = {};
        if (validated.config) {
          if (validated.config.minAgents) config.agentCount = validated.config.minAgents;
          if (validated.config.synthesisStrategy) {
            config.synthesisStrategy = validated.config.synthesisStrategy as SynthesisStrategy;
          }
          if (validated.config.personalities) {
            config.personalities = validated.config.personalities as PersonalityType[];
          }
          if (validated.config.confidenceThreshold) {
            config.confidenceThreshold = validated.config.confidenceThreshold;
          }
          if (validated.config.timeoutMs) config.timeout = validated.config.timeoutMs;
          if (validated.config.maxDebateRounds) {
            config.maxDebateRounds = validated.config.maxDebateRounds;
          }
        }

        const verificationId = await getMultiVerifyCoordinator().startVerification(
          validated.instanceId,
          validated.prompt,
          config,
          validated.context,
          validated.taskType
        );
        const result = { verificationId };
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get verification result
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_GET_RESULT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VerifyGetResultPayloadSchema, payload, 'VERIFY_GET_RESULT');
        const result = getMultiVerifyCoordinator().getResult(validated.verificationId);
        if (!result) {
          return {
            success: false,
            error: {
              code: 'VERIFY_RESULT_NOT_FOUND',
              message: `Verification result not found: ${validated.verificationId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_GET_RESULT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get active verifications
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_GET_ACTIVE,
    async (): Promise<IpcResponse> => {
      try {
        const active = getMultiVerifyCoordinator().getActiveVerifications();
        return { success: true, data: active };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_GET_ACTIVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Cancel a verification
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VerifyCancelPayloadSchema, payload, 'VERIFY_CANCEL');
        getMultiVerifyCoordinator().cancelVerification(validated.verificationId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get available personalities
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_GET_PERSONALITIES,
    async (): Promise<IpcResponse> => {
      try {
        const personalities = getAllPersonalities().map((p) => ({
          type: p,
          description: getPersonalityDescription(p),
        }));
        return { success: true, data: personalities };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_GET_PERSONALITIES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Configure verification defaults
  ipcMain.handle(
    IPC_CHANNELS.VERIFY_CONFIGURE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VerifyConfigurePayloadSchema, payload, 'VERIFY_CONFIGURE');
        const config: Partial<VerificationConfig> = {};
        if (validated.config.minAgents) config.agentCount = validated.config.minAgents;
        if (validated.config.synthesisStrategy) {
          config.synthesisStrategy = validated.config.synthesisStrategy as SynthesisStrategy;
        }
        if (validated.config.confidenceThreshold) {
          config.confidenceThreshold = validated.config.confidenceThreshold;
        }
        if (validated.config.timeoutMs) config.timeout = validated.config.timeoutMs;

        getMultiVerifyCoordinator().setDefaultConfig(config);
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_CONFIGURE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // NOTE: Supervision handlers have been moved to supervision-handlers.ts
  // to avoid duplicate registration
}
