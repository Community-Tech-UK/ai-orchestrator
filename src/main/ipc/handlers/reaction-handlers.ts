import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  validateIpcPayload,
  ReactionTrackInstancePayloadSchema,
  ReactionUntrackInstancePayloadSchema,
  ReactionGetStatePayloadSchema,
  ReactionUpdateConfigPayloadSchema,
} from '@contracts/schemas';
import { getReactionEngine } from '../../reactions';

export function registerReactionHandlers(): void {
  const engine = getReactionEngine();

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
    IPC_CHANNELS.REACTION_GET_STATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReactionGetStatePayloadSchema, payload, 'REACTION_GET_STATE');
        const state = engine.getTrackingState(validated.instanceId);
        if (!state) {
          return { success: true, data: null };
        }
        return {
          success: true,
          data: {
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
