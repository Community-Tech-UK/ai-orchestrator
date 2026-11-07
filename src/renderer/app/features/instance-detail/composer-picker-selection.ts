import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import type { InstanceRuntimeSummary, ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';

/**
 * Map a live instance's provider + model to the picker's initial selection.
 * Pure so the per-instance seed mapping is unit-testable without the Angular
 * compiler. `ollama` collapses to `claude` because the picker has no Ollama
 * tab; a missing model becomes `null` (the picker then shows the provider
 * default).
 */
export function deriveComposerPickerSelection(
  provider: InstanceProvider,
  currentModel: string | undefined,
  reasoning: ReasoningEffort | null = null,
  runtimeSummary?: InstanceRuntimeSummary,
): PendingSelection {
  if (runtimeSummary?.kind === 'local-model') {
    const modelRuntimeTarget = localModelRuntimeTargetFromSummary(runtimeSummary);
    return {
      provider: 'local-model',
      model: modelRuntimeTarget?.selectorId ?? runtimeSummary.modelId ?? currentModel ?? null,
      reasoning: null,
      ...(modelRuntimeTarget ? { modelRuntimeTarget } : {}),
    };
  }

  const pickerProvider: PickerProvider = (provider === 'ollama' ? 'claude' : provider) as PickerProvider;
  return { provider: pickerProvider, model: currentModel ?? null, reasoning: reasoning ?? null };
}

function localModelRuntimeTargetFromSummary(
  summary: InstanceRuntimeSummary,
): Extract<ModelRuntimeTarget, { kind: 'local-model' }> | null {
  if (
    summary.kind !== 'local-model'
    || !summary.source
    || !summary.endpointProvider
    || !summary.endpointId
    || !summary.modelId
    || !summary.selectorId
  ) {
    return null;
  }

  return {
    kind: 'local-model',
    source: summary.source,
    endpointProvider: summary.endpointProvider,
    endpointId: summary.endpointId,
    modelId: summary.modelId,
    selectorId: summary.selectorId,
    ...(summary.nodeId ? { nodeId: summary.nodeId } : {}),
    ...(summary.nodeName ? { nodeName: summary.nodeName } : {}),
  };
}

/**
 * Whether the live toolbar should adopt a newly-arrived instance model without
 * overwriting an explicit in-flight user pick. Placeholder states (null model
 * or the Cursor `auto` sentinel) are hydrated; concrete divergent picks are not.
 */
export function shouldHydrateComposerPickerSelection(
  pending: PendingSelection | null,
  derived: PendingSelection,
): boolean {
  const derivedModel = derived.model?.trim();
  if (!derivedModel || derivedModel.toLowerCase() === 'auto') {
    return false;
  }

  if (!pending || pending.provider !== derived.provider) {
    return true;
  }

  const pendingModel = pending.model?.trim().toLowerCase() ?? null;
  if (pendingModel === null || pendingModel === 'auto') {
    return pendingModel !== derivedModel.toLowerCase();
  }

  return false;
}
