import { assertAcpGenerationBudgetSelection, isAcpSessionModelConfirmed } from './acp-generation-budget-selection';
import { isAcpSessionConfigSelected } from './acp-session-config-confirmation';
import { applyAcpSessionConfig, type AcpSessionConfigRequest, type AcpSetConfigOption } from './acp-session-config-options';
import type { OpenCodeGenerationBudget } from './opencode-generation-budget';

/** Startup may warn about effort, but account and budget model selection must be proven. */
export async function applyAcpStartupSessionConfig(
  requested: AcpSessionConfigRequest | undefined,
  generationBudget: OpenCodeGenerationBudget | undefined,
  requireModelConfirmation: boolean | undefined,
  setConfigOption: AcpSetConfigOption,
  getCurrentOptions: () => unknown,
): Promise<string[]> {
  if (!requested?.model && !requested?.effort) {
    assertAcpGenerationBudgetSelection(generationBudget, requested, getCurrentOptions());
    if (requireModelConfirmation) throw new Error('Unable to confirm the selected model for the routed account; refusing startup.');
    return [];
  }
  const modelWasSelected = requested.model ? isAcpSessionConfigSelected(getCurrentOptions(), 'model', requested.model) : false;
  const outcome = await applyAcpSessionConfig(setConfigOption, getCurrentOptions(), requested, getCurrentOptions);
  assertAcpGenerationBudgetSelection(generationBudget, requested, getCurrentOptions(), outcome);
  if (requireModelConfirmation
    && (!(modelWasSelected || outcome.applied.some((entry) => entry.key === 'model' && entry.value === requested.model?.trim()))
      || !isAcpSessionModelConfirmed(requested.model, getCurrentOptions(), outcome))) {
    throw new Error('Unable to confirm the selected model for the routed account; refusing startup.');
  }
  return outcome.warnings;
}
