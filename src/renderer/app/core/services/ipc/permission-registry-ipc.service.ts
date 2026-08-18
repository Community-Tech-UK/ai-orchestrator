import { Injectable, inject } from '@angular/core';
import type { PendingApprovalItem } from '../../../../../shared/types/permission-registry.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

/**
 * Renderer facade for the generic PermissionRegistry approval surface
 * (LT-095). Consumed by {@link PendingApprovalsBannerComponent} to make the
 * Computer Use desktop grant, App Store/Play release gate, and calendar
 * mutation approvals reachable from the renderer for the first time.
 */
@Injectable({ providedIn: 'root' })
export class PermissionRegistryIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async listPending(instanceId?: string): Promise<IpcResponse<PendingApprovalItem[]>> {
    return this.call(() => this.api?.permissionRegistryListPending(instanceId ? { instanceId } : {}));
  }

  async resolve(requestId: string, granted: boolean, reason?: string): Promise<IpcResponse<{ requestId: string; granted: boolean }>> {
    return this.call(() => this.api?.permissionRegistryResolve({ requestId, granted, reason }));
  }

  async extend(requestId: string, extraMs: number): Promise<IpcResponse<PendingApprovalItem>> {
    return this.call(() => this.api?.permissionRegistryExtend({ requestId, extraMs }));
  }

  private async call<T>(fn: () => Promise<IpcResponse> | undefined): Promise<IpcResponse<T>> {
    const response = await fn();
    return response ? (response as IpcResponse<T>) : this.notInElectron<T>();
  }

  private notInElectron<T>(): IpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
