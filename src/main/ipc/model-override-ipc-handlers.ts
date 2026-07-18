import { app, ipcMain } from 'electron';
import {
  ModelRemoveOverridePayloadSchema,
  ModelSetOverridePayloadSchema,
} from '@contracts/schemas/provider';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getCatalogOverrideSource } from '../providers/catalog-override-source';
import type { ModelDiscoveryHandlerDeps } from './model-discovery-ipc-handlers';
import { validatedHandler } from './validated-handler';

export function registerModelOverrideHandlers(deps: ModelDiscoveryHandlerDeps = {}): void {
  ipcMain.handle(
    IPC_CHANNELS.MODEL_SET_OVERRIDE,
    validatedHandler(
      IPC_CHANNELS.MODEL_SET_OVERRIDE,
      ModelSetOverridePayloadSchema,
      async (payload) => {
      const source = getCatalogOverrideSource();
      await source.ensureLocalStarted(app.getPath('userData'));
      const entry = await source.setLocalOverrideModel(
          payload.provider,
          payload.modelId,
          payload.config ?? {},
      );
        return { success: true, data: entry };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: 'MODEL_SET_OVERRIDE_FAILED',
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.MODEL_REMOVE_OVERRIDE,
    validatedHandler(
      IPC_CHANNELS.MODEL_REMOVE_OVERRIDE,
      ModelRemoveOverridePayloadSchema,
      async (payload) => {
      const source = getCatalogOverrideSource();
      await source.ensureLocalStarted(app.getPath('userData'));
      const removed = await source.removeLocalOverrideModel(
          payload.provider,
          payload.modelId,
      );
        return { success: true, data: { removed } };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: 'MODEL_REMOVE_OVERRIDE_FAILED',
      },
    ),
  );
}
