import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { PluginPackageSource } from '@contracts/schemas/plugin';

export function createRuntimePluginDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    runtimePluginsList: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_LIST),

    runtimePluginsValidate: (source: PluginPackageSource): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_VALIDATE, { source }),

    runtimePluginsInstall: (source: PluginPackageSource): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_INSTALL, { source }),

    runtimePluginsUpdate: (pluginId: string, source?: PluginPackageSource): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_UPDATE, { pluginId, source }),

    runtimePluginsPrune: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_PRUNE, {}),

    runtimePluginsUninstall: (pluginId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.RUNTIME_PLUGINS_UNINSTALL, { pluginId }),
  };
}
