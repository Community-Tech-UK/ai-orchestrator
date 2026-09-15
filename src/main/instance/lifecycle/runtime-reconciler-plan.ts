/**
 * Pure planning half of the RuntimeReconciler: diff the desired runtime
 * against the live instance and pick a continuity strategy. Kept free of
 * heavy imports (session managers, adapters) so the desired-runtime queue and
 * unit tests can use it without the execution machinery.
 */

import type { CliType } from '../../cli/cli-detection';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type { AccountContinuationMode } from '../../../shared/types/provider-account.types';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../../shared/types/provider-account.types';
import type {
  ContinuityPlan,
  RuntimeAdapterCapabilities,
  RuntimeDiff,
} from './runtime-reconciler.types';

/**
 * Which parts of the runtime the desired state changes. Also serves as the
 * queue's cancel test ("desired equals live config" → nothing to do).
 * Field semantics follow {@link DesiredRuntime}: `model`/`reasoningEffort`
 * undefined mean "keep current".
 */
export function computeRuntimeDiff(instance: Instance, desired: DesiredRuntime): RuntimeDiff {
  const desiredLocalTarget =
    desired.modelRuntimeTarget?.kind === 'local-model' ? desired.modelRuntimeTarget : undefined;
  const currentLocalTarget =
    instance.modelRuntimeTarget?.kind === 'local-model' ? instance.modelRuntimeTarget : undefined;

  // Local-model targets are identified by selector; a desired CLI runtime on
  // an instance currently attached to a local model is always a change.
  const runtimeTargetChanged = desiredLocalTarget
    ? desiredLocalTarget.selectorId !== currentLocalTarget?.selectorId
    : currentLocalTarget !== undefined;
  const providerChanged = !desiredLocalTarget && desired.provider !== instance.provider;
  const modelChanged =
    !desiredLocalTarget && desired.model !== undefined && desired.model !== instance.currentModel;
  const reasoningChanged =
    desired.reasoningEffort !== undefined
    && (desired.reasoningEffort ?? undefined) !== instance.reasoningEffort;
  const yoloModeChanged =
    desired.yoloMode !== undefined && desired.yoloMode !== instance.yoloMode;
  // A Copilot account handoff is a runtime change in its own right: the
  // provider and model can be identical and the session still has to be torn
  // down, because the native session belongs to the old GitHub identity.
  const copilotAccountChanged =
    desired.copilotAccountProfileId !== undefined
    && desired.copilotAccountProfileId !== instance.copilotAccountProfileId;
  // An unstamped Claude/Codex session ran on the legacy profile.
  const accountProfileChanged =
    desired.accountProfileId !== undefined
    && desired.accountProfileId !== (instance.accountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID);

  return {
    providerChanged,
    modelChanged,
    reasoningChanged,
    runtimeTargetChanged,
    yoloModeChanged,
    copilotAccountChanged,
    accountProfileChanged,
    hasChanges:
      providerChanged
      || modelChanged
      || reasoningChanged
      || runtimeTargetChanged
      || yoloModeChanged
      || copilotAccountChanged
      || accountProfileChanged,
  };
}

/**
 * How conversation context survives the change. Cross-provider changes can
 * never native-resume (the session belongs to the old provider); Claude
 * native resume reconnects to a session whose model binding can remain the
 * previous model, so Claude model changes replay too. 'replay' with no prior
 * conversation degenerates to a plain fresh spawn (no preamble is sent).
 */
export function planContinuity(params: {
  diff: RuntimeDiff;
  capabilities: RuntimeAdapterCapabilities;
  hasConversation: boolean;
  cliType: CliType;
  isLocalModelTarget: boolean;
  /** Pool continuation policy; consulted only for an account-only handoff. */
  accountContinuation?: AccountContinuationMode;
}): ContinuityPlan {
  const { diff } = params;
  const accountOnlyChange =
    diff.accountProfileChanged
    && !diff.providerChanged
    && !diff.modelChanged
    && !diff.reasoningChanged
    && !diff.runtimeTargetChanged
    && !diff.copilotAccountChanged;
  if (accountOnlyChange) {
    // Account pools (spec D3): with a shared session store the new account's
    // CLI can read the same session, so the conversation natively resumes
    // (Claude included — the model is not changing). Otherwise replay.
    const shared = (params.accountContinuation ?? 'shared-store') === 'shared-store';
    if (!shared || !params.hasConversation || !params.capabilities.supportsResume || params.isLocalModelTarget) {
      return 'replay';
    }
    return params.capabilities.supportsForkSession ? 'native-resume-fork' : 'native-resume';
  }
  const canNativeResume =
    params.hasConversation
    && params.capabilities.supportsResume
    && params.cliType !== 'claude'
    && !params.isLocalModelTarget
    && !params.diff.providerChanged
    // A native Copilot session belongs to the GitHub identity that created it.
    // Resuming it under a different account would send this conversation's
    // context through the wrong seat, so a handoff always replays into a
    // brand-new provider session.
    && !params.diff.copilotAccountChanged;
  if (!canNativeResume) return 'replay';
  return params.capabilities.supportsForkSession ? 'native-resume-fork' : 'native-resume';
}
