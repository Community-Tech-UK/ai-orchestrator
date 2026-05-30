import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  getCliUpdatePollService,
  type CliUpdatePollService,
} from './cli-update-poll-service';
import {
  getCliUpdateService,
  isAutoApplySafe,
  type CliUpdateService,
} from './cli-update-service';
import type { CliType } from './cli-detection';
import type { CliUpdatePillEntry, CliUpdatePillState } from '../../shared/types/diagnostics.types';
import type { CliUpdatePolicy } from '../../shared/types/settings.types';

const logger = getLogger('CliAutoUpdateService');

/**
 * How long not to re-attempt the *same* `cli@version` target after we have
 * tried it once. This covers two failure modes at once:
 *  - a failed update (don't hammer a broken install/network), and
 *  - a "succeeded" update whose reported version never moved (a no-op update),
 *    which would otherwise loop forever because the poll keeps reporting the
 *    same `updateAvailable` entry.
 */
const DEFAULT_TARGET_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

export interface CliAutoUpdateServiceDeps {
  /** Current update policy. Defaults to the persisted `cliUpdatePolicy` setting. */
  getPolicy?: () => CliUpdatePolicy;
  /**
   * Number of live instances. Auto-update is skipped while any instance is
   * running so we never swap a CLI binary out from under an active session.
   * Defaults to 0 (no liveness gating) until wired via {@link CliAutoUpdateService.start}.
   */
  getActiveInstanceCount?: () => number;
  pollService?: Pick<CliUpdatePollService, 'onChange' | 'getState' | 'refresh'>;
  updateService?: Pick<CliUpdateService, 'updateOne'>;
  /** Subscribe to policy changes (so flipping to 'auto' evaluates immediately). */
  subscribePolicyChanges?: (cb: () => void) => () => void;
  now?: () => number;
  targetCooldownMs?: number;
}

/**
 * Wiring supplied at startup. The active-instance count is injected (not pulled
 * from a module accessor) because `InstanceManager` is intentionally not a
 * singleton — see the note at the bottom of instance-manager.ts. Mirrors
 * `ResourceGovernor.start({ getInstanceManager })`.
 */
export interface CliAutoUpdateStartOptions {
  getActiveInstanceCount?: () => number;
}

/**
 * Automatically applies *safe* CLI provider updates when the user opts in via
 * `cliUpdatePolicy: 'auto'`. This is the "auto-apply" layer on top of the
 * notify-only detection that the update poller already provides — t3code stops
 * at notify + one-click; this goes one step further behind an explicit setting.
 *
 * Guardrails (deliberately conservative — an unattended package install can
 * break a working setup):
 *  - Only runs when policy is exactly `'auto'`.
 *  - Only applies strategies classified safe by {@link isAutoApplySafe}
 *    (npm/bun/pnpm global installs + a CLI's own self-update). Never an
 *    unattended `brew`/`sudo`.
 *  - Never updates while any instance is running.
 *  - Serialises through the per-package-manager lock in `CliUpdateService`
 *    (so a manual "Update all" and the auto pass can't run npm concurrently).
 *  - Backs off per `cli@version` target so a failing or no-op update can't loop.
 */
export class CliAutoUpdateService {
  private static instance: CliAutoUpdateService | null = null;

  private readonly getPolicy: NonNullable<CliAutoUpdateServiceDeps['getPolicy']>;
  private getActiveInstanceCount: NonNullable<CliAutoUpdateServiceDeps['getActiveInstanceCount']>;
  private readonly pollService: NonNullable<CliAutoUpdateServiceDeps['pollService']>;
  private readonly updateService: NonNullable<CliAutoUpdateServiceDeps['updateService']>;
  private readonly subscribePolicyChanges: NonNullable<CliAutoUpdateServiceDeps['subscribePolicyChanges']>;
  private readonly now: () => number;
  private readonly targetCooldownMs: number;

  private pollUnsubscribe: (() => void) | null = null;
  private policyUnsubscribe: (() => void) | null = null;
  /** Re-entrancy guard: only one apply pass runs at a time. */
  private applying = false;
  /** `${cli}@${version}` → epoch ms until which we won't retry that target. */
  private readonly attempted = new Map<string, number>();

  constructor(deps: CliAutoUpdateServiceDeps = {}) {
    this.getPolicy = deps.getPolicy ?? defaultGetPolicy;
    this.getActiveInstanceCount = deps.getActiveInstanceCount ?? (() => 0);
    this.pollService = deps.pollService ?? getCliUpdatePollService();
    this.updateService = deps.updateService ?? getCliUpdateService();
    this.subscribePolicyChanges = deps.subscribePolicyChanges ?? defaultSubscribePolicyChanges;
    this.now = deps.now ?? Date.now;
    this.targetCooldownMs = deps.targetCooldownMs ?? DEFAULT_TARGET_COOLDOWN_MS;
  }

  static getInstance(): CliAutoUpdateService {
    if (!this.instance) {
      this.instance = new CliAutoUpdateService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  start(options: CliAutoUpdateStartOptions = {}): void {
    if (options.getActiveInstanceCount) {
      this.getActiveInstanceCount = options.getActiveInstanceCount;
    }
    if (this.pollUnsubscribe) {
      return;
    }
    this.pollUnsubscribe = this.pollService.onChange((state) => {
      void this.handleState(state);
    });
    this.policyUnsubscribe = this.subscribePolicyChanges(() => {
      void this.handleState(this.pollService.getState());
    });
    // Evaluate whatever the poller already detected before we subscribed.
    void this.handleState(this.pollService.getState());
  }

  stop(): void {
    this.pollUnsubscribe?.();
    this.pollUnsubscribe = null;
    this.policyUnsubscribe?.();
    this.policyUnsubscribe = null;
  }

  /**
   * Evaluate a pill state and, when policy allows and it is safe, apply updates.
   * Exposed (non-private) so tests can drive it directly.
   */
  async handleState(state: CliUpdatePillState): Promise<void> {
    if (this.getPolicy() !== 'auto') {
      return;
    }
    if (this.applying) {
      return;
    }

    const candidates = state.entries.filter(
      (entry) => entry.updateAvailable && isAutoApplySafe(entry.updatePlan),
    );
    if (candidates.length === 0) {
      return;
    }

    const active = this.getActiveInstanceCount();
    if (active > 0) {
      logger.info('Skipping CLI auto-update while instances are active', {
        activeInstances: active,
        pending: candidates.length,
      });
      return;
    }

    this.applying = true;
    try {
      await this.applyUpdates(candidates);
    } catch (error) {
      logger.warn('CLI auto-update pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.applying = false;
    }
  }

  private async applyUpdates(candidates: CliUpdatePillEntry[]): Promise<void> {
    let appliedAny = false;

    for (const entry of candidates) {
      const target = `${entry.cli}@${entry.latestVersion ?? '?'}`;
      const cooldownUntil = this.attempted.get(target) ?? 0;
      if (cooldownUntil > this.now()) {
        logger.info('Skipping recently-attempted CLI update target', { target });
        continue;
      }

      // Re-check liveness before each install — a session may have started
      // during a previous (potentially multi-minute) update in this pass.
      if (this.getActiveInstanceCount() > 0) {
        logger.info('Aborting remaining CLI auto-updates; an instance started');
        break;
      }

      // Mark the target attempted up-front so neither a failure nor a no-op
      // "success" (version string unchanged) can re-trigger within the cooldown.
      this.attempted.set(target, this.now() + this.targetCooldownMs);

      logger.info('Auto-updating CLI', {
        cli: entry.cli,
        from: entry.currentVersion,
        to: entry.latestVersion,
      });
      const result = await this.updateService.updateOne(entry.cli as CliType);
      if (result.status === 'updated') {
        appliedAny = true;
        logger.info('CLI auto-update applied', { cli: entry.cli, message: result.message });
      } else if (result.status === 'failed') {
        logger.warn('CLI auto-update failed; backing off this target', {
          cli: entry.cli,
          message: result.message,
        });
      }
    }

    if (appliedAny) {
      // Refresh so the pill clears and the in-memory state reflects reality.
      await this.pollService.refresh().catch(() => undefined);
    }
  }
}

function defaultGetPolicy(): CliUpdatePolicy {
  try {
    return getSettingsManager().get('cliUpdatePolicy');
  } catch {
    return 'notify';
  }
}

function defaultSubscribePolicyChanges(cb: () => void): () => void {
  try {
    const manager = getSettingsManager();
    const handler = (): void => cb();
    manager.on('setting:cliUpdatePolicy', handler);
    return () => {
      manager.off('setting:cliUpdatePolicy', handler);
    };
  } catch {
    return () => undefined;
  }
}

export function getCliAutoUpdateService(): CliAutoUpdateService {
  return CliAutoUpdateService.getInstance();
}

export function _resetCliAutoUpdateServiceForTesting(): void {
  CliAutoUpdateService._resetForTesting();
}
