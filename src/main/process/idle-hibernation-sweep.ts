import { getLogger } from '../logging/logger';
import { isAdapterOnLoan } from '../instance/lifecycle/adapter-loan-registry';
import type { InstanceStatus } from '../../shared/types/instance.types';
import type { HibernationManager } from './hibernation-manager';

const logger = getLogger('IdleHibernationSweep');

export interface IdleSweepInstance {
  id: string;
  status: InstanceStatus;
  parentId: string | null;
  lastActivity: number;
  /** True when the session executes on a remote worker node. */
  isRemote: boolean;
  displayName?: string;
}

export interface IdleHibernationSweepDeps {
  hibernation: Pick<HibernationManager, 'getConfig' | 'configure' | 'getHibernationCandidates'>;
  getInstances: () => IdleSweepInstance[];
  /** The `autoTerminateIdleMinutes` setting. 0 disables the sweep. */
  getIdleMinutes: () => number;
  hibernateInstance: (instanceId: string) => Promise<void>;
  /**
   * LT-020: a `same-session` loop borrows the root instance's adapter and the
   * instance reads `idle` between borrowed turns while the iteration is still
   * in flight. Defaults to the real loan registry; injectable for specs.
   */
  isAdapterOnLoan?: (instanceId: string) => boolean;
  /**
   * Whether a loop that has not ended (`endedAt === null`, so running, paused
   * or parked on a provider limit) uses this instance as its chat. A
   * same-session loop parked for hours leaves its chat idle; hibernating it
   * deletes the adapter and the resumed loop silently falls back to a fresh
   * one, losing the same-session continuity it was configured for.
   */
  hasLiveLoop?: (instanceId: string) => boolean;
  now?: () => number;
}

/**
 * One pass of the root-session idle sweep, driven by HibernationManager's
 * `check-idle` tick.
 *
 * Root sessions (no `parentId`) idle past the "Close idle agents after" setting
 * are hibernated: the CLI process exits, the transcript is archived, the tab
 * stays in the sidebar and the session wakes on the next send. Before this
 * sweep no idle path ever touched root sessions, so they lived until memory
 * pressure evicted them. On 2026-09-07 that left 20 idle Claude sessions, some
 * 12 hours idle, each still holding its process plus the Codex MCP server pair
 * every Claude session inherits.
 *
 * Child (helper) instances are deliberately NOT swept here. `IdleMonitor.check()`
 * already hibernates or terminates idle children on the same setting; a second
 * sweep on a separate timer raced it, and which timer won decided whether a
 * child's conversation was preserved or destroyed.
 *
 * Skipped on purpose:
 * - instances whose adapter is on loan to a same-session loop (LT-020);
 * - the chat instance of any loop that has not ended, including one parked on
 *   a provider limit awaiting resume;
 * - remote worker-node instances, whose hibernate/wake semantics through the
 *   remote adapter are not established;
 * - anything HibernationManager already filters: non-idle status, already
 *   hibernated, async-work inhibitors, the post-wake cooldown.
 *
 * The manager's idle threshold is synced from the setting so the one control
 * the user sees is the one that applies.
 */
export function runIdleHibernationSweep(deps: IdleHibernationSweepDeps): void {
  const idleMinutes = deps.getIdleMinutes();
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return;

  const thresholdMs = idleMinutes * 60_000;
  if (deps.hibernation.getConfig().idleThresholdMs !== thresholdMs) {
    deps.hibernation.configure({ idleThresholdMs: thresholdMs });
  }

  const onLoan = deps.isAdapterOnLoan ?? isAdapterOnLoan;
  const hasLiveLoop = deps.hasLiveLoop ?? (() => false);
  const now = deps.now?.() ?? Date.now();
  const byId = new Map<string, IdleSweepInstance>();
  for (const instance of deps.getInstances()) {
    if (instance.parentId) continue;
    if (instance.status !== 'idle') continue;
    if (instance.isRemote) continue;
    if (onLoan(instance.id)) continue;
    if (hasLiveLoop(instance.id)) continue;
    byId.set(instance.id, instance);
  }

  const candidates = deps.hibernation.getHibernationCandidates([...byId.values()], now);
  for (const candidate of candidates) {
    const instance = byId.get(candidate.id);
    if (!instance) continue;

    logger.info('Auto-hibernating idle root session', {
      instanceId: instance.id,
      displayName: instance.displayName,
      idleMs: now - instance.lastActivity,
      idleMinutes,
    });
    deps.hibernateInstance(instance.id).catch((err) => {
      logger.warn('Failed to hibernate idle root session', {
        instanceId: instance.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
