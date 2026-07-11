/**
 * Provider-limit park handling shared by the two turn-outcome paths that need
 * it inside InstanceCommunicationManager: the adapter's `on('error')` event,
 * and a thrown `sendInput()` rejection (the Codex app-server path — it fails
 * a throttled turn by rejecting the promise rather than emitting `'error'`,
 * so the event hook never fires for it).
 *
 * Extracted out of instance-communication.ts to keep that file within its
 * size ceiling (`npm run check:ts-max-loc`) — mirrors why detection logic
 * already lives in instance-provider-limit-detection.ts.
 */

import { generateId } from '../../shared/utils/id-generator';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { ContextUsage, Instance, OutputMessage } from '../../shared/types/instance.types';
import { detectErrorProviderLimit, readAdapterRateLimitTelemetry } from './instance-provider-limit-detection';

export interface TryParkOnProviderLimitDeps {
  onProviderLimitTurn?: (params: {
    instanceId: string;
    resetAtHint: number | null;
    reason: string;
    resumePrompt: string | null;
  }) => 'parked' | 'already-parked' | 'skipped';
  getResumePrompt: (instanceId: string) => string | null;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  emitOutput: (instanceId: string, message: OutputMessage) => void;
  transitionInstanceStatus: (instance: Instance, status: 'idle') => void;
  queueUpdate: (instanceId: string, status: 'idle', contextUsage?: ContextUsage) => void;
}

/**
 * Attempt to park a regular session on a provider rate/usage limit. Returns
 * `true` when the turn was handled — parked fresh, or a send arrived while
 * already parked — and the caller should stop instead of surfacing a normal
 * error.
 */
export function tryParkOnProviderLimit(
  deps: TryParkOnProviderLimitDeps,
  instanceId: string,
  instance: Instance,
  adapter: CliAdapter,
  error: unknown,
  errorMessage: string,
): boolean {
  if (!deps.onProviderLimitTurn) return false;

  const signal = detectErrorProviderLimit(error, errorMessage, readAdapterRateLimitTelemetry(adapter));
  if (!signal) return false;

  const outcome = deps.onProviderLimitTurn({
    instanceId,
    resetAtHint: signal.resetAtHint,
    reason: signal.reason,
    resumePrompt: deps.getResumePrompt(instanceId),
  });
  if (outcome === 'skipped') return false;

  if (outcome === 'parked') {
    const parkMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Provider limit reached. This session is parked and will resume automatically when the quota window resets.',
      metadata: { providerLimitParked: true },
    };
    deps.addToOutputBuffer(instance, parkMessage);
    deps.emitOutput(instanceId, parkMessage);
    if (instance.status !== 'respawning' && instance.status !== 'interrupting' && instance.status !== 'cancelling') {
      deps.transitionInstanceStatus(instance, 'idle');
      deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
    }
    return true;
  }

  // 'already-parked': a turn arrived (e.g. via mobile gateway, MCP, or a
  // remote node — paths that bypass the renderer's quota-park gate) while
  // the instance is still parked. Acknowledge quietly; don't duplicate the
  // park message or touch status.
  const stillParkedMessage: OutputMessage = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content: 'Still parked until the quota window resets; this message was not sent.',
    metadata: { providerLimitParked: true, alreadyParked: true },
  };
  deps.addToOutputBuffer(instance, stillParkedMessage);
  deps.emitOutput(instanceId, stillParkedMessage);
  return true;
}
