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
import type { CommunicationDependencies } from './instance-communication.types';
import { detectErrorProviderLimit, readAdapterRateLimitTelemetry } from './instance-provider-limit-detection';
import { collectUsageLimitHandling } from '../cli/usage-limit-dispatch';
import type { UsageLimitHandling } from '../cli/usage-limit-notice';
import { announceUsageLimit } from './instance-usage-limit-announcement';

export interface TryParkOnProviderLimitDeps {
  onProviderLimitTurn?: (params: {
    instanceId: string;
    resetAtHint: number | null;
    quotaBlind?: boolean;
    reason: string;
    resumePrompt: string | null;
  }) => 'parked' | 'already-parked' | 'skipped' | 'switching-account';
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
 *
 * The user is told once per refused window. The limit handler reports what it did while it runs, the
 * note says so in the shared usage-limit wording, and a window the transcript already holds a note for
 * (the Claude adapter's, or the stop's) is not announced a second time. Status handling is unchanged.
 */
export function tryParkOnProviderLimit(
  deps: TryParkOnProviderLimitDeps,
  instanceId: string,
  instance: Instance,
  adapter: CliAdapter,
  error: unknown,
  errorMessage: string,
): boolean {
  const onProviderLimitTurn = deps.onProviderLimitTurn;
  if (!onProviderLimitTurn) return false;

  const signal = detectErrorProviderLimit(error, errorMessage, readAdapterRateLimitTelemetry(adapter), instance.provider);
  if (!signal) return false;

  const resumePrompt = deps.getResumePrompt(instanceId);
  const { result: outcome, handling } = collectUsageLimitHandling(instance.provider, () => onProviderLimitTurn({
    instanceId,
    resetAtHint: signal.resetAtHint,
    quotaBlind: signal.quotaBlind,
    reason: signal.reason,
    resumePrompt,
  }));
  if (outcome === 'skipped') return false;

  const say = (what: UsageLimitHandling): void => {
    if (instance.provider === 'auto') return;
    announceUsageLimit((id, content, metadata) => {
      const note: OutputMessage = { id: generateId(), timestamp: Date.now(), type: 'system', content, metadata };
      deps.addToOutputBuffer(instance, note);
      deps.emitOutput(id, note);
    }, {
      instanceId,
      provider: instance.provider,
      accountProfileId: instance.accountProfileId,
      ...(signal.resetAtHint !== null ? { resetAt: signal.resetAtHint } : {}),
      reason: signal.reason,
      handling: what,
      transcript: instance.outputBuffer,
    });
  };
  const settleIdle = (): void => {
    if (instance.status !== 'respawning' && instance.status !== 'interrupting' && instance.status !== 'cancelling') {
      deps.transitionInstanceStatus(instance, 'idle');
      deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
    }
  };

  if (outcome === 'switching-account') {
    say({ kind: 'switching', metadata: { accountFailover: true } });
    settleIdle();
    return true;
  }

  if (outcome === 'parked') {
    // Without a report (a handler that did not say) claim only what is certainly true: nothing was sent.
    say(handling ?? { kind: 'parked', autoResume: false, heldMessage: Boolean(resumePrompt), metadata: { providerLimitParked: true } });
    settleIdle();
    return true;
  }

  // 'already-parked': a turn arrived (e.g. via mobile gateway, MCP, or a
  // remote node — paths that bypass the renderer's quota-park gate) while
  // the instance is still parked. When the park's own note is in the
  // transcript there is nothing to add; otherwise say the message was not
  // sent. Never touches status.
  say({ kind: 'parked', autoResume: false, heldMessage: true, metadata: { providerLimitParked: true, alreadyParked: true } });
  return true;
}

/** Applies Claude's interactive planning hint without affecting automated turns. */
export function applyPlanModeTurnHint(
  instance: Instance,
  message: string,
  isAutoContinuation: boolean,
): string {
  if (isAutoContinuation || instance.provider !== 'claude') return message;
  if (!instance.planMode.enabled || instance.planMode.state !== 'planning') return message;
  return /\bultrathink\b/i.test(message) ? message : `ultrathink\n\n${message}`;
}

/** Returns true when an active durable limit has taken ownership of the turn. */
export function shouldSkipKnownProviderLimitDispatch(
  check: CommunicationDependencies['checkKnownProviderLimitBeforeSend'],
  params: NonNullable<Parameters<NonNullable<CommunicationDependencies['checkKnownProviderLimitBeforeSend']>>[0]>,
): boolean {
  const outcome = check?.(params);
  return outcome === 'parked' || outcome === 'already-parked' || outcome === 'switching-account';
}
