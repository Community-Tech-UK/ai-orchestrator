/**
 * Specialist IPC Handlers
 * Handles specialist profiles, instances, and recommendations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  SpecialistGetPayloadSchema,
  SpecialistGetByCategoryPayloadSchema,
  SpecialistAddCustomPayloadSchema,
  SpecialistUpdateCustomPayloadSchema,
  SpecialistRemoveCustomPayloadSchema,
  SpecialistRecommendPayloadSchema,
  SpecialistCreateInstancePayloadSchema,
  SpecialistGetInstancePayloadSchema,
  SpecialistUpdateStatusPayloadSchema,
  SpecialistAddFindingPayloadSchema,
  SpecialistUpdateMetricsPayloadSchema,
  SpecialistGetPromptAdditionPayloadSchema,
} from '@contracts/schemas/orchestration';
import { getSpecialistRegistry } from '../agents/specialists/specialist-registry';
import type { SpecialistProfile, SpecialistStatus, SpecialistFinding, SpecialistCategory } from '../../shared/types/specialist.types';
import { applySpecialistConstraints } from '../../shared/utils/permission-mapper';

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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistGetPayloadSchema, payload, 'SPECIALIST_GET');
        const profile = getSpecialistRegistry().getProfile(validated.profileId);
        if (!profile) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Specialist profile not found: ${validated.profileId}`,
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistGetByCategoryPayloadSchema, payload, 'SPECIALIST_GET_BY_CATEGORY');
        const profiles = getSpecialistRegistry().getProfilesByCategory(validated.category);
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistAddCustomPayloadSchema, payload, 'SPECIALIST_ADD_CUSTOM');
        const profile: SpecialistProfile = {
          id: validated.profile.id,
          name: validated.profile.name,
          description: validated.profile.description,
          category: validated.profile.category as SpecialistCategory,
          icon: validated.profile.icon,
          color: validated.profile.color,
          systemPromptAddition: validated.profile.systemPromptAddition,
          restrictedTools: validated.profile.restrictedTools,
          defaultTools: [],
          suggestedCommands: [],
          relatedWorkflows: [],
          constraints: validated.profile.constraints ? {
            readOnlyMode: validated.profile.constraints.readOnlyMode,
            maxTokensPerResponse: validated.profile.constraints.maxTokens,
            requireApprovalFor: validated.profile.constraints.requireApprovalFor,
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistUpdateCustomPayloadSchema, payload, 'SPECIALIST_UPDATE_CUSTOM');
        const updates: Partial<SpecialistProfile> = {};

        if (validated.updates.name) updates.name = validated.updates.name;
        if (validated.updates.description) updates.description = validated.updates.description;
        if (validated.updates.category) updates.category = validated.updates.category as SpecialistCategory;
        if (validated.updates.icon) updates.icon = validated.updates.icon;
        if (validated.updates.color) updates.color = validated.updates.color;
        if (validated.updates.systemPromptAddition) updates.systemPromptAddition = validated.updates.systemPromptAddition;
        if (validated.updates.restrictedTools) updates.restrictedTools = validated.updates.restrictedTools;
        if (validated.updates.constraints) {
          updates.constraints = {
            readOnlyMode: validated.updates.constraints.readOnlyMode,
            maxTokensPerResponse: validated.updates.constraints.maxTokens,
            requireApprovalFor: validated.updates.constraints.requireApprovalFor,
          };
        }

        const profile = getSpecialistRegistry().updateCustomProfile(validated.profileId, updates);
        if (!profile) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Custom specialist profile not found: ${validated.profileId}`,
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistRemoveCustomPayloadSchema, payload, 'SPECIALIST_REMOVE_CUSTOM');
        const removed = getSpecialistRegistry().removeCustomProfile(validated.profileId);
        if (!removed) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_NOT_FOUND',
              message: `Custom specialist profile not found: ${validated.profileId}`,
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistRecommendPayloadSchema, payload, 'SPECIALIST_RECOMMEND');
        const recommendations = getSpecialistRegistry().recommendSpecialists(validated.context);
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistCreateInstancePayloadSchema, payload, 'SPECIALIST_CREATE_INSTANCE');
        const instance = getSpecialistRegistry().createInstance(
          validated.profileId,
          validated.orchestratorInstanceId
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistGetInstancePayloadSchema, payload, 'SPECIALIST_GET_INSTANCE');
        const instance = getSpecialistRegistry().getInstance(validated.instanceId);
        if (!instance) {
          return {
            success: false,
            error: {
              code: 'SPECIALIST_INSTANCE_NOT_FOUND',
              message: `Specialist instance not found: ${validated.instanceId}`,
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistUpdateStatusPayloadSchema, payload, 'SPECIALIST_UPDATE_STATUS');
        getSpecialistRegistry().updateInstanceStatus(
          validated.instanceId,
          validated.status as SpecialistStatus
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistAddFindingPayloadSchema, payload, 'SPECIALIST_ADD_FINDING');
        const finding: SpecialistFinding = {
          id: validated.finding.id,
          type: validated.finding.type as SpecialistFinding['type'],
          severity: validated.finding.severity,
          title: validated.finding.title,
          description: validated.finding.description,
          file: validated.finding.filePath,
          line: validated.finding.lineRange?.start,
          endLine: validated.finding.lineRange?.end,
          codeSnippet: validated.finding.codeSnippet,
          suggestion: validated.finding.suggestion,
          confidence: validated.finding.confidence,
          tags: validated.finding.tags || [],
          timestamp: Date.now(),
        };

        getSpecialistRegistry().addFinding(validated.instanceId, finding);
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistUpdateMetricsPayloadSchema, payload, 'SPECIALIST_UPDATE_METRICS');
        getSpecialistRegistry().updateMetrics(validated.instanceId, validated.updates);
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
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SpecialistGetPromptAdditionPayloadSchema, payload, 'SPECIALIST_GET_PROMPT_ADDITION');
        const prompt = getSpecialistRegistry().getSystemPromptAddition(validated.profileId);
        const profile = getSpecialistRegistry().getProfile(validated.profileId);
        const permissionOverrides = profile?.constraints
          ? applySpecialistConstraints(
              { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' },
              profile.constraints
            )
          : undefined;
        return { success: true, data: { prompt, permissionOverrides } };
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
