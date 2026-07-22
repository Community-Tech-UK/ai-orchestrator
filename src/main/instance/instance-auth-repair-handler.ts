/**
 * In-session auth repair.
 *
 * When a turn fails because the provider signed us out, the instance still goes
 * to `error` and the raw message still reaches the transcript — nothing is
 * hidden. On top of that this handler marks the instance with an
 * `auth-required` waitReason so the composer can offer a repair, and watches
 * for the user signing back in so the interrupted turn resumes itself.
 *
 * Mirrors the shape of {@link ./instance-provider-limit-handler} (park →
 * external condition clears → revive + re-send), but keyed on a live auth probe
 * instead of a quota reset time.
 */

import type { InstanceProvider, InstanceWaitReason } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import {
  canProbeProviderAuth,
  probeProviderAuth,
  type ProviderAuthState,
} from '../providers/provider-auth-status';

const logger = getLogger('InstanceAuthRepairHandler');

/** How often a blocked session re-checks whether the user has signed back in. */
export const AUTH_RECHECK_INTERVAL_MS = 10_000;

/**
 * How long to keep watching before giving up. The banner stays (with its manual
 * "Retry now"); only the background polling stops, so a session left overnight
 * doesn't probe the CLI forever.
 */
export const AUTH_WATCH_TIMEOUT_MS = 15 * 60_000;

export interface InstanceAuthRepairDeps {
  /** Set/clear the auth-required waitReason so the renderer shows the banner. */
  setWaitReason: (instanceId: string, waitReason: InstanceWaitReason | null) => void;
  /**
   * Bring the session back to a state that can accept input. Resolves to the
   * live instance id (revival may not preserve it), or null when the session
   * cannot be revived.
   */
  revive: (instanceId: string) => Promise<string | null>;
  /** Re-send the interrupted user turn. */
  resendInput: (instanceId: string, prompt: string) => void;
  /** Injectable for tests; defaults to the real CLI probe. */
  probeAuth?: (provider: InstanceProvider) => Promise<ProviderAuthState>;
  /** Injectable timers for tests. */
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface MaybeBlockOnAuthParams {
  instanceId: string;
  provider: InstanceProvider;
  reason: string;
  /** The user turn to re-send once auth is repaired; null when unknown. */
  resumePrompt: string | null;
}

export type AuthRetryOutcome =
  | { status: 'resumed' }
  | { status: 'still-signed-out' }
  | { status: 'unknown'; message: string }
  | { status: 'not-blocked' };

interface BlockedEntry {
  provider: InstanceProvider;
  resumePrompt: string | null;
  since: number;
  stopWatch: () => void;
}

export class InstanceAuthRepairHandler {
  private static instance: InstanceAuthRepairHandler | null = null;
  private deps: InstanceAuthRepairDeps | null = null;
  private readonly blocked = new Map<string, BlockedEntry>();
  /** Guards against two concurrent resumes of the same instance. */
  private readonly resuming = new Set<string>();

  static getInstance(): InstanceAuthRepairHandler {
    if (!this.instance) {
      this.instance = new InstanceAuthRepairHandler();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.clearAll();
    this.instance = null;
  }

  configure(deps: InstanceAuthRepairDeps): void {
    this.deps = deps;
  }

  isBlocked(instanceId: string): boolean {
    return this.blocked.has(instanceId);
  }

  /**
   * Marks an instance as blocked on provider auth, after confirming with a live
   * probe where one exists. Returns `'skipped'` when the probe says we are
   * still signed in — the failure was something else wearing auth-shaped words.
   */
  async maybeBlockOnAuth(
    params: MaybeBlockOnAuthParams,
  ): Promise<'blocked' | 'already-blocked' | 'skipped'> {
    const deps = this.deps;
    if (!deps) return 'skipped';

    if (canProbeProviderAuth(params.provider)) {
      const state = await this.probe(params.provider);
      // `unknown` (probe could not run) is not proof of a sign-out, but the
      // turn already failed with auth-shaped text, so trust the text. Only a
      // positive "still authenticated" vetoes the block.
      if (state === 'authenticated') {
        logger.info('Ignoring auth-shaped turn failure: the provider still reports authenticated', {
          instanceId: params.instanceId,
          provider: params.provider,
        });
        return 'skipped';
      }
    }

    const existing = this.blocked.get(params.instanceId);
    if (existing) {
      // Keep the earliest prompt: it is the turn the user actually lost.
      return 'already-blocked';
    }

    const since = Date.now();
    deps.setWaitReason(params.instanceId, {
      kind: 'auth-required',
      provider: params.provider,
      since,
    });
    this.blocked.set(params.instanceId, {
      provider: params.provider,
      resumePrompt: params.resumePrompt,
      since,
      stopWatch: this.startWatch(params.instanceId, params.provider),
    });
    logger.info('Session blocked on provider auth; watching for sign-in', {
      instanceId: params.instanceId,
      provider: params.provider,
      reason: params.reason,
      watched: canProbeProviderAuth(params.provider),
    });
    return 'blocked';
  }

  /**
   * User pressed "Retry now": probe immediately and resume on success. Reports
   * what happened so the banner can say something truthful rather than
   * silently doing nothing.
   */
  async retryNow(instanceId: string): Promise<AuthRetryOutcome> {
    const entry = this.blocked.get(instanceId);
    if (!entry) return { status: 'not-blocked' };

    const state = await this.probe(entry.provider);
    if (state === 'authenticated') {
      if (await this.resume(instanceId)) {
        return { status: 'resumed' };
      }
      return {
        status: 'unknown',
        message: 'Signed in, but this session could not be restored. Restart it to continue.',
      };
    }
    if (state === 'unauthenticated') {
      return { status: 'still-signed-out' };
    }
    return {
      status: 'unknown',
      message: `Could not read ${entry.provider} auth status. Finish signing in, then try again.`,
    };
  }

  /** Dismiss the banner without resuming (also stops the background watch). */
  cancel(instanceId: string): boolean {
    const entry = this.blocked.get(instanceId);
    if (!entry) return false;
    this.blocked.delete(instanceId);
    entry.stopWatch();
    this.deps?.setWaitReason(instanceId, null);
    logger.info('Cleared auth-required block without resuming', { instanceId });
    return true;
  }

  /** Drop all state for an instance (termination, restart). */
  forget(instanceId: string): void {
    const entry = this.blocked.get(instanceId);
    if (!entry) return;
    this.blocked.delete(instanceId);
    entry.stopWatch();
  }

  private clearAll(): void {
    for (const entry of this.blocked.values()) {
      entry.stopWatch();
    }
    this.blocked.clear();
    this.resuming.clear();
  }

  private async probe(provider: InstanceProvider): Promise<ProviderAuthState> {
    const probeAuth = this.deps?.probeAuth ?? probeProviderAuth;
    try {
      return await probeAuth(provider);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Polls for the user signing back in. Providers without a probe get no
   * watcher — their banner is manual-retry only, which is honest about what
   * the app can actually detect.
   */
  private startWatch(instanceId: string, provider: InstanceProvider): () => void {
    if (!canProbeProviderAuth(provider)) {
      return () => { /* nothing to stop */ };
    }

    const setTimer = this.deps?.setInterval ?? setInterval;
    const clearTimer = this.deps?.clearInterval ?? clearInterval;
    const startedAt = Date.now();
    let checking = false;

    const handle = setTimer(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          if (Date.now() - startedAt >= AUTH_WATCH_TIMEOUT_MS) {
            logger.info('Stopped watching for sign-in after the timeout; banner retry still works', {
              instanceId,
              provider,
            });
            this.blocked.get(instanceId)?.stopWatch();
            return;
          }
          if (await this.probe(provider) === 'authenticated') {
            await this.resume(instanceId);
          }
        } finally {
          checking = false;
        }
      })();
    }, AUTH_RECHECK_INTERVAL_MS);

    // Never hold the event loop open for a background poll.
    (handle as unknown as { unref?: () => void }).unref?.();

    return () => clearTimer(handle);
  }

  /**
   * Auth is back: revive the session and re-send the turn it lost. The instance
   * went to `error` when the turn failed, so a plain re-send would be rejected
   * — revival restores it first.
   */
  private async resume(instanceId: string): Promise<boolean> {
    const deps = this.deps;
    const entry = this.blocked.get(instanceId);
    if (!deps || !entry) return false;
    if (this.resuming.has(instanceId)) return false;
    this.resuming.add(instanceId);

    try {
      const liveId = await deps.revive(instanceId);
      if (!liveId) {
        // Keep the block (and the banner) so the user still has a lever —
        // clearing it here would leave a dead session with no affordance and
        // a silently dropped turn.
        logger.warn('Auth restored but the session could not be revived; keeping the repair banner', {
          instanceId,
        });
        return false;
      }

      this.blocked.delete(instanceId);
      entry.stopWatch();
      deps.setWaitReason(instanceId, null);

      if (entry.resumePrompt) {
        deps.resendInput(liveId, entry.resumePrompt);
        logger.info('Resumed session after the user signed back in', {
          instanceId,
          liveId,
          provider: entry.provider,
        });
      } else {
        logger.info('Auth restored; session revived with no turn to re-send', { instanceId });
      }
      return true;
    } catch (error) {
      logger.warn('Auth-repair resume failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.resuming.delete(instanceId);
    }
  }
}

export function getInstanceAuthRepairHandler(): InstanceAuthRepairHandler {
  return InstanceAuthRepairHandler.getInstance();
}

export function _resetInstanceAuthRepairHandlerForTesting(): void {
  InstanceAuthRepairHandler._resetForTesting();
}
