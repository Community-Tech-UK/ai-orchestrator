import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { getSettingsManager } from '../../core/config/settings-manager';
import {
  ReactionGetStatePayloadSchema,
  ReactionSetArmedPayloadSchema,
  ReactionSetAutoMergePayloadSchema,
  ReactionTrackInstancePayloadSchema,
  ReactionUntrackInstancePayloadSchema,
  ReactionUpdateConfigPayloadSchema,
} from '@contracts/schemas/orchestration';
import { getReactionEngine } from '../../reactions';
import type { WindowManager } from '../../window-manager';

export function registerReactionHandlers(deps: { windowManager: WindowManager }): void {
  const engine = getReactionEngine();

  // Forward reaction engine events to the renderer so the UI can show firings.
  engine.on('reaction:event', (data: unknown) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.REACTION_EVENT, data);
  });
  engine.on('reaction:escalated', (data: unknown) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.REACTION_ESCALATED, data);
  });

  ipcMain.handle(
    IPC_CHANNELS.REACTION_GET_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: engine.getConfig() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_GET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_UPDATE_CONFIG,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionUpdateConfigPayloadSchema, payload, 'REACTION_UPDATE_CONFIG');
        engine.updateConfig(validated);
        // Persist the master switch and poll interval to settings so they survive restart.
        const sm = getSettingsManager();
        if (typeof validated.enabled === 'boolean') sm.set('reactionsEnabled', validated.enabled);
        if (typeof validated.pollIntervalMs === 'number') sm.set('reactionsPollIntervalMs', validated.pollIntervalMs);
        return { success: true, data: engine.getConfig() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_UPDATE_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_TRACK_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionTrackInstancePayloadSchema, payload, 'REACTION_TRACK_INSTANCE');
        engine.trackInstance(validated.instanceId, validated.prUrl);
        return { success: true, data: engine.getTrackingState(validated.instanceId) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_TRACK_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_UNTRACK_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionUntrackInstancePayloadSchema, payload, 'REACTION_UNTRACK_INSTANCE');
        engine.untrackInstance(validated.instanceId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_UNTRACK_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_GET_TRACKED,
    async (): Promise<IpcResponse> => {
      try {
        const tracked = engine.getTrackedInstances().map((state) => ({
          instanceId: state.instanceId,
          prUrl: state.prUrl,
          lastCIStatus: state.lastCIStatus,
          lastReviewDecision: state.lastReviewDecision,
          startedAt: state.startedAt,
          lastPolledAt: state.lastPolledAt,
        }));
        return { success: true, data: tracked };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_GET_TRACKED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_SET_ARMED,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionSetArmedPayloadSchema, payload, 'REACTION_SET_ARMED');
        engine.setArmed(validated.instanceId, validated.armed);
        return { success: true, data: { instanceId: validated.instanceId, armed: validated.armed } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_SET_ARMED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_SET_AUTO_MERGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionSetAutoMergePayloadSchema, payload, 'REACTION_SET_AUTO_MERGE');
        engine.setAutoMergeAllowed(validated.instanceId, validated.allowed);
        // Read back the effective state — setAutoMergeAllowed is a no-op when the
        // instance is not armed, so the returned value reflects reality.
        return {
          success: true,
          data: { instanceId: validated.instanceId, allowed: engine.isAutoMergeAllowed(validated.instanceId) },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_SET_AUTO_MERGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REACTION_GET_STATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionGetStatePayloadSchema, payload, 'REACTION_GET_STATE');
        const armed = engine.isArmed(validated.instanceId);
        const autoMergeAllowed = engine.isAutoMergeAllowed(validated.instanceId);
        const state = engine.getTrackingState(validated.instanceId);
        if (!state) {
          return { success: true, data: { armed, autoMergeAllowed } };
        }
        return {
          success: true,
          data: {
            armed,
            autoMergeAllowed,
            instanceId: state.instanceId,
            prUrl: state.prUrl,
            lastCIStatus: state.lastCIStatus,
            lastReviewDecision: state.lastReviewDecision,
            prData: state.prData,
            startedAt: state.startedAt,
            lastPolledAt: state.lastPolledAt,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REACTION_GET_STATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
