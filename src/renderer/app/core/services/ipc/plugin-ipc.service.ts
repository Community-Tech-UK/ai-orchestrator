/**
 * Plugin IPC Service - Runtime plugin packages and project plugin trust
 */
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { PluginPackageSource } from '@contracts/schemas/plugin';
import type { RuntimeProviderSendPayload } from '@contracts/schemas/plugin';
import type { RuntimeProviderList, RuntimeProviderReply } from '../../../../../shared/types/runtime-provider-session.types';

@Injectable({ providedIn: 'root' })
export class PluginIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // Runtime Plugin Package Operations
  // ============================================

  async runtimeProviderList(workingDirectory: string): Promise<IpcResponse<RuntimeProviderList>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimeProviderList(workingDirectory);
  }

  async runtimeProviderSend(payload: RuntimeProviderSendPayload): Promise<IpcResponse<RuntimeProviderReply>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimeProviderSend(payload);
  }

  async runtimePluginsList(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsList();
  }

  async runtimePluginsValidate(source: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsValidate(source);
  }

  async runtimePluginsInstall(source: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsInstall(source);
  }

  async runtimePluginsUpdate(pluginId: string, source?: PluginPackageSource): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsUpdate(pluginId, source);
  }

  async runtimePluginsPrune(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsPrune();
  }

  async runtimePluginsUninstall(pluginId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.runtimePluginsUninstall(pluginId);
  }

  // ============================================
  // Project Plugin Trust Operations
  // ============================================

  async projectPluginTrustQuery(workingDirectory: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectPluginTrustQuery(workingDirectory);
  }

  async projectPluginTrustGrant(projectRoot: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectPluginTrustGrant(projectRoot);
  }

  async projectPluginTrustRevoke(projectRoot: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectPluginTrustRevoke(projectRoot);
  }
}
