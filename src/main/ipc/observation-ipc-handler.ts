/**
 * Observation IPC Handlers
 * Handles observation memory system IPC channels
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getObservationStore } from '../observation/observation-store';
import { getObservationIngestor } from '../observation/observation-ingestor';
import { getReflectorAgent } from '../observation/reflector-agent';
import type { ObservationConfig } from '../../shared/types/observation.types';

/**
 * Register all observation-related IPC handlers
 */
export function registerObservationHandlers(): void {
  // Get stats
  ipcMain.handle(IPC_CHANNELS.OBSERVATION_GET_STATS, () => {
    try {
      const stats = getObservationStore().getStats();
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get reflections
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_REFLECTIONS,
    (_event, payload?: { minConfidence?: number; limit?: number }) => {
      try {
        const store = getObservationStore();
        const reflections = store.getReflections({
          minConfidence: payload?.minConfidence,
          limit: payload?.limit,
        });
        return { success: true, data: reflections };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get observations
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_GET_OBSERVATIONS,
    (_event, payload?: { since?: number; limit?: number }) => {
      try {
        const store = getObservationStore();
        const observations = store.getObservations({
          since: payload?.since,
          limit: payload?.limit,
        });
        return { success: true, data: observations };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Configure
  ipcMain.handle(
    IPC_CHANNELS.OBSERVATION_CONFIGURE,
    (_event, config: Partial<ObservationConfig>) => {
      try {
        getObservationStore().configure(config);
        getObservationIngestor().configure(config);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get config
  ipcMain.handle(IPC_CHANNELS.OBSERVATION_GET_CONFIG, () => {
    try {
      const config = getObservationStore().getConfig();
      return { success: true, data: config };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Force reflect
  ipcMain.handle(IPC_CHANNELS.OBSERVATION_FORCE_REFLECT, () => {
    try {
      getObservationIngestor().forceFlush();
      getReflectorAgent().forceReflect();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Cleanup (expire old data)
  ipcMain.handle(IPC_CHANNELS.OBSERVATION_CLEANUP, () => {
    try {
      const result = getObservationStore().applyDecay();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
