import { parseAcpConfigOptions, planConfigOptionWrite, type AcpSessionConfigOutcome, type AcpSessionConfigRequest } from './acp-session-config-options';
import type { OpenCodeGenerationBudget } from './opencode-generation-budget';

/** A requested-model cap cannot describe a session that retained another model. */
export function assertAcpGenerationBudgetSelection(
  budget: OpenCodeGenerationBudget | undefined,
  requested: AcpSessionConfigRequest | undefined,
  initialOptions: unknown,
  outcome?: AcpSessionConfigOutcome,
): void {
  if (!budget) return;
  const model = requested?.model?.trim();
  const selected = Array.isArray(initialOptions) && model
    ? planConfigOptionWrite(parseAcpConfigOptions(initialOptions), 'model', model)
    : undefined;
  if (model === budget.model && (outcome?.applied.some((entry) => entry.key === 'model' && entry.value === model)
    || (selected?.kind === 'skip' && selected.reason === 'already selected'))) return;
  throw new Error('Unable to confirm the selected model for its configured generation budget; refusing startup.');
}
