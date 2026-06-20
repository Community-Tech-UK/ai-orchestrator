import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance, InstanceProvider } from '../../shared/types/instance.types';

const logger = getLogger('ReviewerSessionSpawner');

/**
 * Terminal outcome of a single awaited review session.
 * - `settled`   — the reviewer instance finished and went idle (debounced).
 * - `timeout`   — the reviewer exceeded the wall-clock budget.
 * - `cancelled` — the loop paused/cancelled while the reviewer was in flight.
 * - `failed`    — spawn error, reviewer instance entered an error/failed state,
 *                 or the InstanceManager was unavailable.
 */
export type ReviewSessionOutcome = 'settled' | 'timeout' | 'cancelled' | 'failed';

export interface ReviewSessionOptions {
  /** Reviewer provider — MUST already be resolved to != the builder provider. */
  provider: InstanceProvider;
  /** Optional explicit model override (e.g. codex → 'gpt-5.5'). */
  modelOverride?: string;
  /** Workspace the reviewer reads. */
  workingDirectory: string;
  /** The deep-dive task prompt sent as the reviewer's initial message. */
  prompt: string;
  /** Human-facing label in the agent tree. */
  displayName?: string;
  /**
   * Agent profile. Defaults to `'review'` (read-allowed, write-DENIED) so the
   * reviewer can explore the repo but cannot mutate code.
   */
  agentId?: string;
  /**
   * Auto-approve permission prompts. Defaults to `true` so a read-only reviewer
   * does not hang on `bash:ask` waiting for a human that isn't there. The
   * `review` agent's `write: deny` still blocks edits; yolo only frees
   * read/grep/bash so the settle-wait can actually complete instead of parking
   * the instance in `waiting_for_permission` until the timeout.
   */
  yoloMode?: boolean;
  /** Hard wall-clock timeout for the whole review (ms). */
  timeoutMs: number;
  /** Cancellation — loop pause/cancel aborts the in-flight reviewer. */
  signal?: AbortSignal;
  /** Secondary cancellation predicate (polled by the settle tracker). */
  isCancelled?: () => boolean;
  /** Progress heartbeat (elapsed ms) while the reviewer runs. */
  onProgress?: (elapsedMs: number) => void;
  /**
   * Fired the moment the reviewer instance is registered, with its id. The
   * caller records this as the in-flight reviewer so a crash mid-review can be
   * reconciled (and so the agent-tree shows the live deep-dive).
   */
  onSpawned?: (instanceId: string) => void;
}

export interface ReviewSessionResult {
  outcome: ReviewSessionOutcome;
  /** The reviewer's final assistant text (empty on spawn failure). */
  finalOutput: string;
  /** The spawned (now-terminated) reviewer instance id, or '' on spawn failure. */
  instanceId: string;
  /** Tokens the reviewer consumed (folded into the loop budget). */
  tokensUsed: number;
  /** Estimated reviewer cost in cents (folded into the loop budget). */
  costCents: number;
  /** Populated for non-`settled` outcomes. */
  error?: string;
}

/**
 * Wraps `InstanceManager.createInstance` to give the ping-pong reviewer an
 * **awaited, disposable** execution contract. `createInstance` is not
 * fire-and-await-result (it returns after synchronous registration while
 * adapter startup + prompting continue in the background, and an instance can
 * be marked idle before the initial prompt is even sent), so this spawner:
 *
 * 1. spawns the reviewer **root-level** (no `parentId`) so it loads repo-map /
 *    memory and performs a genuine deep-dive (bigchange_pingpong_review R1);
 * 2. awaits `readyPromise` (initial prompt sent) then
 *    `waitForInstanceSettled({ afterTimestamp })` — the real awaitable, not raw
 *    `idle` which is unsafe;
 * 3. enforces a timeout and reacts to cancellation;
 * 4. reads the reviewer's final output + token/cost accounting;
 * 5. **tears the instance down every round** (fresh-eyes ⇒ disposable).
 */
export class ReviewerSessionSpawner {
  private static instance: ReviewerSessionSpawner | null = null;
  private instanceManager: InstanceManager | null = null;

  static getInstance(): ReviewerSessionSpawner {
    if (!this.instance) {
      this.instance = new ReviewerSessionSpawner();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    registerCleanup(() => {
      this.instanceManager = null;
    });
  }

  /**
   * Inject the InstanceManager. Main-process startup calls this after the
   * InstanceManager is constructed (mirrors CrossModelReviewService).
   */
  setInstanceManager(im: InstanceManager): void {
    this.instanceManager = im;
  }

  hasInstanceManager(): boolean {
    return this.instanceManager !== null;
  }

  async runReviewSession(opts: ReviewSessionOptions): Promise<ReviewSessionResult> {
    const im = this.instanceManager;
    if (!im) {
      return {
        outcome: 'failed',
        finalOutput: '',
        instanceId: '',
        tokensUsed: 0,
        costCents: 0,
        error: 'ReviewerSessionSpawner has no InstanceManager (not wired at startup)',
      };
    }

    if (opts.signal?.aborted || opts.isCancelled?.()) {
      return {
        outcome: 'cancelled',
        finalOutput: '',
        instanceId: '',
        tokensUsed: 0,
        costCents: 0,
        error: 'cancelled before spawn',
      };
    }

    const startTs = Date.now();
    let instance: Instance;
    try {
      instance = await im.createInstance({
        workingDirectory: opts.workingDirectory,
        initialPrompt: opts.prompt,
        provider: opts.provider,
        modelOverride: opts.modelOverride,
        agentId: opts.agentId ?? 'review',
        yoloMode: opts.yoloMode ?? true,
        launchMode: 'orchestrated',
        displayName: opts.displayName ?? `Ping-pong reviewer (${opts.provider})`,
        // Root-level (no parentId): a `parentId` child skips repo-map / memory
        // loading, which would gut the deep-dive (bigchange_pingpong_review R1).
        metadata: { pingPongReviewer: true, spawnedAt: startTs, hideFromProjectRail: true },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Ping-pong reviewer spawn failed', { provider: opts.provider, error: message });
      return {
        outcome: 'failed',
        finalOutput: '',
        instanceId: '',
        tokensUsed: 0,
        costCents: 0,
        error: message,
      };
    }

    const instanceId = instance.id;
    try {
      opts.onSpawned?.(instanceId);
    } catch {
      // observer error must not abort the review
    }

    let result: ReviewSessionResult;
    try {
      // Ensure background init finished and the initial prompt was actually sent
      // before we wait for the reviewer to settle.
      if (instance.readyPromise) {
        await instance.readyPromise.catch(() => undefined);
      }

      const settled = await im.waitForInstanceSettled(instanceId, {
        afterTimestamp: startTs,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        isCancelled: opts.isCancelled,
        onProgress: opts.onProgress,
      });

      const live = im.getInstance(instanceId) ?? settled ?? instance;
      const tokensUsed = Math.max(0, live.totalTokensUsed ?? 0);
      const costCents = this.estimateCostCents(tokensUsed, opts.modelOverride ?? opts.provider);
      const finalOutput = this.extractFinalOutput(im, instanceId);
      const failed = live.status === 'failed' || live.status === 'error';

      result = {
        outcome: failed ? 'failed' : 'settled',
        finalOutput,
        instanceId,
        tokensUsed,
        costCents,
        error: failed ? 'reviewer instance ended in a failed state' : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = opts.signal?.aborted || opts.isCancelled?.() === true;
      const isTimeout = /timed out/i.test(message);
      const live = im.getInstance(instanceId);
      const tokensUsed = Math.max(0, live?.totalTokensUsed ?? 0);
      result = {
        outcome: cancelled ? 'cancelled' : isTimeout ? 'timeout' : 'failed',
        finalOutput: this.extractFinalOutput(im, instanceId),
        instanceId,
        tokensUsed,
        costCents: this.estimateCostCents(tokensUsed, opts.modelOverride ?? opts.provider),
        error: message,
      };
      logger.warn('Ping-pong reviewer did not settle cleanly', {
        instanceId,
        outcome: result.outcome,
        error: message,
      });
    } finally {
      // Fresh-eyes ⇒ disposable. Always tear down, even on timeout/cancel, so a
      // long-running reviewer cannot leak past its round (R5 / circuit-breaker
      // cleanup precedent). Non-graceful: we already have the output we need.
      try {
        await im.terminateInstance(instanceId, false);
      } catch (err) {
        logger.warn('Failed to tear down ping-pong reviewer instance', {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /** Read the reviewer's last assistant message as plain text. */
  private extractFinalOutput(im: InstanceManager, instanceId: string): string {
    const instance = im.getInstance(instanceId);
    if (!instance) return '';
    const buffer = instance.outputBuffer ?? [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      const msg = buffer[i];
      if (msg.type === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0) {
        return msg.content;
      }
    }
    // Fallback: any non-empty assistant-ish content, else a markdown export.
    try {
      return im.exportSessionMarkdown(instanceId);
    } catch {
      return '';
    }
  }

  /**
   * Estimate reviewer cost in cents from total tokens. We don't have an
   * input/output split for a spawned instance, so we treat the spend as
   * input-heavy (reviewers read a lot more than they write) — a deliberately
   * conservative estimate so the loop's cost cap trips slightly early rather
   * than late.
   */
  private estimateCostCents(totalTokens: number, model: string): number {
    if (totalTokens <= 0) return 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getTokenCounter } = require('../rlm/token-counter') as typeof import('../rlm/token-counter');
      const usd = getTokenCounter().estimateCost(
        Math.round(totalTokens * 0.85),
        Math.round(totalTokens * 0.15),
        model,
      );
      return Math.max(0, Math.ceil(usd * 100));
    } catch {
      return 0;
    }
  }
}

export function getReviewerSessionSpawner(): ReviewerSessionSpawner {
  return ReviewerSessionSpawner.getInstance();
}
