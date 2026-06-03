import { CopilotCliAdapter } from '../../cli/adapters/copilot-cli-adapter';
import { CursorCliAdapter } from '../../cli/adapters/cursor-cli-adapter';
import { getModelsForProvider } from '../../../shared/types/provider.types';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceLifecycle');

/**
 * Return the set of valid model ids for a CLI, used to reject cross-provider
 * model leakage before spawn / on model change.
 *
 * Copilot and Cursor expose their real model list only at runtime
 * (`<cli> --list-models`), and our static `PROVIDER_MODEL_LIST` entry for them
 * is just a small curated fallback. Validating against that static subset would
 * silently reset any non-curated-but-valid live model (e.g. a Cursor
 * `composer-2.5-fast`) to the provider default — so for these providers we
 * query the CLI dynamically (results are cached in the adapter), falling back to
 * the static list only when the CLI is unreachable.
 */
export async function getKnownModelsForCli(cliType: string): Promise<string[]> {
  if (cliType === 'copilot') {
    try {
      const models = await new CopilotCliAdapter().listAvailableModels();
      return models.map(model => model.id);
    } catch (error) {
      logger.warn('Falling back to static Copilot model list during validation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (cliType === 'cursor') {
    try {
      const models = await new CursorCliAdapter().listAvailableModels();
      return models.map(model => model.id);
    } catch (error) {
      logger.warn('Falling back to static Cursor model list during validation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return getModelsForProvider(cliType).map(model => model.id);
}

export function isRestoreOrReplayContinuity(config: InstanceCreateConfig): boolean {
  const hasInitialPrompt =
    typeof config.initialPrompt === 'string'
    && config.initialPrompt.trim().length > 0;
  const hasInitialContextBlock =
    typeof config.initialContextBlock === 'string'
    && config.initialContextBlock.trim().length > 0;
  const hasSeededConversation = config.initialOutputBuffer?.some(
    (message) => message.type === 'user' || message.type === 'assistant'
  ) ?? false;

  return Boolean(config.resume || hasInitialContextBlock || (hasSeededConversation && !hasInitialPrompt));
}
