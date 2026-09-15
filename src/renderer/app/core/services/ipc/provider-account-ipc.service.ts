/**
 * Renderer IPC for Claude/Codex account pools. Mirrors the preload domain; a
 * profile is always addressed by provider + ID, never by path.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  AccountAutomationPolicy,
  AccountBindingState,
  AccountContinuationMode,
  AccountFailoverMode,
  AccountPreemptivePolicy,
  AccountRouteOutcome,
  PooledProvider,
  ProviderAccountPoolPolicy,
  ProviderAccountPools,
} from '../../../../../shared/types/provider-account.types';

/** A profile as it crosses IPC — identity and policy metadata only. */
export interface ProviderAccountView {
  id: string;
  provider: PooledProvider;
  label: string;
  expectedIdentity: string | null;
  expectedAccountKey: string | null;
  planLabel: string | null;
  priority: number;
  enabled: boolean;
  automationPolicy: AccountAutomationPolicy;
  isLegacy: boolean;
  createdAt: number;
  updatedAt: number;
  binding?: {
    nodeId: string;
    state: AccountBindingState;
    observedIdentity?: string;
    observedPlan?: string;
    errorCode?: string;
    checkedAt: number;
  };
}

export interface ProviderAccountRoutePreview {
  outcome: AccountRouteOutcome;
  considered: { profileId: string; vetoReason: string }[];
}

export interface ProviderAccountDoctorView {
  provider: PooledProvider;
  poolActive: boolean;
  ownershipAcknowledged: boolean;
  usableProfileIds: string[];
  ambientAuthVariablesPresent: string[];
  sharedWorkspaceProfileIds: string[];
  warnings: string[];
}

const NOT_ELECTRON: IpcResponse = { success: false, error: { message: 'Not in Electron' } };

@Injectable({ providedIn: 'root' })
export class ProviderAccountIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  /** Throws on failure: a failed read is not an empty pool. */
  async list(provider?: PooledProvider): Promise<{ profiles: ProviderAccountView[]; pools: ProviderAccountPools }> {
    const response = await (this.api?.listProviderAccounts(provider) ?? Promise.resolve(NOT_ELECTRON));
    if (!response.success) {
      throw new Error(response.error?.message ?? 'Accounts could not be loaded.');
    }
    return response.data as { profiles: ProviderAccountView[]; pools: ProviderAccountPools };
  }

  create(input: { provider: PooledProvider; label: string; automationPolicy?: AccountAutomationPolicy }): Promise<IpcResponse> {
    return this.api?.createProviderAccount(input) ?? Promise.resolve(NOT_ELECTRON);
  }

  update(input: {
    provider: PooledProvider;
    profileId: string;
    label?: string;
    enabled?: boolean;
    automationPolicy?: AccountAutomationPolicy;
    adoptObservedIdentity?: boolean;
  }): Promise<IpcResponse> {
    return this.api?.updateProviderAccount(input) ?? Promise.resolve(NOT_ELECTRON);
  }

  setPriorityOrder(provider: PooledProvider, profileIds: string[]): Promise<IpcResponse> {
    return this.api?.setProviderAccountPriorityOrder(provider, profileIds) ?? Promise.resolve(NOT_ELECTRON);
  }

  remove(provider: PooledProvider, profileId: string): Promise<IpcResponse> {
    return this.api?.removeProviderAccount(provider, profileId) ?? Promise.resolve(NOT_ELECTRON);
  }

  verify(provider: PooledProvider, profileId: string): Promise<IpcResponse> {
    return this.api?.verifyProviderAccount(provider, profileId) ?? Promise.resolve(NOT_ELECTRON);
  }

  launchLogin(
    provider: PooledProvider,
    profileId: string,
    options?: { openTerminal?: boolean },
  ): Promise<IpcResponse> {
    return this.api?.launchProviderAccountLogin(provider, profileId, options) ?? Promise.resolve(NOT_ELECTRON);
  }

  updatePool(input: {
    provider: PooledProvider;
    failoverMode?: AccountFailoverMode;
    continuation?: AccountContinuationMode;
    preemptive?: Partial<AccountPreemptivePolicy>;
    switchCooldownMs?: number;
    maxSwitchesPerTurn?: number;
  }): Promise<IpcResponse> {
    return this.api?.updateProviderAccountPool(input) ?? Promise.resolve(NOT_ELECTRON);
  }

  acknowledgeOwnership(provider: PooledProvider): Promise<IpcResponse> {
    return this.api?.acknowledgeProviderAccountOwnership(provider) ?? Promise.resolve(NOT_ELECTRON);
  }

  async doctor(provider: PooledProvider): Promise<ProviderAccountDoctorView | null> {
    const response = await (this.api?.getProviderAccountDoctor(provider) ?? Promise.resolve(NOT_ELECTRON));
    return response.success ? (response.data as ProviderAccountDoctorView) : null;
  }

  async previewRoute(input: { provider: PooledProvider; model?: string; explicitProfileId?: string; executionNodeId?: string }): Promise<ProviderAccountRoutePreview | null> {
    const response = await (this.api?.previewProviderAccountRoute(input) ?? Promise.resolve(NOT_ELECTRON));
    return response.success ? (response.data as ProviderAccountRoutePreview) : null;
  }

  switchSession(instanceId: string, profileId: string): Promise<IpcResponse> {
    return this.api?.switchSessionProviderAccount(instanceId, profileId) ?? Promise.resolve(NOT_ELECTRON);
  }
}

export type { ProviderAccountPoolPolicy };
