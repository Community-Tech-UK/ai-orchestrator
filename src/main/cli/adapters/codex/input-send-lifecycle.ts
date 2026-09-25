import type { InstanceStatus, OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { isProviderNotice } from '../../provider-notice';
import { isSurfacedToUserError } from '../surfaced-error';
import { isActiveTurnCollision } from './orchestration-response-send';

interface CodexInputSendLifecycleDeps {
  isSpawned(): boolean;
  isAppServerMode(): boolean;
  hasAppServerClient(): boolean;
  hasActiveTurn(): boolean;
  isProviderCompacting(): boolean;
  isRecoverableTurnError(error: unknown): boolean;
  sendAppServer(): Promise<void>;
  sendExec(): Promise<void>;
  emitStatus(status: InstanceStatus): void;
  emitOutput(message: OutputMessage): void;
}

/** Owns the outer send lifecycle without masking live provider work as idle. */
export async function runCodexInputSend(deps: CodexInputSendLifecycleDeps): Promise<void> {
  if (!deps.isSpawned()) throw new Error('Adapter not spawned - call spawn() first');
  deps.emitStatus('busy');
  try {
    if (deps.isAppServerMode() && deps.hasAppServerClient()) await deps.sendAppServer();
    else await deps.sendExec();
    deps.emitStatus(deps.isProviderCompacting() ? 'busy' : 'idle');
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    if (!isActiveTurnCollision(error) && !isSurfacedToUserError(error)) deps.emitOutput({
      id: generateId(), timestamp: Date.now(), type: 'error', content: `Codex error: ${errorText}`,
    });
    const recoverable = !deps.isAppServerMode()
      || isProviderNotice(errorText)
      || deps.isRecoverableTurnError(error);
    const activeProviderWork = deps.isAppServerMode()
      && (deps.hasActiveTurn() || deps.isProviderCompacting());
    deps.emitStatus(recoverable ? (activeProviderWork ? 'busy' : 'idle') : 'error');
    throw error;
  }
}
