/**
 * WarmStartManager — pre-spawns one CLI process for fast next-instance creation.
 *
 * After a user creates an instance for provider X, this manager pre-spawns one
 * replacement process for provider X in the background. When the next
 * createInstance() for that provider is called, the warm process is handed off
 * instead of spawning fresh (saves 100–500 ms).
 *
 * At most ONE warm process is held at a time.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('WarmStartManager');

/** How long a warm process stays alive before it is automatically expired. */
const WARM_PROCESS_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface WarmProcess {
  provider: string;
  adapter: unknown;
  workingDirectory: string;
  createdAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface WarmStartDeps {
  spawnAdapter: (provider: string, options: { workingDirectory: string }) => Promise<unknown>;
  killAdapter: (adapter: unknown) => Promise<void>;
}

export class WarmStartManager {
  private warm: WarmProcess | null = null;
  private enabled = true;

  constructor(private readonly deps: WarmStartDeps) {}

  /**
   * Pre-spawn a warm process for the given provider and working directory.
   *
   * If a warm process already exists it is killed first (replaced).
   * If the manager is disabled this is a no-op.
   * Spawn failures are logged as warnings and do not propagate.
   */
  async preWarm(provider: string, workingDirectory: string): Promise<void> {
    if (!this.enabled) {
      logger.debug('preWarm skipped — manager is disabled', { provider });
      return;
    }

    // Kill any existing warm process before replacing it.
    if (this.warm) {
      await this.killCurrent('replaced by new preWarm');
    }

    logger.debug('Pre-warming process', { provider, workingDirectory });

    let adapter: unknown;
    try {
      adapter = await this.deps.spawnAdapter(provider, { workingDirectory });
    } catch (err) {
      logger.warn('Failed to pre-warm process', err instanceof Error ? err : undefined, {
        provider,
        workingDirectory,
      });
      return;
    }

    const expiryTimer = setTimeout(() => {
      this.expire();
    }, WARM_PROCESS_TTL_MS);

    // Allow the timer to be garbage-collected without blocking the Node.js
    // event loop from exiting (relevant in tests with fake timers too).
    if (typeof expiryTimer === 'object' && expiryTimer !== null && 'unref' in expiryTimer) {
      (expiryTimer as ReturnType<typeof setTimeout> & { unref(): void }).unref();
    }

    this.warm = {
      provider,
      adapter,
      workingDirectory,
      createdAt: Date.now(),
      expiryTimer,
    };

    logger.info('Warm process ready', { provider, workingDirectory });
  }

  /**
   * Consume the warm process if it matches `provider`.
   *
   * Returns the opaque adapter handle on a match (and clears the warm slot).
   * Returns null when there is no warm process or the provider does not match
   * (the warm process is retained in the mismatch case).
   */
  consume(provider: string): unknown | null {
    if (!this.warm) {
      return null;
    }

    if (this.warm.provider !== provider) {
      logger.debug('Warm process provider mismatch — keeping warm process', {
        wanted: provider,
        have: this.warm.provider,
      });
      return null;
    }

    const { adapter, expiryTimer } = this.warm;
    clearTimeout(expiryTimer);
    this.warm = null;

    logger.info('Consumed warm process', { provider });
    return adapter;
  }

  /**
   * Returns true when a warm process exists for the given provider.
   */
  hasWarm(provider: string): boolean {
    return this.warm !== null && this.warm.provider === provider;
  }

  /**
   * Enable or disable warm-start behaviour.
   *
   * Disabling immediately cleans up the current warm process if one exists.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    if (!enabled && this.warm) {
      // Fire-and-forget — caller does not need to await cleanup.
      this.killCurrent('manager disabled').catch((err: unknown) => {
        logger.warn(
          'Error killing warm process on disable',
          err instanceof Error ? err : undefined,
        );
      });
    }
  }

  /**
   * Kill the current warm process if one exists.
   *
   * Safe to call when there is no warm process (no-op).
   */
  async cleanup(): Promise<void> {
    if (!this.warm) {
      return;
    }
    await this.killCurrent('cleanup called');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Called by the expiry timer after WARM_PROCESS_TTL_MS. */
  private expire(): void {
    if (!this.warm) {
      return;
    }

    logger.info('Warm process expired — killing', {
      provider: this.warm.provider,
      ageMs: Date.now() - this.warm.createdAt,
    });

    this.killCurrent('TTL expired').catch((err: unknown) => {
      logger.warn(
        'Error killing expired warm process',
        err instanceof Error ? err : undefined,
      );
    });
  }

  /**
   * Kill the current warm process and clear the slot.
   * Assumes `this.warm` is non-null.
   */
  private async killCurrent(reason: string): Promise<void> {
    if (!this.warm) {
      return;
    }

    const { adapter, expiryTimer, provider } = this.warm;
    clearTimeout(expiryTimer);
    this.warm = null;

    logger.debug('Killing warm process', { provider, reason });
    try {
      await this.deps.killAdapter(adapter);
    } catch (err) {
      logger.warn(
        'Error while killing warm process',
        err instanceof Error ? err : undefined,
        { provider, reason },
      );
    }
  }
}
