/**
 * Pure "what will actually run" preview for the automations editor.
 *
 * Uses the SAME `resolveAutomationSpawnTarget` the main-process runner uses, so
 * the edit dialog's Auto-mode preview can never drift from runtime behaviour.
 * Kept out of the page component (which is at its LOC ceiling) and pure so it is
 * unit-testable in isolation.
 */

import {
  getModelsForProvider,
  getPrimaryModelForProvider,
} from '../../../../shared/types/provider.types';
import type { InstanceProvider } from '../../../../shared/types/instance.types';
import {
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
} from '../../../../shared/automations/automation-model-resolution';

export type AutomationModelSource =
  | 'pinned'
  | 'automation default'
  | 'favourite'
  | 'provider default';

export interface AutomationModelPreview {
  /** Human-readable model name (catalog display name where known). */
  label: string;
  /** Where the resolved model came from, for the informational tag. */
  source: AutomationModelSource;
  /**
   * WS-C7 — the concrete resolved provider (`undefined` when it stays
   * unresolved, e.g. no favourites/defaults pin one). Exposed so the
   * execution-profile selector can warn about a `contained` pick that will
   * fail the fire-time gate, using the SAME resolution the runner uses.
   */
  provider: InstanceProvider | undefined;
}

/**
 * Compute the model an automation would spawn with right now, plus where it
 * came from. `action` carries the form's raw provider/model strings (`''`/
 * `'auto'` mean "not pinned").
 */
export function computeAutomationModelPreview(
  action: { provider: string; model: string },
  defaults: AutomationModelDefaults,
): AutomationModelPreview {
  const pinnedModel = action.model.trim() ? action.model : undefined;
  const target = resolveAutomationSpawnTarget(
    { provider: (action.provider || 'auto') as InstanceProvider, model: pinnedModel },
    defaults,
  );

  const source: AutomationModelSource = pinnedModel
    ? 'pinned'
    : defaults.automationDefaultModel.trim()
      ? 'automation default'
      : target.modelOverride !== undefined
        ? 'favourite'
        : 'provider default';

  const provider = target.provider && target.provider !== 'auto' ? target.provider : undefined;
  const modelId = target.modelOverride ?? (provider ? getPrimaryModelForProvider(provider) : undefined);
  const label = modelId
    ? provider
      ? getModelsForProvider(provider).find((model) => model.id === modelId)?.name ?? modelId
      : modelId
    : 'provider default';

  return { label, source, provider };
}
