/**
 * Pure planning half of the RuntimeReconciler: diff the desired runtime
 * against the live instance and pick a continuity strategy. Kept free of
 * heavy imports (session managers, adapters) so the desired-runtime queue and
 * unit tests can use it without the execution machinery.
 */

import type { CliType } from '../../cli/cli-detection';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
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

  return {
    providerChanged,
    modelChanged,
    reasoningChanged,
    runtimeTargetChanged,
    hasChanges: providerChanged || modelChanged || reasoningChanged || runtimeTargetChanged,
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
}): ContinuityPlan {
  const canNativeResume =
    params.hasConversation
    && params.capabilities.supportsResume
    && params.cliType !== 'claude'
    && !params.isLocalModelTarget
    && !params.diff.providerChanged;
  if (!canNativeResume) return 'replay';
  return params.capabilities.supportsForkSession ? 'native-resume-fork' : 'native-resume';
}
