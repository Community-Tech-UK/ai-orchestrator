import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'node:path';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  RuntimePluginInstallPayloadSchema,
  RuntimePluginPrunePayloadSchema,
  RuntimePluginUninstallPayloadSchema,
  RuntimePluginUpdatePayloadSchema,
  RuntimePluginValidatePayloadSchema,
} from '@contracts/schemas/plugin';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { PluginPackageManager } from '../../plugins/plugin-package-manager';
import type { RuntimePluginPackage } from '../../plugins/plugin-install-store';
import type { PluginPackageSource } from '../../plugins/plugin-source-resolver';

interface RegisterRuntimePluginHandlersDeps {
  packageManager?: PluginPackageManager;
}

function responseError(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

export function registerRuntimePluginHandlers(
  deps: RegisterRuntimePluginHandlersDeps = {},
): void {
  const packageManager = deps.packageManager ?? new PluginPackageManager();

  ipcMain.handle(IPC_CHANNELS.RUNTIME_PLUGINS_LIST, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: (await packageManager.list()).map(toRuntimePluginPackageDto) };
    } catch (error) {
      return responseError('RUNTIME_PLUGINS_LIST_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_PLUGINS_VALIDATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RuntimePluginValidatePayloadSchema,
          payload,
          'RUNTIME_PLUGINS_VALIDATE',
        );
        return { success: true, data: await packageManager.validate(validated.source) };
      } catch (error) {
        return responseError('RUNTIME_PLUGINS_VALIDATE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_PLUGINS_INSTALL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RuntimePluginInstallPayloadSchema,
          payload,
          'RUNTIME_PLUGINS_INSTALL',
        );
        return { success: true, data: toRuntimePluginPackageDto(await packageManager.install(validated.source)) };
      } catch (error) {
        return responseError('RUNTIME_PLUGINS_INSTALL_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_PLUGINS_UPDATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RuntimePluginUpdatePayloadSchema,
          payload,
          'RUNTIME_PLUGINS_UPDATE',
        );
        return {
          success: true,
          data: toRuntimePluginPackageDto(await packageManager.update(validated.pluginId, validated.source)),
        };
      } catch (error) {
        return responseError('RUNTIME_PLUGINS_UPDATE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_PLUGINS_PRUNE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RuntimePluginPrunePayloadSchema,
          payload ?? {},
          'RUNTIME_PLUGINS_PRUNE',
        );
        return { success: true, data: await packageManager.prune(validated) };
      } catch (error) {
        return responseError('RUNTIME_PLUGINS_PRUNE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNTIME_PLUGINS_UNINSTALL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          RuntimePluginUninstallPayloadSchema,
          payload,
          'RUNTIME_PLUGINS_UNINSTALL',
        );
        await packageManager.uninstall(validated.pluginId);
        return { success: true };
      } catch (error) {
        return responseError('RUNTIME_PLUGINS_UNINSTALL_FAILED', error);
      }
    },
  );
}

interface RuntimePluginPackageDto {
  id: string;
  name: string;
  version: string;
  status: RuntimePluginPackage['status'];
  source: RedactedPluginPackageSource;
  installPath: string;
  lastValidationResult: RuntimePluginPackage['lastValidationResult'];
  lastUpdatedAt: number;
}

type RedactedPluginPackageSource = Pick<PluginPackageSource, 'type'> & {
  value: string;
  checksum?: string;
  redacted: boolean;
};

function toRuntimePluginPackageDto(plugin: RuntimePluginPackage): RuntimePluginPackageDto {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    status: plugin.status,
    source: redactPluginPackageSource(plugin.source),
    installPath: `[managed]/${plugin.id}`,
    lastValidationResult: plugin.lastValidationResult,
    lastUpdatedAt: plugin.lastUpdatedAt,
  };
}

function redactPluginPackageSource(source: PluginPackageSource): RedactedPluginPackageSource {
  const value: { value: string; redacted: boolean } = source.type === 'url'
    ? redactUrl(source.value)
    : { value: path.basename(source.value), redacted: path.basename(source.value) !== source.value };
  return {
    type: source.type,
    value: value.value,
    ...(source.checksum ? { checksum: source.checksum } : {}),
    redacted: value.redacted || value.value !== source.value,
  };
}

function redactUrl(value: string): { value: string; redacted: boolean } {
  try {
    const url = new URL(value);
    let redacted = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      redacted = true;
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, 'REDACTED');
        redacted = true;
      }
    }
    return { value: url.toString(), redacted };
  } catch {
    return { value: '[redacted-url]', redacted: true };
  }
}

function isSensitiveQueryKey(key: string): boolean {
  return /(?:token|access[_-]?token|api[_-]?key|secret|signature|sig|auth|password|credential|session)/i.test(key);
}
