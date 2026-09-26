/**
 * Session usage-overage stop wiring (the "never ride paid overage" policy for
 * regular sessions).
 *
 * When a provider's live CLI telemetry says the subscription window is refused
 * (`status: 'rejected'` — e.g. the Claude 5-hour limit) or paid overage is
 * being consumed (`isUsingOverage`), every further request is billed at
 * API-priced overage/credits. A session left running through that state
 * silently spends real money — including the LLM calls its own hooks fire per
 * turn. Loops already refuse this (`loop-quota-throttle`'s overage-guard +
 * `loopAllowProviderOverage`, default off); this closes the same hole for
 * interactive sessions.
 *
 * On the signal the guard:
 *   1. interrupts any in-flight turn (its remaining requests are overage), and
 *   2. holds the session on a provider-limit park until the window resets.
 *
 * The hold is unconditional — a silent money burn must stop even when the
 * (spend-oriented) auto-resume feature `instanceProviderLimitResumeEnabled` is
 * off; that setting still governs whether the parked session re-sends on its
 * own at the reset. `sessionAllowProviderOverage` (default off) opts out of
 * the whole guard.
 *
 * Modeled on `instance-tool-loop-wiring.ts`: `InstanceManager` configures the
 * deps once; `ProviderRuntimeService.createAdapter` attaches per adapter (next
 * to the account-pool telemetry bridge), so ordinary sessions are covered
 * without touching `instance-communication.ts`. This module holds no state of
 * its own beyond the configured deps.
 */

import type { CliRateLimitInfo } from '../../shared/types/cli.types';
import type { ProviderLimitTurnSignal } from './instance-provider-limit-detection';
import { detectUsageOverageStop } from './instance-provider-limit-detection';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceUsageOverageWiring');

/** Minimal seam `InstanceManager` exposes to this wiring. */
export interface UsageOverageStopDeps {
  /** Current value of the `sessionAllowProviderOverage` setting (default off). */
  getAllowOverageSetting(): boolean;
  /** Delegates to `InstanceManager.interruptInstance(instanceId, 'usage-overage')`. */
  interruptInstance(instanceId: string): boolean;
  /**
   * Hold the session on the provider-limit park machinery (durable gate +
   * waitReason + parked entry). Implementations resolve the instance's
   * provider/model/account themselves.
   */
  holdOnUsageLimit(instanceId: string, signal: ProviderLimitTurnSignal): void;
}

let configuredDeps: UsageOverageStopDeps | null = null;

export function configureUsageOverageStop(deps: UsageOverageStopDeps): void {
  configuredDeps = deps;
}

export function resetUsageOverageStopForTesting(): void {
  configuredDeps = null;
}

/** Adapter surface this guard needs; satisfied by every CLI adapter. */
export type UsageOverageGuardAdapter = {
  on(event: 'rate-limit-telemetry', listener: (info: CliRateLimitInfo) => void): unknown;
  off(event: 'rate-limit-telemetry', listener: (info: CliRateLimitInfo) => void): unknown;
};

/**
 * Subscribe one adapter's live rate-limit telemetry to the overage stop.
 * No-op without configured deps (tests, worker contexts). Returns teardown.
 */
export function attachUsageOverageStopGuard(
  adapter: UsageOverageGuardAdapter,
  instanceId: string,
): () => void {
  const deps = configuredDeps;
  if (!deps) return () => undefined;

  const onTelemetry = (info: CliRateLimitInfo): void => {
    let signal: ProviderLimitTurnSignal | null = null;
    try {
      signal = detectUsageOverageStop(info, {
        allowOverage: deps.getAllowOverageSetting() === true,
      });
    } catch (err) {
      logger.debug('Usage-overage detection threw; leaving the session alone', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!signal) return;

    // Stop the in-flight burn first (interrupt is a no-op on a settled
    // instance), then hold the session so no further turn is dispatched.
    try {
      deps.interruptInstance(instanceId);
    } catch (err) {
      logger.warn('Usage-overage interrupt failed; holding the session anyway', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      deps.holdOnUsageLimit(instanceId, signal);
      logger.info('Stopped session on usage-overage telemetry', {
        instanceId,
        reason: signal.reason,
        resetAtHint: signal.resetAtHint,
      });
    } catch (err) {
      logger.warn('Usage-overage hold failed', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  adapter.on('rate-limit-telemetry', onTelemetry);
  return () => {
    adapter.off('rate-limit-telemetry', onTelemetry);
  };
}
