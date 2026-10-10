import { parseAcpConfigOptions, planConfigOptionWrite, type AcpSessionConfigOutcome, type AcpSessionConfigRequest } from './acp-session-config-options';
import type { OpenCodeGenerationBudget } from './opencode-generation-budget';

/** The latest native option list takes precedence over an earlier write acknowledgment. */
export function isAcpSessionModelConfirmed(
  model: string | undefined,
  currentOptions: unknown,
  outcome?: AcpSessionConfigOutcome,
): boolean {
  const value = model?.trim();
  if (!value) return false;
  if (Array.isArray(currentOptions)) {
    const selected = planConfigOptionWrite(parseAcpConfigOptions(currentOptions), 'model', value);
    return selected.kind === 'skip' && selected.reason === 'already selected';
  }
  return outcome?.applied.some((entry) => entry.key === 'model' && entry.value === value) ?? false;
}

/** A requested-model cap cannot describe a session that retained another model. */
export function assertAcpGenerationBudgetSelection(
  budget: OpenCodeGenerationBudget | undefined,
  requested: AcpSessionConfigRequest | undefined,
  currentOptions: unknown,
  outcome?: AcpSessionConfigOutcome,
): void {
  if (!budget) return;
  const model = requested?.model?.trim();
  if (model === budget.model && isAcpSessionModelConfirmed(model, currentOptions, outcome)) return;
  throw new Error('Unable to confirm the selected model for its configured generation budget; refusing startup.');
}
