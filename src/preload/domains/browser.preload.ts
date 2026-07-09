import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

type BrowserProfilePayload = { profileId: string };
type BrowserTargetPayload = BrowserProfilePayload & { targetId: string };
type BrowserGrantProposalPayload = {
  mode: 'per_action' | 'session' | 'autonomous';
  allowedOrigins: Array<{
    scheme: 'https' | 'http';
    hostPattern: string;
    port?: number;
    includeSubdomains: boolean;
  }>;
  allowedActionClasses: Array<
    'read' | 'navigate' | 'input' | 'credential' | 'file-upload' | 'file-download' | 'submit' | 'destructive' | 'payment' | 'unknown'
  >;
  allowExternalNavigation: boolean;
  uploadRoots?: string[];
  autonomous: boolean;
};

export function createBrowserDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    browserListProfiles: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_PROFILES, {});
    },
    browserCreateProfile: (payload: {
      label: string;
      mode: 'session' | 'isolated';
      browser: 'chrome';
      allowedOrigins: Array<{
        scheme: 'https' | 'http';
        hostPattern: string;
        port?: number;
        includeSubdomains: boolean;
      }>;
      defaultUrl?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CREATE_PROFILE, payload);
    },
    browserUpdateProfile: (payload: BrowserProfilePayload & {
      label?: string;
      allowedOrigins?: Array<{
        scheme: 'https' | 'http';
        hostPattern: string;
        port?: number;
        includeSubdomains: boolean;
      }>;
      defaultUrl?: string | null;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_UPDATE_PROFILE, payload);
    },
    browserDeleteProfile: (payload: BrowserProfilePayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_DELETE_PROFILE, payload);
    },
    browserOpenProfile: (payload: BrowserProfilePayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_OPEN_PROFILE, payload);
    },
    browserCloseProfile: (payload: BrowserProfilePayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CLOSE_PROFILE, payload);
    },
    browserListTargets: (payload?: { profileId?: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_TARGETS, payload ?? {});
    },
    browserSelectTarget: (payload: BrowserTargetPayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_SELECT_TARGET, payload);
    },
    browserNavigate: (payload: BrowserTargetPayload & { url: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_NAVIGATE, payload);
    },
    browserClick: (payload: BrowserTargetPayload & {
      selector?: string;
      uid?: string;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CLICK, payload);
    },
    browserType: (payload: BrowserTargetPayload & {
      selector?: string;
      uid?: string;
      value: string;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_TYPE, payload);
    },
    browserFillForm: (payload: BrowserTargetPayload & {
      fields: Array<{ selector?: string; uid?: string; value: string; actionHint?: string }>;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_FILL_FORM, payload);
    },
    browserSelect: (payload: BrowserTargetPayload & {
      selector?: string;
      uid?: string;
      value: string;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_SELECT, payload);
    },
    browserUploadFile: (payload: BrowserTargetPayload & {
      selector: string;
      filePath: string;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_UPLOAD_FILE, payload);
    },
    browserDownloadFile: (payload: BrowserTargetPayload & {
      selector?: string;
      url?: string;
      suggestedFilename?: string;
      timeoutMs?: number;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_DOWNLOAD_FILE, payload);
    },
    browserRequestUserLogin: (payload: BrowserProfilePayload & {
      targetId?: string;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_REQUEST_USER_LOGIN, payload);
    },
    browserPauseForManualStep: (payload: BrowserProfilePayload & {
      targetId?: string;
      kind?: 'manual_review' | 'login' | 'captcha' | 'two_factor';
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_PAUSE_FOR_MANUAL_STEP, payload);
    },
    browserRequestGrant: (payload: BrowserTargetPayload & {
      proposedGrant: BrowserGrantProposalPayload;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_REQUEST_GRANT, payload);
    },
    browserGetApprovalStatus: (payload: { requestId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_GET_APPROVAL_STATUS, payload);
    },
    browserListApprovalRequests: (payload?: {
      instanceId?: string;
      status?: 'pending' | 'approved' | 'denied' | 'expired';
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_APPROVAL_REQUESTS, payload ?? {});
    },
    browserGetApprovalRequest: (payload: { requestId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_GET_APPROVAL_REQUEST, payload);
    },
    browserApproveRequest: (payload: {
      requestId: string;
      grant: BrowserGrantProposalPayload;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_APPROVE_REQUEST, payload);
    },
    browserDenyRequest: (payload: {
      requestId: string;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_DENY_REQUEST, payload);
    },
    browserCreateGrant: (payload: BrowserGrantProposalPayload & {
      instanceId: string;
      provider: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'orchestrator';
      profileId?: string;
      targetId?: string;
      requestedBy: string;
      expiresAt: number;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CREATE_GRANT, payload);
    },
    browserListGrants: (payload?: {
      instanceId?: string;
      profileId?: string;
      includeExpired?: boolean;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_GRANTS, payload ?? {});
    },
    browserRevokeGrant: (payload: {
      grantId: string;
      reason?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_REVOKE_GRANT, payload);
    },
    browserSnapshot: (payload: BrowserTargetPayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_SNAPSHOT, payload);
    },
    browserAccessibilitySnapshot: (payload: BrowserTargetPayload & {
      interestingOnly?: boolean;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_ACCESSIBILITY_SNAPSHOT, payload);
    },
    browserEvaluate: (payload: BrowserTargetPayload & {
      expression: string;
      awaitPromise?: boolean;
      actionHint?: string;
      requestId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_EVALUATE, payload);
    },
    browserScreenshot: (payload: BrowserTargetPayload & {
      maxWidth?: number;
      maxHeight?: number;
      fullPage?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_SCREENSHOT, payload);
    },
    browserConsoleMessages: (payload: BrowserTargetPayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CONSOLE_MESSAGES, payload);
    },
    browserNetworkRequests: (payload: BrowserTargetPayload): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_NETWORK_REQUESTS, payload);
    },
    browserWaitFor: (payload: BrowserTargetPayload & {
      selector?: string;
      timeoutMs?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_WAIT_FOR, payload);
    },
    browserGetAuditLog: (payload?: {
      profileId?: string;
      instanceId?: string;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_GET_AUDIT_LOG, payload ?? {});
    },
    browserGetHealth: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_GET_HEALTH, {});
    },
    // ── Unattended layer: vault, authorizations, campaigns, escalations ──
    browserVaultUnlock: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_VAULT_UNLOCK, {});
    },
    browserVaultLock: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_VAULT_LOCK, {});
    },
    browserVaultStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_VAULT_STATUS, {});
    },
    browserCreateCredentialAuthorization: (payload: {
      profileId: string;
      allowedOrigins: Array<{
        scheme: 'https' | 'http';
        hostPattern: string;
        includeSubdomains: boolean;
      }>;
      purposes: Array<'login' | 'register' | 'totp' | 'email_code'>;
      vaultFolder: string;
      expiresAt: number;
      note?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CREATE_CREDENTIAL_AUTHORIZATION, payload);
    },
    browserListCredentialAuthorizations: (payload?: {
      profileId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_CREDENTIAL_AUTHORIZATIONS, payload ?? {});
    },
    browserRevokeCredentialAuthorization: (payload: {
      authorizationId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_REVOKE_CREDENTIAL_AUTHORIZATION, payload);
    },
    browserCreateCampaign: (payload: {
      label: string;
      profileId: string;
      allowedOrigins: string[];
      allowedActionClasses: string[];
      budget: {
        maxActions: number;
        maxSubmits: number;
        maxNewAccounts: number;
        maxUploads: number;
        maxDurationMs: number;
      };
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_CREATE_CAMPAIGN, payload);
    },
    browserListCampaigns: (payload?: {
      status?: 'active' | 'paused' | 'killed' | 'completed' | 'expired';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_CAMPAIGNS, payload ?? {});
    },
    browserGetCampaign: (payload: { campaignId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_GET_CAMPAIGN, payload);
    },
    browserPauseCampaign: (payload: { campaignId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_PAUSE_CAMPAIGN, payload);
    },
    browserResumeCampaign: (payload: { campaignId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_RESUME_CAMPAIGN, payload);
    },
    browserKillCampaign: (payload: { campaignId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_KILL_CAMPAIGN, payload);
    },
    browserApproveCampaignDeclaration: (payload: {
      campaignId: string;
      declarationHash: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_APPROVE_CAMPAIGN_DECLARATION, payload);
    },
    browserListEscalations: (payload?: {
      campaignId?: string;
      profileId?: string;
      status?: 'pending' | 'resolved' | 'skipped';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_LIST_ESCALATIONS, payload ?? {});
    },
    browserResolveEscalation: (payload: {
      escalationId: string;
      note?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_RESOLVE_ESCALATION, payload);
    },
    browserSkipEscalation: (payload: {
      escalationId: string;
      note?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BROWSER_SKIP_ESCALATION, payload);
    },
  };
}
