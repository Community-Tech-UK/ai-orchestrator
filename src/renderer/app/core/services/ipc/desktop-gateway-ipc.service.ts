import { Injectable, inject } from '@angular/core';
import type {
  DesktopAppDescriptor,
  DesktopAuditEntry,
  DesktopGatewayResult,
  DesktopGrantSummary,
  DesktopHealthData,
  DesktopApplicationRelaunchResult,
  DesktopPermissionActionResult,
  DesktopPermissionRepairResult,
  DesktopSystemPermission,
} from '../../../../../shared/types/desktop-gateway.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export type DesktopGatewayIpcResponse<T = unknown> = IpcResponse<DesktopGatewayResult<T>>;

/**
 * Renderer bridge to the Harness Computer Use (desktop gateway) diagnostics and
 * management IPC surface. Mirrors {@link BrowserGatewayIpcService}: thin
 * wrappers over the preload domain that normalize the "not in Electron" case.
 */
@Injectable({ providedIn: 'root' })
export class DesktopGatewayIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async getHealth(): Promise<DesktopGatewayIpcResponse<DesktopHealthData>> {
    return this.call(() => this.api?.desktopGetHealth());
  }

  async listApps(): Promise<DesktopGatewayIpcResponse<{ apps: DesktopAppDescriptor[] }>> {
    return this.call(() => this.api?.desktopListApps());
  }

  async listGrants(payload: {
    appId?: string;
    includeExpired?: boolean;
    limit?: number;
  } = {}): Promise<DesktopGatewayIpcResponse<{ grants: DesktopGrantSummary[] }>> {
    return this.call(() => this.api?.desktopListGrants(payload));
  }

  async revokeGrant(payload: {
    grantId: string;
    reason?: string;
  }): Promise<DesktopGatewayIpcResponse<{ grantId: string; revoked: boolean }>> {
    return this.call(() => this.api?.desktopRevokeGrant(payload));
  }

  async getAuditLog(payload: {
    appId?: string;
    limit?: number;
  } = {}): Promise<DesktopGatewayIpcResponse<{ entries: DesktopAuditEntry[] }>> {
    return this.call(() => this.api?.desktopGetAuditLog(payload));
  }

  /**
   * Operator request-and-open flow: performs the real native permission
   * request in the main process, then opens the correct System Settings pane
   * (with root fallback) when the permission is still missing.
   */
  async requestSystemPermission(
    permission: DesktopSystemPermission,
  ): Promise<DesktopGatewayIpcResponse<DesktopPermissionActionResult>> {
    return this.call(() => this.api?.desktopRequestSystemPermission({ permission }));
  }

  async repairSystemPermissions(): Promise<IpcResponse<DesktopPermissionRepairResult>> {
    return this.callDirect(() => this.api?.desktopRepairSystemPermissions());
  }

  async relaunchApplication(): Promise<IpcResponse<DesktopApplicationRelaunchResult>> {
    return this.callDirect(() => this.api?.desktopRelaunchApplication());
  }

  private async call<T>(
    fn: () => Promise<IpcResponse> | undefined,
  ): Promise<DesktopGatewayIpcResponse<T>> {
    const response = await fn();
    return response
      ? response as DesktopGatewayIpcResponse<T>
      : { success: false, error: { message: 'Not in Electron' } };
  }

  private async callDirect<T>(
    fn: () => Promise<IpcResponse> | undefined,
  ): Promise<IpcResponse<T>> {
    const response = await fn();
    return response
      ? response as IpcResponse<T>
      : { success: false, error: { message: 'Not in Electron' } };
  }
}
