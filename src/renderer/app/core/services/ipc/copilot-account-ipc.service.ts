/**
 * Renderer IPC for GitHub Copilot account profiles and routing rules.
 *
 * Mirrors the preload domain one-for-one. Note the absence of any path or
 * environment parameter: a profile is always addressed by its ID, and main
 * derives that profile's Copilot home itself.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  CopilotAccountBindingState,
  CopilotAccountKind,
  CopilotAccountScopePolicy,
  CopilotAutomationPolicy,
  CopilotInvocationOrigin,
  CopilotRouteOutcome,
  CopilotRoutingMatcher,
} from '../../../../../shared/types/copilot-account.types';

/** A profile as it crosses IPC — identity and policy metadata only. */
export interface CopilotAccountView {
  id: string;
  label: string;
  expectedLogin: string | null;
  host: string;
  accountKind: CopilotAccountKind;
  scopePolicy: CopilotAccountScopePolicy;
  automationPolicy: CopilotAutomationPolicy;
  isDefault: boolean;
  isLegacy: boolean;
  createdAt: number;
  updatedAt: number;
  binding?: {
    nodeId: string;
    state: CopilotAccountBindingState;
    observedLogin?: string;
    observedHost?: string;
    checkedAt: number;
    errorCode?: string;
    storesTokenPlaintext?: boolean;
  };
}

export interface CopilotAccountRuleView {
  id: string;
  profileId: string;
  matcher: CopilotRoutingMatcher;
  isProtected: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CopilotRemoteSuggestion {
  remoteName: string;
  host: string;
  owner: string;
  repo: string;
  displayPath: string;
}

export interface CopilotAccountDiagnosticsView {
  aggregate: 'available' | 'partially-configured' | 'auth-required' | 'not-configured';
  nodeId: string;
  unreachableRuleIds: string[];
  conflictingRuleIds: string[];
  invalidDefaultReason?: string;
  ambientTokenVariablesPresent: string[];
  legacyMigrationInUse: boolean;
  warnings: string[];
}

const NOT_ELECTRON: IpcResponse = {
  success: false,
  error: { message: 'Not in Electron' },
};

@Injectable({ providedIn: 'root' })
export class CopilotAccountIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async list(): Promise<CopilotAccountView[]> {
    const response = await (this.api?.listCopilotAccounts() ?? Promise.resolve(NOT_ELECTRON));
    return response.success
      ? ((response.data as { profiles: CopilotAccountView[] }).profiles ?? [])
      : [];
  }

  async listRules(): Promise<CopilotAccountRuleView[]> {
    const response = await (this.api?.listCopilotAccountRules() ?? Promise.resolve(NOT_ELECTRON));
    return response.success
      ? ((response.data as { rules: CopilotAccountRuleView[] }).rules ?? [])
      : [];
  }

  create(input: {
    label: string;
    accountKind: CopilotAccountKind;
    host?: string;
    scopePolicy?: CopilotAccountScopePolicy;
    automationPolicy?: CopilotAutomationPolicy;
    makeDefault?: boolean;
  }): Promise<IpcResponse> {
    return this.api?.createCopilotAccount(input) ?? Promise.resolve(NOT_ELECTRON);
  }

  rename(profileId: string, label: string): Promise<IpcResponse> {
    return this.api?.renameCopilotAccount(profileId, label) ?? Promise.resolve(NOT_ELECTRON);
  }

  updatePolicy(
    profileId: string,
    policy: { scopePolicy?: CopilotAccountScopePolicy; automationPolicy?: CopilotAutomationPolicy },
  ): Promise<IpcResponse> {
    return (
      this.api?.updateCopilotAccountPolicy(profileId, policy) ?? Promise.resolve(NOT_ELECTRON)
    );
  }

  setDefault(profileId: string): Promise<IpcResponse> {
    return this.api?.setDefaultCopilotAccount(profileId) ?? Promise.resolve(NOT_ELECTRON);
  }

  remove(profileId: string): Promise<IpcResponse> {
    return this.api?.removeCopilotAccount(profileId) ?? Promise.resolve(NOT_ELECTRON);
  }

  verifyBinding(profileId: string): Promise<IpcResponse> {
    return this.api?.verifyCopilotAccountBinding(profileId) ?? Promise.resolve(NOT_ELECTRON);
  }

  adoptIdentity(profileId: string, login: string, host?: string): Promise<IpcResponse> {
    return (
      this.api?.adoptCopilotAccountIdentity(profileId, login, host)
      ?? Promise.resolve(NOT_ELECTRON)
    );
  }

  createRule(input: {
    profileId: string;
    matcher: CopilotRoutingMatcher;
    isProtected?: boolean;
  }): Promise<IpcResponse> {
    return this.api?.createCopilotAccountRule(input) ?? Promise.resolve(NOT_ELECTRON);
  }

  removeRule(ruleId: string): Promise<IpcResponse> {
    return this.api?.removeCopilotAccountRule(ruleId) ?? Promise.resolve(NOT_ELECTRON);
  }

  /** Which account this workspace resolves to, and why — before anything spawns. */
  async previewRoute(input: {
    workingDirectory?: string;
    explicitProfileId?: string;
    confirmProtectedOverride?: boolean;
    origin?: CopilotInvocationOrigin;
  }): Promise<CopilotRouteOutcome | null> {
    const response = await (
      this.api?.previewCopilotAccountRoute(input) ?? Promise.resolve(NOT_ELECTRON)
    );
    return response.success ? (response.data as CopilotRouteOutcome) : null;
  }

  async suggestRules(workingDirectory: string): Promise<CopilotRemoteSuggestion[]> {
    const response = await (
      this.api?.suggestCopilotAccountRules(workingDirectory) ?? Promise.resolve(NOT_ELECTRON)
    );
    return response.success
      ? ((response.data as { remotes: CopilotRemoteSuggestion[] }).remotes ?? [])
      : [];
  }

  async diagnostics(): Promise<CopilotAccountDiagnosticsView | null> {
    const response = await (
      this.api?.getCopilotAccountDiagnostics() ?? Promise.resolve(NOT_ELECTRON)
    );
    return response.success ? (response.data as CopilotAccountDiagnosticsView) : null;
  }

  /** Open a terminal signing this profile in. Harness never sees the token. */
  signIn(profileId: string, host?: string): Promise<IpcResponse> {
    return (
      this.api?.runProviderLogin('copilot', { profileId, ...(host ? { host } : {}) })
      ?? Promise.resolve(NOT_ELECTRON)
    );
  }
}
