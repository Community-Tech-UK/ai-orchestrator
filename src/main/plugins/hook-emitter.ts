import { getLogger } from '../logging/logger';
import { getOrchestratorPluginManager } from './plugin-manager';
import type { PluginHookEvent, PluginHookPayloads } from '../../shared/types/plugin.types';

const logger = getLogger('PluginHookEmitter');

export function emitPluginHook<K extends PluginHookEvent>(
  event: K,
  payload: PluginHookPayloads[K],
): void {
  getOrchestratorPluginManager().emitHook(event, payload).catch((error: unknown) => {
    logger.warn('Plugin hook emission failed', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
