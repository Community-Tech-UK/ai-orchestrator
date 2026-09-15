import { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type {
  AccountAutomationPolicy,
  AccountContinuationMode,
  AccountFailoverMode,
  AccountPreemptivePolicy,
  PooledProvider,
} from '../../shared/types/provider-account.types';

/**
 * Renderer bridge for Claude/Codex account pools.
 *
 * No signature here can carry a path, an environment map or a credential: a
 * profile is addressed by provider + validated ID and main derives its home.
 */
export function createProviderAccountDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string } = (p = {}) => p,
) {
  return {
    listProviderAccounts: (provider?: PooledProvider): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_LIST, withAuth(provider ? { provider } : {})),

    createProviderAccount: (input: { provider: PooledProvider; label: string; automationPolicy?: AccountAutomationPolicy }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_CREATE, withAuth({ ...input })),

    updateProviderAccount: (input: {
      provider: PooledProvider;
      profileId: string;
      label?: string;
      enabled?: boolean;
      automationPolicy?: AccountAutomationPolicy;
      adoptObservedIdentity?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_UPDATE, withAuth({ ...input })),

    setProviderAccountPriorityOrder: (provider: PooledProvider, profileIds: string[]): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_SET_PRIORITY_ORDER, withAuth({ provider, profileIds })),

    /** Rejected while a live session uses the account. */
    removeProviderAccount: (provider: PooledProvider, profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_REMOVE, withAuth({ provider, profileId })),

    verifyProviderAccount: (provider: PooledProvider, profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_VERIFY, withAuth({ provider, profileId })),

    /** Copies the sign-in command (home stays in main). Optional `openTerminal` also opens a Harness terminal. */
    launchProviderAccountLogin: (
      provider: PooledProvider,
      profileId: string,
      options?: { openTerminal?: boolean },
    ): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_LAUNCH_LOGIN, withAuth({
        provider,
        profileId,
        ...(options?.openTerminal ? { openTerminal: true } : {}),
      })),

    readProviderAccountPools: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_POOL_READ, withAuth({})),

    updateProviderAccountPool: (input: {
      provider: PooledProvider;
      failoverMode?: AccountFailoverMode;
      continuation?: AccountContinuationMode;
      preemptive?: Partial<AccountPreemptivePolicy>;
      switchCooldownMs?: number;
      maxSwitchesPerTurn?: number;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_POOL_UPDATE, withAuth({ ...input })),

    acknowledgeProviderAccountOwnership: (provider: PooledProvider): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP, withAuth({ provider, acknowledged: true })),

    getProviderAccountDoctor: (provider: PooledProvider): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_DOCTOR, withAuth({ provider })),

    previewProviderAccountRoute: (input: { provider: PooledProvider; model?: string; explicitProfileId?: string; executionNodeId?: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_RESOLVE_PREVIEW, withAuth({ ...input })),

    /** Explicit account handoff for a live session (the user confirmed). */
    switchSessionProviderAccount: (instanceId: string, profileId: string): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PROVIDER_ACCOUNT_SWITCH_SESSION, withAuth({ instanceId, profileId, confirmed: true })),
  };
}
