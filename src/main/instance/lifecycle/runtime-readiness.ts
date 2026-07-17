/**
 * RuntimeReadinessCoordinator
 *
 * Isolates lifecycle readiness checks that decide whether a spawned adapter is
 * usable, whether native resume actually stabilized, and whether stdin can
 * accept the next input.
 */

import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { AdapterRuntimeCapabilities } from '../../cli/adapters/base-cli-adapter';
import type { ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter.types';
import { getLogger } from '../../logging/logger';
import { observeAdapterRuntimeEvents } from '../../providers/adapter-runtime-event-bridge';
import type { Instance } from '../../../shared/types/instance.types';
import { isSessionNotFoundText } from '../../cli/adapters/resume-error-classifier';
import { getSystemLoadMonitor } from '../../runtime/system-load-monitor';

const logger = getLogger('RuntimeReadiness');

/**
 * Outcome of a native-resume health probe.
 * - `healthy`: the resumed session proved (or is quietly writable) — keep it.
 * - `unrecoverable`: definitively dead (process exit, session-not-found, or a
 *   confirmed wrong/fresh session) — the caller may destroy and fresh-spawn.
 * - `inconclusive`: still alive but unproven after the (load-scaled) window —
 *   NOT a reason to destroy the session; the caller should retry then proceed.
 */
export type ResumeHealthVerdict = 'healthy' | 'unrecoverable' | 'inconclusive';

const DEFAULT_RUNTIME_CAPABILITIES: AdapterRuntimeCapabilities = {
  supportsResume: false,
  supportsForkSession: false,
  supportsNativeCompaction: false,
  supportsPermissionPrompts: false,
  supportsDeferPermission: false,
  selfManagedAutoCompaction: false,
};

export interface RuntimeReadinessDeps {
  getInstance: (instanceId: string) => Pick<Instance, 'processId' | 'status'> | undefined;
  getAdapter: (instanceId: string) => CliAdapter | undefined;
  /**
   * Watchdog load multiplier (>= 1) used to stretch the resume-health window
   * while the host is oversubscribed. Injectable for tests; defaults to the
   * shared SystemLoadMonitor.
   */
  getResumeHealthLoadMultiplier?: () => number;
}

export class RuntimeReadinessCoordinator {
  constructor(private readonly deps: RuntimeReadinessDeps) {}

  getAdapterRuntimeCapabilities(adapter?: CliAdapter): AdapterRuntimeCapabilities {
    if (
      adapter &&
      'getRuntimeCapabilities' in adapter &&
      typeof adapter.getRuntimeCapabilities === 'function'
    ) {
      return adapter.getRuntimeCapabilities();
    }

    return { ...DEFAULT_RUNTIME_CAPABILITIES };
  }

  private getResumeHealthLoadMultiplier(): number {
    const raw = this.deps.getResumeHealthLoadMultiplier?.()
      ?? getSystemLoadMonitor().getWatchdogMultiplier();
    return Number.isFinite(raw) && raw > 1 ? raw : 1;
  }

  /**
   * Probe whether a just-spawned CLI accepted native resume, returning a
   * three-way verdict instead of a lossy boolean.
   *
   * Positive (`healthy`): definitive provider resume proof, any normalized
   * output event, or a writable quiet Claude stream. Both Codex app-server and
   * Claude can accept resume without emitting output until the next message.
   * Negative (`unrecoverable`): process liveness failure, a session-not-found
   * error, or a confirmed wrong/fresh session.
   * `inconclusive`: alive but unproven after the load-scaled window — the host
   * may simply be slow; the caller must not destroy the session over this.
   *
   * The window is stretched by the watchdog load multiplier so a
   * starved-but-healthy resume is not misread as a failure.
   */
  async evaluateResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200,
  ): Promise<ResumeHealthVerdict> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!this.isLive(instanceId, adapter)) {
      return 'unrecoverable';
    }

    const scaledTimeoutMs = Math.round(timeoutMs * this.getResumeHealthLoadMultiplier());

    const initialProof = this.getResumeProof(adapter);
    if (initialProof !== null) {
      return initialProof ? 'healthy' : 'unrecoverable';
    }

    return new Promise<ResumeHealthVerdict>((resolve) => {
      let settled = false;
      let stopObserving: () => void = () => undefined;

      const finish = (value: ResumeHealthVerdict): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        stopObserving();
        resolve(value);
      };
      const finishProven = (healthy: boolean): void =>
        finish(healthy ? 'healthy' : 'unrecoverable');

      const poll = setInterval(() => {
        if (!this.isLive(instanceId, adapter)) {
          finish('unrecoverable');
          return;
        }

        const proof = this.getResumeProof(adapter);
        if (proof !== null) {
          finishProven(proof);
          return;
        }

        // A quiet-but-writable stream is only positive proof when no native
        // resume attempt is awaiting its session-id echo. Claude emits the
        // confirming system message ~1-2s after spawn; ending the probe on the
        // first writable poll (~200ms) would report "healthy but unconfirmed",
        // which callers must treat as unproven — and historically turned every
        // Claude auto-respawn into a fresh-session fallback.
        if (this.hasQuietResumeReadiness(adapter) && !this.hasPendingNativeResumeProof(adapter)) {
          finish('healthy');
        }
      }, pollIntervalMs);

      const timer = setTimeout(() => {
        if (!this.isLive(instanceId, adapter)) {
          finish('unrecoverable');
          return;
        }
        const proof = this.getResumeProof(adapter);
        if (proof !== null) {
          finishProven(proof);
          return;
        }
        // A live process with no definitive proof after the (scaled) window is
        // inconclusive, not dead — never destroy a possibly-healthy session on
        // a mere timeout. With a native attempt still unconfirmed, quiet
        // writability is not proof either.
        finish(
          this.hasQuietResumeReadiness(adapter) && !this.hasPendingNativeResumeProof(adapter)
            ? 'healthy'
            : 'inconclusive',
        );
      }, scaledTimeoutMs);

      stopObserving = observeAdapterRuntimeEvents(adapter, ({ event }) => {
        switch (event.kind) {
          case 'output':
            if (
              event.messageType === 'error'
              && this.isSessionNotFoundMessage(event.content)
            ) {
              finish('unrecoverable');
              break;
            }
            // When an adapter supplies proof (e.g. Claude init event precedes the
            // first output), prefer the proof signal over the raw "got output" heuristic.
            // This closes B1: a wrong-session resume is now detected and rejected.
            finishProven(this.getResumeProof(adapter) ?? true);
            break;
          case 'error':
            if (this.isSessionNotFoundMessage(event.message)) {
              finish('unrecoverable');
            }
            break;
          default:
            break;
        }
      });
    });
  }

  /**
   * Boolean wrapper kept for callers that only need "did native resume take?".
   * `inconclusive` maps to `false`, preserving pre-existing behavior for every
   * caller except the recovery reconciler, which consumes the richer verdict.
   */
  async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200,
  ): Promise<boolean> {
    return (
      (await this.evaluateResumeHealth(instanceId, timeoutMs, pollIntervalMs)) === 'healthy'
    );
  }

  /**
   * Wait for the adapter's input pipe to become writable after spawn/respawn.
   *
   * Claude's persistent process exposes this through its formatter; exec-based
   * adapters are ready once spawn returns.
   */
  async waitForAdapterWritable(
    instanceId: string,
    timeoutMs = 3000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    const isWritable = (): boolean => {
      const adapter = this.deps.getAdapter(instanceId);
      if (!adapter) {
        return false;
      }

      if (adapter.getName() === 'claude-cli') {
        const formatter = (adapter as unknown as {
          formatter?: { isWritable(): boolean } | null;
        }).formatter;
        return formatter !== undefined && formatter !== null && formatter.isWritable();
      }

      return true;
    };

    if (isWritable()) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(poll);
      };

      const timeout = setTimeout(() => {
        cleanup();
        logger.debug('waitForAdapterWritable timed out, proceeding anyway', { instanceId });
        resolve(isWritable());
      }, timeoutMs);

      const poll = setInterval(() => {
        if (isWritable()) {
          cleanup();
          resolve(true);
        }
      }, pollIntervalMs);
    });
  }

  async waitForInputReadinessBoundary(
    instanceId: string,
    adapter?: CliAdapter,
  ): Promise<void> {
    const capabilities = this.getAdapterRuntimeCapabilities(
      adapter ?? this.deps.getAdapter(instanceId),
    );
    if (!capabilities.supportsPermissionPrompts && !capabilities.supportsDeferPermission) {
      return;
    }

    await this.waitForAdapterWritable(instanceId, 3_000);
  }

  private isLive(instanceId: string, adapter?: CliAdapter): adapter is CliAdapter {
    if (!adapter) {
      return false;
    }

    const instance = this.deps.getInstance(instanceId);
    const currentAdapter = this.deps.getAdapter(instanceId);
    if (!instance || currentAdapter !== adapter) {
      return false;
    }

    return (
      instance.processId !== null &&
      instance.status !== 'error' &&
      instance.status !== 'failed' &&
      instance.status !== 'terminated'
    );
  }

  private hasQuietResumeReadiness(adapter: CliAdapter): boolean {
    if (adapter.getName() !== 'claude-cli') {
      return false;
    }

    const formatter = (adapter as unknown as {
      formatter?: { isWritable(): boolean } | null;
    }).formatter;
    return formatter !== undefined && formatter !== null && formatter.isWritable();
  }

  private isSessionNotFoundMessage(message: string): boolean {
    return isSessionNotFoundText(message);
  }

  /**
   * Returns the adapter's definitive resume proof if available, or null when
   * still pending / not supported. A false result means the adapter confirmed
   * a wrong-session resume — caller should treat as a health failure.
   */
  private getResumeProof(adapter: CliAdapter): boolean | null {
    const result = this.getResumeAttempt(adapter);
    if (!result || result.source === 'none') return null;
    if (result.source === 'fresh-fallback') return false;
    if (result.actualSessionId && result.requestedSessionId
        && result.actualSessionId !== result.requestedSessionId) return false;
    if (result.confirmed) return true;
    return null;
  }

  /**
   * True while an attempted native resume has neither confirmed nor disproved
   * itself yet — the window in which quiet writability must not be mistaken
   * for resume proof.
   */
  private hasPendingNativeResumeProof(adapter: CliAdapter): boolean {
    return this.getResumeAttempt(adapter)?.source === 'native'
      && this.getResumeProof(adapter) === null;
  }

  private getResumeAttempt(adapter: CliAdapter): ResumeAttemptResult | null {
    const a = adapter as unknown as {
      getRuntimeSnapshot?: () => { resumeProof?: ResumeAttemptResult | null };
      getResumeAttemptResult?: () => ResumeAttemptResult | null | undefined;
    };
    return a.getRuntimeSnapshot?.().resumeProof ?? a.getResumeAttemptResult?.() ?? null;
  }
}
