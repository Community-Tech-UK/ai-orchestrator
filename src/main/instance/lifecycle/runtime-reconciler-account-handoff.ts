/**
 * Claude/Codex/OpenCode account-pool handoff half of
 * `RuntimeReconciler.applyRuntimeChange`. Extracted to keep the reconciler
 * within its size ceiling; the reconciler still owns ordering (mutex,
 * terminate, spawn, rollback).
 */

import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  isPooledProvider,
  isLogicalMiMoModel,
  opencodeAccountProviderName,
  type AccountContinuationMode,
  type ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { getProviderAccountStore } from '../../providers/account-pool/provider-account-store';
import { getProviderAccountRoutingService } from '../../providers/account-pool/provider-account-routing-service';
import { AccountRoutingError } from './account-route-preflight';
import { resolveOpenCodeSessionModel } from '../../cli/adapters/opencode-account-provider-config';
import { mapAcpEffort } from '../../cli/adapters/acp-session-config-options';
import { announceRuntimeChangeSet, runtimeChangeNoticesFor } from './runtime-change-notices';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RuntimeReconcilerAccountHandoff');

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

/** The live-switch capability `AcpCliAdapter` provides (MiMo multi-account). */
export interface LiveAccountSwitchAdapter {
  applyLiveSessionConfig(request: { model?: string; effort?: string }): Promise<void>;
  sendInput(text: string): Promise<void>;
  queueNextPromptContext?(text: string): void;
}

export function canSwitchAccountInPlace(adapter: unknown): adapter is LiveAccountSwitchAdapter {
  const candidate = adapter as Partial<LiveAccountSwitchAdapter> | undefined;
  return typeof candidate?.applyLiveSessionConfig === 'function' && typeof candidate?.sendInput === 'function';
}

/** True when the diff changes ONLY the account profile (no respawn needed). */
export function isAccountOnlyChange(diff: {
  accountProfileChanged: boolean;
  providerChanged: boolean;
  modelChanged: boolean;
  reasoningChanged: boolean;
  runtimeTargetChanged: boolean;
  yoloModeChanged: boolean;
  copilotAccountChanged: boolean;
}): boolean {
  return diff.accountProfileChanged
    && !diff.providerChanged && !diff.modelChanged && !diff.reasoningChanged
    && !diff.runtimeTargetChanged && !diff.yoloModeChanged && !diff.copilotAccountChanged;
}

/**
 * Move a RUNNING OpenCode session to another MiMo account IN PLACE — one
 * shared session store, no restart (Decision 6; probe 0.2).
 *
 * The adapter first cancels any in-flight turn and re-binds the session model
 * to `aio-mimo-<profile>/<model>` (probe 0.2b: a stuck retry keeps hitting the
 * OLD account after the model changes, so cancel + re-send is the only safe
 * order). On success the instance bookkeeping, the same transcript note /
 * announcement a respawn handoff produces, and the renderer updates are
 * applied here; interrupted work continues exactly as the existing failover
 * does (the coordinator re-sends it). Current-node sign-in admission runs
 * before cancellation or any native write. A failed admission throws an
 * AccountRoutingError, preserving the active session instead of respawning.
 * Returns false whenever the change must
 * fall back to the respawn handoff (non-OpenCode, adapter not running or not
 * ACP, target profile gone, or the agent refused the model or requested effort) — the
 * instance is then untouched.
 */
export async function tryAccountSwitchInPlace(params: {
  instance: Instance;
  desired: DesiredRuntime;
  adapter: unknown;
  oldAccount: AccountHandoffSnapshot;
  emitSystemNotice(instance: Instance, content: string, metadata?: Record<string, unknown>): void;
  queueUpdate: RuntimeReconcilerDeps['queueUpdate'];
  emitRuntimeChanged: RuntimeReconcilerDeps['emitRuntimeChanged'];
}): Promise<boolean> {
  const { instance, desired } = params;
  if (instance.provider !== 'opencode' || !isLogicalMiMoModel(instance.currentModel) || !desired.accountProfileId) return false;
  if (instance.executionLocation?.type === 'remote') return false;
  if (!canSwitchAccountInPlace(params.adapter)) return false;
  const handoffKind = desired.accountHandoffKind ?? 'explicit';
  if (handoffKind === 'explicit' && !desired.accountHandoffConfirmed) return false;

  let providerName: string;
  let profile: ProviderAccountProfile;
  try {
    const target = getProviderAccountStore().getProfile('opencode', desired.accountProfileId);
    if (!target) return false;
    profile = target;
    providerName = opencodeAccountProviderName(profile);
  } catch {
    return false;
  }
  const model = resolveOpenCodeSessionModel(instance.currentModel, providerName);
  if (!model) return false;
  // Native model options can outlive sign-out. Admit on this executing node
  // before any write, bypassing earlier cached or in-flight binding evidence.
  const admission = await getProviderAccountRoutingService().admit(profile, handoffKind, undefined, { force: true });
  if (!admission.ok) throw new AccountRoutingError(admission);
  const effort = mapAcpEffort(instance.reasoningEffort);
  try {
    await params.adapter.applyLiveSessionConfig({ model, ...(effort ? { effort } : {}) });
  } catch (error) {
    logger.warn('Live account switch refused; falling back to the respawn handoff', {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  applyAccountHandoff(instance, desired);
  instance.recoveryMethod = 'native';
  await announceRuntimeChangeSet({
    instance,
    adapter: params.adapter,
    delivery: 'next-prompt',
    emitSystemNotice: params.emitSystemNotice,
    notices: runtimeChangeNoticesFor({
      isYoloOnlyChange: false,
      isProviderSwap: false,
      yoloModeChanged: false,
      nextYoloMode: instance.yoloMode,
      oldProvider: instance.provider,
      newProvider: instance.provider,
      oldModel: instance.currentModel,
      newModel: instance.currentModel,
      oldReasoningEffort: instance.reasoningEffort,
      newReasoningEffort: instance.reasoningEffort,
      accountChange: accountChangeNotice(instance, desired, params.oldAccount.accountProfileId),
    }),
  });
  params.queueUpdate(
    instance.id,
    instance.status,
    instance.contextUsage,
    undefined,
    undefined,
    undefined,
    instance.executionLocation,
    undefined,
    undefined,
    instance.currentModel,
    undefined,
    { provider: instance.provider, desiredRuntime: null },
  );
  params.emitRuntimeChanged({
    instanceId: instance.id,
    model: instance.currentModel,
    provider: instance.provider,
    reasoningEffort: instance.reasoningEffort,
  });
  return true;
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
