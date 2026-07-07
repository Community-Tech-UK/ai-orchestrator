import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  RemoteConfigDiscoverGitPayloadSchema,
  RemoteConfigFetchGitHubPayloadSchema,
  RemoteConfigFetchUrlPayloadSchema,
  RemoteConfigFetchWellKnownPayloadSchema,
  RemoteConfigInvalidatePayloadSchema,
} from '@contracts/schemas/settings';
import { validateIpcPayload } from '@contracts/schemas/common';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getRemoteConfigManager } from '../../core/config/remote-config';
import { WindowManager } from '../../window-manager';

interface SettingsRemoteConfigHandlerDeps {
  windowManager: WindowManager;
}

const RemoteConfigSourcePayloadSchema = z.object({
  source: z.object({
    type: z.enum(['url', 'file', 'git']),
    location: z.string().trim().min(1).max(2000),
    refreshInterval: z.number().int().min(0).optional(),
    branch: z.string().trim().max(100).optional(),
  }),
});

const RemoteConfigFetchPayloadSchema = z.object({
  force: z.boolean().optional(),
}).optional();

const RemoteConfigGetPayloadSchema = z.object({
  key: z.string().max(500),
  defaultValue: z.unknown().optional(),
});

export function registerSettingsRemoteConfigHandlers(
  deps: SettingsRemoteConfigHandlerDeps,
): void {
  const remoteConfigManager = getRemoteConfigManager();

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH',
        );
        const result = await remoteConfigManager.fetchConfigured(Boolean(validated?.force));
        if (!result.config) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_FETCH_FAILED',
              message: result.error ?? 'No remote config returned',
              timestamp: Date.now(),
            },
          };
        }
        deps.windowManager.sendToRenderer('remote-config:updated', result.config);
        return { success: true, data: result };
      } catch (error) {
        deps.windowManager.sendToRenderer('remote-config:error', {
          message: (error as Error).message,
        });
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigGetPayloadSchema,
          payload,
          'REMOTE_CONFIG_GET',
        );
        return {
          success: true,
          data: remoteConfigManager.getValue(validated.key, validated.defaultValue),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_SET_SOURCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigSourcePayloadSchema,
          payload,
          'REMOTE_CONFIG_SET_SOURCE',
        );
        remoteConfigManager.configureSource(validated.source);
        return { success: true, data: { source: validated.source } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_SET_SOURCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: remoteConfigManager.getStatus() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_URL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchUrlPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_URL',
        );
        const config = await remoteConfigManager.fetchFromUrl(validated.url, {
          timeout: validated.timeout,
          cacheTTL: validated.cacheTTL,
          maxRetries: validated.maxRetries,
          useCache: validated.useCache,
        });
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_URL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_WELL_KNOWN,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchWellKnownPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_WELL_KNOWN',
        );
        const config = await remoteConfigManager.fetchFromWellKnown(
          validated.domain,
          {
            timeout: validated.timeout,
            cacheTTL: validated.cacheTTL,
          },
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_WELL_KNOWN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_FETCH_GITHUB,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigFetchGitHubPayloadSchema,
          payload,
          'REMOTE_CONFIG_FETCH_GITHUB',
        );
        const config = await remoteConfigManager.fetchFromGitHub(
          validated.owner,
          validated.repo,
          validated.branch,
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_FETCH_GITHUB_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_DISCOVER_GIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigDiscoverGitPayloadSchema,
          payload,
          'REMOTE_CONFIG_DISCOVER_GIT',
        );
        const config = await remoteConfigManager.discoverForGitRepo(
          validated.gitRemoteUrl,
        );
        return { success: true, data: config };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_DISCOVER_GIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_GET_CACHED,
    async (): Promise<IpcResponse> => {
      try {
        const cached = remoteConfigManager.getCachedConfigs();
        return { success: true, data: cached };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_GET_CACHED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_CLEAR_CACHE,
    async (): Promise<IpcResponse> => {
      try {
        remoteConfigManager.clearCache();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_CLEAR_CACHE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_CONFIG_INVALIDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RemoteConfigInvalidatePayloadSchema,
          payload,
          'REMOTE_CONFIG_INVALIDATE',
        );
        remoteConfigManager.invalidateCache(validated.url);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REMOTE_CONFIG_INVALIDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
