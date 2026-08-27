import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  CopilotAccountBindingState,
  CopilotAccountKind,
  CopilotAccountScopePolicy,
  CopilotAutomationPolicy,
  CopilotInvocationOrigin,
  CopilotRoutingMatcher,
} from '../../shared/types/copilot-account.types';

/**
 * Renderer bridge for GitHub Copilot account profiles and routing rules.
 *
 * Note what these signatures deliberately CANNOT express: there is no path
 * parameter and no environment map anywhere. A profile is addressed by its
 * validated ID; main derives that profile's Copilot home itself. The one path
 * that does cross (`workingDirectory`, for route preview and rule suggestions)
 * is a workspace the user already has open, used as routing evidence only.
 */
export function createCopilotAccountDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string } = (p = {}) => p,
) {
  return {
    /** Profiles with their node-local binding state. */
    listCopilotAccounts: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_LIST, withAuth({})),

    /** Create a profile. Sign-in is a separate, explicit step. */
    createCopilotAccount: (input: {
      label: string;
      accountKind: CopilotAccountKind;
      host?: string;
      scopePolicy?: CopilotAccountScopePolicy;
      automationPolicy?: CopilotAutomationPolicy;
      makeDefault?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_CREATE, withAuth({ ...input })),

    renameCopilotAccount: (profileId: string, label: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_RENAME, withAuth({ profileId, label })),

    updateCopilotAccountPolicy: (
      profileId: string,
      policy: {
        scopePolicy?: CopilotAccountScopePolicy;
        automationPolicy?: CopilotAutomationPolicy;
      },
    ): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_UPDATE_POLICY, withAuth({ profileId, ...policy })),

    setDefaultCopilotAccount: (profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_SET_DEFAULT, withAuth({ profileId })),

    /** Rejected while a live session uses the profile. */
    removeCopilotAccount: (profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_REMOVE, withAuth({ profileId })),

    /** Re-read this profile's node-local sign-in state now. */
    verifyCopilotAccountBinding: (profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_VERIFY_BINDING, withAuth({ profileId })),

    /** Explicitly accept the identity a profile is actually signed in as. */
    adoptCopilotAccountIdentity: (
      profileId: string,
      login: string,
      host?: string,
    ): Promise<IpcResponse> =>
      ipcRenderer.invoke(
        ch.COPILOT_ACCOUNT_ADOPT_IDENTITY,
        withAuth({ profileId, login, ...(host ? { host } : {}) }),
      ),

    listCopilotAccountRules: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_RULE_LIST, withAuth({})),

    createCopilotAccountRule: (input: {
      profileId: string;
      matcher: CopilotRoutingMatcher;
      isProtected?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_RULE_CREATE, withAuth({ ...input })),

    removeCopilotAccountRule: (ruleId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_RULE_REMOVE, withAuth({ ruleId })),

    /** Which account a workspace resolves to, and why — before anything spawns. */
    previewCopilotAccountRoute: (input: {
      workingDirectory?: string;
      explicitProfileId?: string;
      confirmProtectedOverride?: boolean;
      origin?: CopilotInvocationOrigin;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_PREVIEW_ROUTE, withAuth({ ...input })),

    /** The workspace's GitHub remotes, for "Route current workspace". */
    suggestCopilotAccountRules: (workingDirectory: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_SUGGEST_RULES, withAuth({ workingDirectory })),

    /** Profile-by-node authentication matrix. */
    getCopilotAccountNodeMatrix: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_NODE_MATRIX, withAuth({})),

    /** GitHub accounts Copilot is already signed in to on this machine. */
    discoverCopilotAccounts: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_DISCOVER, withAuth({})),

    /** Full diagnostics for the accounts section (secret-free by construction). */
    getCopilotAccountDiagnostics: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COPILOT_ACCOUNT_DIAGNOSTICS, withAuth({})),
  };
}

/** Re-exported for renderer typing of binding chips. */
export type { CopilotAccountBindingState };
