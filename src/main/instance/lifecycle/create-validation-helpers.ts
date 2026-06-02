import { CopilotCliAdapter } from '../../cli/adapters/copilot-cli-adapter';
import { getModelsForProvider } from '../../../shared/types/provider.types';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceLifecycle');

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
