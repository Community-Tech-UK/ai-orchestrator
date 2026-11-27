/**
 * Trial account leases — shared constants and result shapes.
 *
 * Kept free of main-process imports because the `account_trial` tool's schema
 * is bundled into the Electron-free `aio-mcp` forwarder.
 * See `src/main/providers/account-pool/account-trial-lease-service.ts`.
 */

import type { AccountAutomationPolicy, PooledProvider } from './provider-account.types';

/** The one policy a lease can set. It keeps automatic routing away and still allows a chosen account to be used by hand. */
export const ACCOUNT_TRIAL_POLICY: AccountAutomationPolicy = 'manual-only';
export const ACCOUNT_TRIAL_DEFAULT_TTL_MINUTES = 240;
export const ACCOUNT_TRIAL_MAX_TTL_MINUTES = 720;
export const ACCOUNT_TRIAL_MAX_PROFILES = 6;
export const ACCOUNT_TRIAL_MAX_SESSIONS = 16;

export interface AccountTrialProfileRef {
  provider: PooledProvider;
  profileId: string;
}

export interface AccountTrialStartSessionInput extends AccountTrialProfileRef {
  leaseId: string;
  prompt: string;
  model?: string;
  workingDirectory?: string;
  name?: string;
}

export type AccountTrialRestoreOutcome =
  | 'restored'
  | 'already-original'
  | 'left-changed-by-someone-else'
  | 'profile-removed'
  | 'restore-failed';

export type AccountTrialReleaseReason = 'released' | 'owner-gone' | 'expired' | 'startup';

export interface AccountTrialProfileReceipt extends AccountTrialProfileRef {
  label: string;
  previousPolicy: AccountAutomationPolicy;
  policy: AccountAutomationPolicy;
}

export interface AccountTrialReserveReceipt {
  leaseId: string;
  expiresAt: number;
  profiles: AccountTrialProfileReceipt[];
}

export interface AccountTrialReleaseReceipt {
  leaseId: string;
  reason: AccountTrialReleaseReason;
  /** False while at least one policy could not be restored; the lease stays and is retried. */
  complete: boolean;
  profiles: Array<AccountTrialProfileRef & {
    outcome: AccountTrialRestoreOutcome;
    restoredTo?: AccountAutomationPolicy;
    currentPolicy?: AccountAutomationPolicy;
    error?: string;
  }>;
  sessions: Array<{ instanceId: string; stopped: boolean; error?: string }>;
}

export interface AccountTrialStatus {
  leases: Array<{
    leaseId: string;
    expiresAt: number;
    profiles: Array<AccountTrialProfileRef & {
      label: string;
      restoreTo: AccountAutomationPolicy;
      currentPolicy: AccountAutomationPolicy | null;
    }>;
    sessionIds: string[];
  }>;
  /** Leases held by other sessions. Their contents are not shown. */
  otherActiveLeases: number;
}

/** What the orchestrator tool needs; the caller id always comes from the authenticated RPC, never from tool arguments. */
export interface AccountTrialOperations {
  reserve(
    ownerInstanceId: string,
    input: { profiles: AccountTrialProfileRef[]; ttlMinutes?: number },
  ): AccountTrialReserveReceipt;
  startSession(ownerInstanceId: string, input: AccountTrialStartSessionInput): Promise<{ instanceId: string; leaseId: string }>;
  release(ownerInstanceId: string, leaseId: string): Promise<AccountTrialReleaseReceipt>;
  status(ownerInstanceId: string): AccountTrialStatus;
}
