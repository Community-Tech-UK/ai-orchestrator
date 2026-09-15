/**
 * Claude/Codex account-pool handoff half of `RuntimeReconciler.applyRuntimeChange`.
 * Extracted to keep the reconciler within its size ceiling; the reconciler
 * still owns ordering (mutex, terminate, spawn, rollback).
 */

import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  isPooledProvider,
  type AccountContinuationMode,
} from '../../../shared/types/provider-account.types';
import { getProviderAccountStore } from '../../providers/account-pool/provider-account-store';

export interface AccountHandoffSnapshot {
  accountProfileId: Instance['accountProfileId'];
  accountRoutingSource: Instance['accountRoutingSource'];
  accountSwitches: Instance['accountSwitches'];
}

export function snapshotAccount(instance: Instance): AccountHandoffSnapshot {
  return {
    accountProfileId: instance.accountProfileId,
    accountRoutingSource: instance.accountRoutingSource,
    accountSwitches: instance.accountSwitches,
  };
}

export function restoreAccount(instance: Instance, snapshot: AccountHandoffSnapshot): void {
  instance.accountProfileId = snapshot.accountProfileId;
  instance.accountRoutingSource = snapshot.accountRoutingSource;
  instance.accountSwitches = snapshot.accountSwitches;
}

/**
 * Apply the account handoff to the instance. Failover and pre-emptive switches
 * are pool decisions the user already acknowledged ownership for, so only an
 * explicit switch needs confirmation (spec D3). Returns the pool's continuation
 * policy for continuity planning.
 */
export function applyAccountHandoff(instance: Instance, desired: DesiredRuntime): AccountContinuationMode {
  const handoffKind = desired.accountHandoffKind ?? 'explicit';
  if (handoffKind === 'explicit' && !desired.accountHandoffConfirmed) {
    throw new Error(
      'Switching this conversation to another account needs explicit confirmation: '
      + 'the provider session is ended and the conversation continues on the new account.',
    );
  }
  instance.accountProfileId = desired.accountProfileId;
  instance.accountRoutingSource = handoffKind;
  instance.accountSwitches = (instance.accountSwitches ?? 0) + 1;
  return readAccountContinuation(instance.provider);
}

/** Transcript-note payload for `runtimeChangeNoticesFor`. */
export function accountChangeNotice(
  instance: Instance,
  desired: DesiredRuntime,
  oldProfileId: string | undefined,
): { oldProfileLabel: string | undefined; newProfileLabel: string | undefined; reason: string } {
  return {
    oldProfileLabel: accountLabel(instance.provider, oldProfileId),
    newProfileLabel: accountLabel(instance.provider, instance.accountProfileId),
    reason: desired.accountHandoffReason
      ?? (desired.accountHandoffKind === 'failover'
        ? 'usage limit'
        : desired.accountHandoffKind === 'preemptive' ? 'approaching usage limit' : 'switched by you'),
  };
}

function readAccountContinuation(provider: string): AccountContinuationMode {
  if (!isPooledProvider(provider)) return 'replay';
  try {
    return getProviderAccountStore().getPoolPolicy(provider).continuation;
  } catch {
    return 'replay';
  }
}

function accountLabel(provider: string, profileId: string | undefined): string | undefined {
  const id = profileId ?? LEGACY_ACCOUNT_PROFILE_ID;
  if (!isPooledProvider(provider)) return id;
  try {
    return getProviderAccountStore().getProfile(provider, id)?.label ?? id;
  } catch {
    return id;
  }
}
