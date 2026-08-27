import type { AutomationAction } from '../types/automation.types';
import { CLAUDE_MODELS } from '../types/provider.types';

type AutomationModelSelection = Pick<AutomationAction, 'provider' | 'model'>;

/** Apply the product default only while constructing a new user automation. */
export function resolveNewAutomationModelSelection(
  selection: AutomationModelSelection,
): AutomationModelSelection {
  if (selection.model?.trim()) {
    return selection;
  }
  if (
    selection.provider
    && selection.provider !== 'auto'
    && selection.provider !== 'claude'
  ) {
    return selection;
  }
  return { provider: 'claude', model: CLAUDE_MODELS.OPUS_1M };
}
