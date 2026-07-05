/**
 * Model IPC Service - Model discovery and management
 */
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class ModelIpcService {
  private base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async listProviderModels(provider: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listModelsForProvider(provider);
  }

  async listCopilotModels(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listCopilotModels();
  }

  async discoverModels(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return wrapDataResponse(await this.api.modelDiscover());
  }

  async verifyModel(modelId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return wrapAvailabilityResponse(await this.api.modelVerify({ modelId }));
  }

  async setOverride(provider: string, modelId: string, config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.modelSetOverride({ provider, modelId, config });
  }

  async removeOverride(modelId: string, provider?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.modelRemoveOverride({ provider, modelId });
  }
}

function wrapDataResponse(result: unknown): IpcResponse {
  return isIpcResponse(result) ? result : { success: true, data: result };
}

function wrapAvailabilityResponse(result: unknown): IpcResponse<boolean> {
  if (isIpcResponse(result)) {
    return result as IpcResponse<boolean>;
  }
  if (typeof result === 'boolean') {
    return result
      ? { success: true, data: true }
      : { success: false, data: false, error: { message: 'Model is not available.' } };
  }
  return { success: false, error: { message: 'Invalid model verification response.' } };
}

function isIpcResponse(value: unknown): value is IpcResponse {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as { success?: unknown }).success === 'boolean',
  );
}
