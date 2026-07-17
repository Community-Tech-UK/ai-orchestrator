import type { Automation } from '../../shared/types/automation.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { snapshotShowsLimitLifted } from '../instance/instance-provider-limit-handler';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderLimitResumeReconciler');

/**
 * Probe cadence while pending resume automations exist. Mirrors the in-park
 * early-resume probe (instance-provider-limit-handler EARLY_RESUME_PROBE_MS).
 */
export const RESUME_RECONCILE_INTERVAL_MS = 3 * 60_000;

/** Let providers/CLI detection settle before the first post-boot probe. */
export const RESUME_RECONCILE_INITIAL_DELAY_MS = 15_000;

/** Skip candidates the scheduler is about to fire anyway. */
const IMMINENT_FIRE_MS = 60_000;

export interface ProviderLimitResumeReconcilerDeps {
  listAutomations: () => Promise<Automation[]>;
  /** Fire the automation now; routed through AutomationRunner.fire. */
  fire: (automation: Automation, provider: ProviderId) => Promise<unknown>;
  /** Live quota probe (ProviderQuotaService.refresh). */
  probeQuota: (provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>;
  now?: () => number;
}

/**
 * A parked session's durable resume automation only knows the reset time the
 * provider reported at park time. The in-memory park re-probes live quota every
 * few minutes and resumes early when the limit lifts (reset credits applied,
 * extra quota purchased) — but that probe dies with the process. After an app
 * restart the orphaned automation would otherwise sit until its recorded
 * wall-clock fire time, which for a weekly window can be days after the limit
 * actually lifted (seen live 2026-07-15: codex weekly limit, sessions wedged
 * until 21 Jul while quota was free from the 16th).
 *
 * This reconciler is the durable counterpart of that in-park probe: while any
 * pending `instanceProviderLimitResume` automation exists, probe the provider's
 * live quota and fire the automation immediately once every window shows
 * headroom. Firing routes through the normal system-action dispatch, which
 * de-dupes against a live park and falls back to thread revive for a dead
 * instance, so an early fire is always safe. If the provider is in fact still
 * limited, the re-sent turn re-parks with a fresh reset time — a wrong lift
 * costs one rejected request.
 */
export async function reconcileProviderLimitResumeAutomations(
  deps: ProviderLimitResumeReconcilerDeps,
): Promise<number> {
  const now = deps.now?.() ?? Date.now();

  let automations: Automation[];
  try {
    automations = await deps.listAutomations();
  } catch (err) {
    logger.warn('Failed to list automations for provider-limit resume reconcile', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const candidates = automations.filter((a) => isPendingResumeAutomation(a, now));
  if (candidates.length === 0) return 0;

  const byProvider = new Map<ProviderId, Automation[]>();
  for (const automation of candidates) {
    const provider = resumeProvider(automation);
    if (!provider) continue;
    const group = byProvider.get(provider) ?? [];
    group.push(automation);
    byProvider.set(provider, group);
  }

  let fired = 0;
  for (const [provider, group] of byProvider) {
    let snapshot: ProviderQuotaSnapshot | null;
    try {
      snapshot = await deps.probeQuota(provider);
    } catch {
      continue; // probe failure proves nothing — retry next tick
    }
    if (!snapshotShowsLimitLifted(snapshot)) continue;

    for (const automation of group) {
      try {
        await deps.fire(automation, provider);
        fired++;
        logger.info('Provider limit lifted early; fired pending resume automation ahead of schedule', {
          automationId: automation.id,
          provider,
          scheduledRunAt: automation.schedule.type === 'oneTime' ? automation.schedule.runAt : null,
        });
      } catch (err) {
        logger.warn('Failed to early-fire provider-limit resume automation', {
          automationId: automation.id,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return fired;
}

// Deliberately instance-only: `loopProviderLimitResume` automations are also
// created for *scheduled wakeups* (source 'wakeup'), whose future fire time is
// intentional and unrelated to quota — the record carries no field to tell the
// two apart, so early-firing them on a quota probe would wake loops early.
function isPendingResumeAutomation(automation: Automation, now: number): boolean {
  return (
    automation.enabled
    && automation.active
    && automation.schedule.type === 'oneTime'
    && automation.schedule.runAt - now > IMMINENT_FIRE_MS
    && automation.action.systemAction?.type === 'instanceProviderLimitResume'
  );
}

function resumeProvider(automation: Automation): ProviderId | null {
  const provider = automation.action.provider;
  return provider && provider !== 'auto' ? provider : null;
}

/**
 * Arm the periodic reconcile (first pass after a short boot delay, then every
 * {@link RESUME_RECONCILE_INTERVAL_MS}). Timers are unref'd. Returns a stopper.
 */
export function startProviderLimitResumeReconciler(
  deps: ProviderLimitResumeReconcilerDeps,
  opts: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void reconcileProviderLimitResumeAutomations(deps)
      .catch((err) => {
        logger.warn('Provider-limit resume reconcile tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const initial = setTimeout(tick, opts.initialDelayMs ?? RESUME_RECONCILE_INITIAL_DELAY_MS);
  initial.unref?.();
  const interval = setInterval(tick, opts.intervalMs ?? RESUME_RECONCILE_INTERVAL_MS);
  interval.unref?.();

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
