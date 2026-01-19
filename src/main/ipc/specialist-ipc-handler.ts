/**
 * Specialist IPC Handlers
 * Handles specialist profiles, instances, and recommendations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import type {
  SpecialistGetPayload,
  SpecialistGetByCategoryPayload,
  SpecialistAddCustomPayload,
  SpecialistUpdateCustomPayload,
  SpecialistRemoveCustomPayload,
  SpecialistRecommendPayload,
  SpecialistCreateInstancePayload,
  SpecialistGetInstancePayload,
  SpecialistUpdateStatusPayload,
  SpecialistAddFindingPayload,
  SpecialistUpdateMetricsPayload,
  SpecialistGetPromptAdditionPayload,
} from '../../shared/types/ipc.types';
import { getSpecialistRegistry } from '../agents/specialists/specialist-registry';
import type { SpecialistProfile, SpecialistStatus, SpecialistFinding, SpecialistCategory } from '../../shared/types/specialist.types';

export function registerSpecialistHandlers(): void {
  // ============================================
  // Profile Management Handlers
  // ============================================

  // List all specialist profiles
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const profiles = getSpecialistRegistry().getAllProfiles();
        return { success: true, data: profiles };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // List built-in specialist profiles
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_LIST_BUILTIN,
    async (): Promise<IpcResponse> => {
      try {
        const profiles = getSpecialistRegistry().getBuiltInProfiles();
        return { success: true, data: profiles };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_LIST_BUILTIN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // List custom specialist profiles
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_LIST_CUSTOM,
    async (): Promise<IpcResponse> => {
      try {
        const profiles = getSpecialistRegistry().getCustomProfiles();
        return { success: true, data: profiles };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_LIST_CUSTOM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get a single specialist profile
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistGetPayload
    ): Promise<IpcResponse> => {
      try {
        const profile = getSpecialistRegistry().getProfile(payload.profileId);
        if (!profile) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Specialist profile not found: ${payload.profileId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: profile };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get specialist profiles by category
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_BY_CATEGORY,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistGetByCategoryPayload
    ): Promise<IpcResponse> => {
      try {
        const profiles = getSpecialistRegistry().getProfilesByCategory(payload.category);
        return { success: true, data: profiles };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_GET_BY_CATEGORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Custom Profile Management Handlers
  // ============================================

  // Add a custom specialist profile
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_ADD_CUSTOM,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistAddCustomPayload
    ): Promise<IpcResponse> => {
      try {
        const profile: SpecialistProfile = {
          id: payload.profile.id,
          name: payload.profile.name,
          description: payload.profile.description,
          category: payload.profile.category as SpecialistCategory,
          icon: payload.profile.icon,
          color: payload.profile.color,
          systemPromptAddition: payload.profile.systemPromptAddition,
          restrictedTools: payload.profile.restrictedTools,
          defaultTools: [],
          suggestedCommands: [],
          relatedWorkflows: [],
          constraints: payload.profile.constraints ? {
            readOnlyMode: payload.profile.constraints.readOnlyMode,
            maxTokensPerResponse: payload.profile.constraints.maxTokens,
            requireApprovalFor: payload.profile.constraints.requireApprovalFor,
          } : undefined,
        };

        getSpecialistRegistry().addCustomProfile(profile);
        return { success: true, data: profile };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_ADD_CUSTOM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Update a custom specialist profile
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UPDATE_CUSTOM,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistUpdateCustomPayload
    ): Promise<IpcResponse> => {
      try {
        const updates: Partial<SpecialistProfile> = {};

        if (payload.updates.name) updates.name = payload.updates.name;
        if (payload.updates.description) updates.description = payload.updates.description;
        if (payload.updates.category) updates.category = payload.updates.category as SpecialistCategory;
        if (payload.updates.icon) updates.icon = payload.updates.icon;
        if (payload.updates.color) updates.color = payload.updates.color;
        if (payload.updates.systemPromptAddition) updates.systemPromptAddition = payload.updates.systemPromptAddition;
        if (payload.updates.restrictedTools) updates.restrictedTools = payload.updates.restrictedTools;
        if (payload.updates.constraints) {
          updates.constraints = {
            readOnlyMode: payload.updates.constraints.readOnlyMode,
            maxTokensPerResponse: payload.updates.constraints.maxTokens,
            requireApprovalFor: payload.updates.constraints.requireApprovalFor,
          };
        }

        const profile = getSpecialistRegistry().updateCustomProfile(payload.profileId, updates);
        if (!profile) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Custom specialist profile not found: ${payload.profileId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: profile };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_UPDATE_CUSTOM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Remove a custom specialist profile
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_REMOVE_CUSTOM,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistRemoveCustomPayload
    ): Promise<IpcResponse> => {
      try {
        const removed = getSpecialistRegistry().removeCustomProfile(payload.profileId);
        if (!removed) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Custom specialist profile not found: ${payload.profileId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_REMOVE_CUSTOM_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Recommendation Handler
  // ============================================

  // Get specialist recommendations based on context
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_RECOMMEND,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistRecommendPayload
    ): Promise<IpcResponse> => {
      try {
        const recommendations = getSpecialistRegistry().recommendSpecialists(payload.context);
        return { success: true, data: recommendations };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_RECOMMEND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Instance Management Handlers
  // ============================================

  // Create a specialist instance
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_CREATE_INSTANCE,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistCreateInstancePayload
    ): Promise<IpcResponse> => {
      try {
        const instance = getSpecialistRegistry().createInstance(
          payload.profileId,
          payload.orchestratorInstanceId
        );
        return { success: true, data: instance };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_CREATE_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get a specialist instance
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_INSTANCE,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistGetInstancePayload
    ): Promise<IpcResponse> => {
      try {
        const instance = getSpecialistRegistry().getInstance(payload.instanceId);
        if (!instance) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_INSTANCE_NOT_FOUND',
              message: `Specialist instance not found: ${payload.instanceId}`,
              timestamp: Date.now(),
            },
          };
        }
        return { success: true, data: instance };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_GET_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get all active specialist instances
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_ACTIVE_INSTANCES,
    async (): Promise<IpcResponse> => {
      try {
        const instances = getSpecialistRegistry().getActiveInstances();
        return { success: true, data: instances };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_GET_ACTIVE_INSTANCES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Update specialist instance status
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UPDATE_STATUS,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistUpdateStatusPayload
    ): Promise<IpcResponse> => {
      try {
        getSpecialistRegistry().updateInstanceStatus(
          payload.instanceId,
          payload.status as SpecialistStatus
        );
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_UPDATE_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Add a finding to a specialist instance
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_ADD_FINDING,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistAddFindingPayload
    ): Promise<IpcResponse> => {
      try {
        const finding: SpecialistFinding = {
          id: payload.finding.id,
          type: payload.finding.type as SpecialistFinding['type'],
          severity: payload.finding.severity,
          title: payload.finding.title,
          description: payload.finding.description,
          file: payload.finding.filePath,
          line: payload.finding.lineRange?.start,
          endLine: payload.finding.lineRange?.end,
          codeSnippet: payload.finding.codeSnippet,
          suggestion: payload.finding.suggestion,
          confidence: payload.finding.confidence,
          tags: payload.finding.tags || [],
          timestamp: Date.now(),
        };

        getSpecialistRegistry().addFinding(payload.instanceId, finding);
        return { success: true, data: finding };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_ADD_FINDING_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Update specialist instance metrics
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UPDATE_METRICS,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistUpdateMetricsPayload
    ): Promise<IpcResponse> => {
      try {
        getSpecialistRegistry().updateMetrics(payload.instanceId, payload.updates);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_UPDATE_METRICS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get system prompt addition for a specialist
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_PROMPT_ADDITION,
    async (
      event: IpcMainInvokeEvent,
      payload: SpecialistGetPromptAdditionPayload
    ): Promise<IpcResponse> => {
      try {
        const prompt = getSpecialistRegistry().getSystemPromptAddition(payload.profileId);
        return { success: true, data: prompt };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SPECIALIST_GET_PROMPT_ADDITION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );
}
