/**
 * Observation IPC Handlers
 * Handles observation memory system IPC channels
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getObservationStore } from '../observation/observation-store';
import { getObservationIngestor } from '../observation/observation-ingestor';
import { getReflectorAgent } from '../observation/reflector-agent';
import {
  ObservationConfigurePayloadSchema,
  ObservationGetReflectionsPayloadSchema,
  ObservationGetObservationsPayloadSchema,
} from '@contracts/schemas/session';
import { validatedHandler, type IpcResponse } from './validated-handler';

interface RegisterObservationHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

/**
 * Register all observation-related IPC handlers
 */
export function registerObservationHandlers(deps: RegisterObservationHandlersDeps = {}): void {
  const emptyPayloadSchema = z.undefined().optional();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  // Get stats
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_STATS,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_GET_STATS,
      emptyPayloadSchema,
      async () => ({ success: true, data: getObservationStore().getStats() }),
      options('OBSERVATION_GET_STATS_FAILED'),
    ),
  );

  // Get reflections
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_REFLECTIONS,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_GET_REFLECTIONS,
      ObservationGetReflectionsPayloadSchema,
      async (payload) => {
        const store = getObservationStore();
        const reflections = store.getReflections({
          minConfidence: payload?.minConfidence,
          limit: payload?.limit,
        });
        return { success: true, data: reflections };
      },
      options('OBSERVATION_GET_REFLECTIONS_FAILED'),
    ),
  );

  // Get observations
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_OBSERVATIONS,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_GET_OBSERVATIONS,
      ObservationGetObservationsPayloadSchema,
      async (payload) => {
        const store = getObservationStore();
        const observations = store.getObservations({
          since: payload?.since,
          limit: payload?.limit,
        });
        return { success: true, data: observations };
      },
      options('OBSERVATION_GET_OBSERVATIONS_FAILED'),
    ),
  );

  // Configure
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_CONFIGURE,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_CONFIGURE,
      ObservationConfigurePayloadSchema,
      async (payload) => {
        getObservationStore().configure(payload ?? {});
        getObservationIngestor().configure(payload ?? {});
        return { success: true };
      },
      options('OBSERVATION_CONFIGURE_FAILED'),
    ),
  );

  // Get config
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_CONFIG,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_GET_CONFIG,
      emptyPayloadSchema,
      async () => ({ success: true, data: getObservationStore().getConfig() }),
      options('OBSERVATION_GET_CONFIG_FAILED'),
    ),
  );

  // Force reflect
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_FORCE_REFLECT,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_FORCE_REFLECT,
      emptyPayloadSchema,
      async () => {
        getObservationIngestor().forceFlush();
        getReflectorAgent().forceReflect();
        return { success: true };
      },
      options('OBSERVATION_FORCE_REFLECT_FAILED'),
    ),
  );

  // Cleanup (expire old data)
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_CLEANUP,
    validatedHandler(
      IPC_CHANNELS.OBSERVATION_CLEANUP,
      emptyPayloadSchema,
      async () => ({ success: true, data: getObservationStore().applyDecay() }),
      options('OBSERVATION_CLEANUP_FAILED'),
    ),
  );
}
