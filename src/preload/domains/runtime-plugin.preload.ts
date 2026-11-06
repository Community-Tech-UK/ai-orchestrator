import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { PluginPackageSource } from '@contracts/schemas/plugin';
import type { RuntimeProviderSendPayload } from '@contracts/schemas/plugin';
import type { RuntimeProviderList, RuntimeProviderReply } from '../../shared/types/runtime-provider-session.types';

export function createRuntimePluginDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    runtimeProviderList: (workingDirectory: string): Promise<IpcResponse<RuntimeProviderList>> =>
      ipcRenderer.invoke(ch.RUNTIME_PROVIDER_LIST, { workingDirectory }),
    runtimeProviderSend: (payload: RuntimeProviderSendPayload): Promise<IpcResponse<RuntimeProviderReply>> =>
      ipcRenderer.invoke(ch.RUNTIME_PROVIDER_SEND, payload),
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

    projectPluginTrustQuery: (workingDirectory: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROJECT_PLUGIN_TRUST_QUERY, { workingDirectory }),

    projectPluginTrustGrant: (projectRoot: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROJECT_PLUGIN_TRUST_GRANT, { projectRoot }),

    projectPluginTrustRevoke: (projectRoot: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROJECT_PLUGIN_TRUST_REVOKE, { projectRoot }),
  };
}
