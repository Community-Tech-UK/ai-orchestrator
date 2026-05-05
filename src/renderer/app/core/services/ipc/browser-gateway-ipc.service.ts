import { Injectable, inject } from '@angular/core';
import type {
  BrowserApprovalRequest,
  BrowserApprovalRequestLookup,
  BrowserApprovalStatusRequest,
  BrowserApproveRequestPayload,
  BrowserCreateProfileRequest,
  BrowserClickRequest,
  BrowserCreateGrantRequest,
  BrowserAuditEntry,
  BrowserDenyRequestPayload,
  BrowserFillFormRequest,
  BrowserGatewayResult,
  BrowserListApprovalRequestsRequest,
  BrowserListAuditLogRequest,
  BrowserListGrantsRequest,
  BrowserListTargetsRequest,
  BrowserManualStepRequest,
  BrowserNavigateRequest,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserProfileRequest,
  BrowserRequestGrantRequest,
  BrowserRequestUserLoginRequest,
  BrowserRevokeGrantRequest,
  BrowserScreenshotRequest,
  BrowserSelectRequest,
  BrowserTarget,
  BrowserTargetRequest,
  BrowserTypeRequest,
  BrowserUpdateProfilePayload,
  BrowserUploadFileRequest,
  BrowserWaitForRequest,
} from '@contracts/types/browser';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

export type BrowserGatewayIpcResponse<T = unknown> = IpcResponse<BrowserGatewayResult<T>>;

@Injectable({ providedIn: 'root' })
export class BrowserGatewayIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async listProfiles(): Promise<BrowserGatewayIpcResponse<BrowserProfile[]>> {
    return this.call(() => this.api?.browserListProfiles());
  }

  async createProfile(
    payload: BrowserCreateProfileRequest,
  ): Promise<BrowserGatewayIpcResponse<BrowserProfile>> {
    return this.call(() => this.api?.browserCreateProfile(payload));
  }

  async updateProfile(
    payload: BrowserUpdateProfilePayload,
  ): Promise<BrowserGatewayIpcResponse<BrowserProfile>> {
    return this.call(() => this.api?.browserUpdateProfile(payload));
  }

  async deleteProfile(payload: BrowserProfileRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserDeleteProfile(payload));
  }

  async openProfile(payload: BrowserProfileRequest): Promise<BrowserGatewayIpcResponse<BrowserTarget[]>> {
    return this.call(() => this.api?.browserOpenProfile(payload));
  }

  async closeProfile(payload: BrowserProfileRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserCloseProfile(payload));
  }

  async listTargets(
    payload: BrowserListTargetsRequest = {},
  ): Promise<BrowserGatewayIpcResponse<BrowserTarget[]>> {
    return this.call(() => this.api?.browserListTargets(payload));
  }

  async selectTarget(payload: BrowserTargetRequest): Promise<BrowserGatewayIpcResponse<BrowserTarget>> {
    return this.call(() => this.api?.browserSelectTarget(payload));
  }

  async navigate(payload: BrowserNavigateRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserNavigate(payload));
  }

  async click(payload: BrowserClickRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserClick(payload));
  }

  async type(payload: BrowserTypeRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserType(payload));
  }

  async fillForm(payload: BrowserFillFormRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserFillForm(payload));
  }

  async select(payload: BrowserSelectRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserSelect(payload));
  }

  async uploadFile(payload: BrowserUploadFileRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserUploadFile(payload));
  }

  async requestUserLogin(
    payload: BrowserRequestUserLoginRequest,
  ): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserRequestUserLogin(payload));
  }

  async pauseForManualStep(
    payload: BrowserManualStepRequest,
  ): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserPauseForManualStep(payload));
  }

  async requestGrant(payload: BrowserRequestGrantRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserRequestGrant(payload));
  }

  async getApprovalStatus(
    payload: BrowserApprovalStatusRequest,
  ): Promise<BrowserGatewayIpcResponse<BrowserApprovalRequest>> {
    return this.call(() => this.api?.browserGetApprovalStatus(payload));
  }

  async listApprovalRequests(
    payload: BrowserListApprovalRequestsRequest = {},
  ): Promise<BrowserGatewayIpcResponse<BrowserApprovalRequest[]>> {
    return this.call(() => this.api?.browserListApprovalRequests(payload));
  }

  async getApprovalRequest(
    payload: BrowserApprovalRequestLookup,
  ): Promise<BrowserGatewayIpcResponse<BrowserApprovalRequest>> {
    return this.call(() => this.api?.browserGetApprovalRequest(payload));
  }

  async approveRequest(
    payload: BrowserApproveRequestPayload,
  ): Promise<BrowserGatewayIpcResponse<BrowserPermissionGrant>> {
    return this.call(() => this.api?.browserApproveRequest(payload));
  }

  async denyRequest(
    payload: BrowserDenyRequestPayload,
  ): Promise<BrowserGatewayIpcResponse<BrowserApprovalRequest>> {
    return this.call(() => this.api?.browserDenyRequest(payload));
  }

  async createGrant(
    payload: BrowserCreateGrantRequest,
  ): Promise<BrowserGatewayIpcResponse<BrowserPermissionGrant>> {
    return this.call(() => this.api?.browserCreateGrant(payload));
  }

  async listGrants(
    payload: BrowserListGrantsRequest = {},
  ): Promise<BrowserGatewayIpcResponse<BrowserPermissionGrant[]>> {
    return this.call(() => this.api?.browserListGrants(payload));
  }

  async revokeGrant(
    payload: BrowserRevokeGrantRequest,
  ): Promise<BrowserGatewayIpcResponse<BrowserPermissionGrant>> {
    return this.call(() => this.api?.browserRevokeGrant(payload));
  }

  async snapshot(payload: BrowserTargetRequest): Promise<BrowserGatewayIpcResponse<unknown>> {
    return this.call(() => this.api?.browserSnapshot(payload));
  }

  async screenshot(payload: BrowserScreenshotRequest): Promise<BrowserGatewayIpcResponse<string>> {
    return this.call(() => this.api?.browserScreenshot(payload));
  }

  async consoleMessages(payload: BrowserTargetRequest): Promise<BrowserGatewayIpcResponse<unknown[]>> {
    return this.call(() => this.api?.browserConsoleMessages(payload));
  }

  async networkRequests(payload: BrowserTargetRequest): Promise<BrowserGatewayIpcResponse<unknown[]>> {
    return this.call(() => this.api?.browserNetworkRequests(payload));
  }

  async waitFor(payload: BrowserWaitForRequest): Promise<BrowserGatewayIpcResponse<null>> {
    return this.call(() => this.api?.browserWaitFor(payload));
  }

  async getAuditLog(
    payload: BrowserListAuditLogRequest = {},
  ): Promise<BrowserGatewayIpcResponse<BrowserAuditEntry[]>> {
    return this.call(() => this.api?.browserGetAuditLog(payload));
  }

  async getHealth(): Promise<BrowserGatewayIpcResponse> {
    return this.call(() => this.api?.browserGetHealth());
  }

  private async call<T>(
    fn: () => Promise<IpcResponse> | undefined,
  ): Promise<BrowserGatewayIpcResponse<T>> {
    const response = await fn();
    return response
      ? response as BrowserGatewayIpcResponse<T>
      : this.notInElectron<T>();
  }

  private notInElectron<T>(): BrowserGatewayIpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
