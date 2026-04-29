/**
 * Command IPC Handlers
 * Handles command management and plan mode functionality
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CommandCreatePayloadSchema,
  CommandDeletePayloadSchema,
  CommandExecutePayloadSchema,
  CommandListPayloadSchema,
  CommandResolvePayloadSchema,
  CommandUpdatePayloadSchema,
  UsageRecordPayloadSchema,
  UsageSnapshotPayloadSchema,
  WorkspaceIsGitRepoPayloadSchema,
} from '@contracts/schemas/command';
import {
  PlanModeApprovePayloadSchema,
  PlanModeEnterPayloadSchema,
  PlanModeExitPayloadSchema,
  PlanModeGetStatePayloadSchema,
  PlanModeUpdatePayloadSchema,
} from '@contracts/schemas/instance';
import { getCommandManager } from '../../commands/command-manager';
import { getCompactionCoordinator } from '../../context/compaction-coordinator';
import { isGitRepository } from '../../git/git-probe-service';
import { InstanceManager } from '../../instance/instance-manager';
import { getUsageTracker } from '../../usage/usage-tracker';
import { evaluateApplicability } from '../../../shared/utils/command-applicability';

export function registerCommandHandlers(
  instanceManager: InstanceManager
): void {
  const commands = getCommandManager();

  // ============================================
  // Command Handlers
  // ============================================

  // List all commands
  ipcMain.handle(
    IPC_CHANNELS.COMMAND_LIST,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandListPayloadSchema,
          payload ?? {},
          'COMMAND_LIST'
        );
        const allCommands = await commands.getAllCommandsSnapshot(validated.workingDirectory);
        return {
          success: true,
          data: allCommands
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.COMMAND_RESOLVE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandResolvePayloadSchema,
          payload,
          'COMMAND_RESOLVE'
        );
        const resolved = await commands.resolveCommand(validated.input, validated.workingDirectory);
        return { success: true, data: resolved };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_RESOLVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Execute command
  ipcMain.handle(
    IPC_CHANNELS.COMMAND_EXECUTE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandExecutePayloadSchema,
          payload,
          'COMMAND_EXECUTE'
        );
        const instance = instanceManager.getInstance(validated.instanceId);
        const workingDirectory = instance?.workingDirectory;
        const resolved = commands.executeCommand(
          validated.commandId,
          validated.args || [],
          workingDirectory,
        );
        const executed = await resolved;
        if (!executed) {
          const snapshot = await commands.getAllCommandsSnapshot(workingDirectory);
          return {
            success: false,
            error: {
              code: 'COMMAND_NOT_FOUND',
              message: `Command ${validated.commandId} not found`,
              timestamp: Date.now(),
              candidates: snapshot.commands.slice(0, 5).map((command) => command.name)
            } as never
          };
        }

        const gitStatus = validated.context?.isGitRepo ??
          (executed.command.applicability?.requiresGitRepo && workingDirectory
            ? await isGitRepository(workingDirectory)
            : undefined);
        const applicability = evaluateApplicability(executed.command, {
          provider: instance?.provider,
          instanceStatus: instance?.status,
          workingDirectory,
          isGitRepo: gitStatus,
          featureFlags: validated.context?.featureFlags,
        });
        if (!applicability.eligible) {
          return {
            success: false,
            error: {
              code: 'COMMAND_INELIGIBLE',
              message: applicability.reason || 'Command is not available in this context',
              timestamp: Date.now()
            }
          };
        }

        // Special handling for /compact command — route to compaction coordinator
        if (executed.execution.type === 'compact') {
          const result = await getCompactionCoordinator().compactInstance(validated.instanceId);
          if (result.success) {
            getUsageTracker().record('command', executed.command.id, workingDirectory);
          }
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'COMPACT_FAILED',
              message: result.error || 'Compaction failed',
              timestamp: Date.now()
            }
          };
        }

        if (executed.execution.type === 'ui') {
          getUsageTracker().record('command', executed.command.id, workingDirectory);
          return {
            success: true,
            data: executed
          };
        }

        // Send the resolved prompt to the instance
        await instanceManager.sendInput(
          validated.instanceId,
          executed.resolvedPrompt
        );
        getUsageTracker().record('command', executed.command.id, workingDirectory);

        return {
          success: true,
          data: executed
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_EXECUTE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.USAGE_RECORD,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(UsageRecordPayloadSchema, payload, 'USAGE_RECORD');
        const entry = getUsageTracker().record(
          validated.kind,
          validated.id,
          validated.context,
          validated.timestamp,
        );
        return { success: true, data: entry };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'USAGE_RECORD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.USAGE_SNAPSHOT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(UsageSnapshotPayloadSchema, payload ?? {}, 'USAGE_SNAPSHOT');
        return { success: true, data: getUsageTracker().snapshot(validated.kind) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'USAGE_SNAPSHOT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_IS_GIT_REPO,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkspaceIsGitRepoPayloadSchema,
          payload,
          'WORKSPACE_IS_GIT_REPO'
        );
        return {
          success: true,
          data: await isGitRepository(validated.workingDirectory),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKSPACE_IS_GIT_REPO_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create custom command
  ipcMain.handle(
    IPC_CHANNELS.COMMAND_CREATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandCreatePayloadSchema,
          payload,
          'COMMAND_CREATE'
        );
        const command = commands.createCommand(validated);
        return {
          success: true,
          data: command
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update custom command
  ipcMain.handle(
    IPC_CHANNELS.COMMAND_UPDATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandUpdatePayloadSchema,
          payload,
          'COMMAND_UPDATE'
        );
        const updated = commands.updateCommand(
          validated.commandId,
          validated.updates
        );
        if (!updated) {
          return {
            success: false,
            error: {
              code: 'COMMAND_NOT_FOUND',
              message: `Command ${validated.commandId} not found or is built-in`,
              timestamp: Date.now()
            }
          };
        }
        return {
          success: true,
          data: updated
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete custom command
  ipcMain.handle(
    IPC_CHANNELS.COMMAND_DELETE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CommandDeletePayloadSchema,
          payload,
          'COMMAND_DELETE'
        );
        const deleted = commands.deleteCommand(validated.commandId);
        return {
          success: deleted,
          error: deleted
            ? undefined
            : {
                code: 'COMMAND_NOT_FOUND',
                message: `Command ${validated.commandId} not found or is built-in`,
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMMAND_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Plan Mode Handlers
  // ============================================

  // Enter plan mode
  ipcMain.handle(
    IPC_CHANNELS.PLAN_MODE_ENTER,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanModeEnterPayloadSchema,
          payload,
          'PLAN_MODE_ENTER'
        );
        const instance = instanceManager.enterPlanMode(validated.instanceId);
        return {
          success: true,
          data: { planMode: instance.planMode }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLAN_MODE_ENTER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Exit plan mode
  ipcMain.handle(
    IPC_CHANNELS.PLAN_MODE_EXIT,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanModeExitPayloadSchema,
          payload,
          'PLAN_MODE_EXIT'
        );
        const instance = instanceManager.exitPlanMode(
          validated.instanceId,
          validated.force
        );
        return {
          success: true,
          data: { planMode: instance.planMode }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLAN_MODE_EXIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Approve plan
  ipcMain.handle(
    IPC_CHANNELS.PLAN_MODE_APPROVE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanModeApprovePayloadSchema,
          payload,
          'PLAN_MODE_APPROVE'
        );
        const instance = instanceManager.approvePlan(
          validated.instanceId,
          validated.planContent
        );
        return {
          success: true,
          data: { planMode: instance.planMode }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLAN_MODE_APPROVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update plan content
  ipcMain.handle(
    IPC_CHANNELS.PLAN_MODE_UPDATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanModeUpdatePayloadSchema,
          payload,
          'PLAN_MODE_UPDATE'
        );
        const instance = instanceManager.updatePlanContent(
          validated.instanceId,
          validated.planContent
        );
        return {
          success: true,
          data: { planMode: instance.planMode }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLAN_MODE_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get plan mode state
  ipcMain.handle(
    IPC_CHANNELS.PLAN_MODE_GET_STATE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          PlanModeGetStatePayloadSchema,
          payload,
          'PLAN_MODE_GET_STATE'
        );
        const state = instanceManager.getPlanModeState(validated.instanceId);
        return {
          success: true,
          data: state
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PLAN_MODE_GET_STATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
