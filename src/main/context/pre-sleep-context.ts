/**
 * Shrink a Claude session before it sleeps for a known time (Oct-2 T13.1).
 *
 * Claude's prompt cache lasts about an hour. A large session that will not be used again for
 * longer than that pays to rewrite the whole thing on its next message, so when the wake-up
 * time is known in advance (a scheduled wake-up of a chat, a loop's scheduled wake-up) the
 * session is compacted first, while its cache is still warm and cheap to read.
 *
 * Quota-limited sessions are not handled here: a compaction is a model call and cannot run
 * on an account that is out of allowance. Loops recycle instead (`loop-sleep-context.ts`).
 */

import type { ContextUsage } from '../../shared/types/instance.types';
import { decideSleepContext, trustedContextTokens } from '../../shared/utils/claude-cache-economics';
import { getLogger } from '../logging/logger';

const logger = getLogger('PreSleepContext');

export type PreSleepSource = 'loop-wakeup' | 'scheduled-wakeup';

export interface PreSleepRequest {
  instanceId: string;
  /** Epoch ms when the session will be used again. */
  wakeAt: number;
  source: PreSleepSource;
  /**
   * The schedule (or loop) this request came from. One claim per key: a later
   * request from the same key replaces it, and a key whose schedule is deleted,
   * disabled or pointed elsewhere has its claim dropped (`revokeClaim`).
   */
  claimKey: string;
}

export interface PreSleepInstanceView {
  provider: string;
  status: string;
  contextUsage: ContextUsage;
  executionLocation?: { type: string };
  waitReason?: unknown;
}

export interface PreSleepDeps {
  getInstance(instanceId: string): PreSleepInstanceView | undefined;
  /** The cache lifetime this session's replies reported, or null before the first one. */
  getCacheLifetimeMs(instanceId: string): number | null;
  /** Background agents or shells are running, or Claude asked to be woken: stopping its process would lose them. */
  hasPendingWork(instanceId: string): boolean;
  compact(instanceId: string): Promise<boolean>;
  now?(): number;
}

export type PreSleepOutcome =
  | { kind: 'compacted' }
  | { kind: 'deferred'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

/** A fresh compaction leaves nothing to save, so a second request inside this window is ignored. */
export const RECOMPACT_GUARD_MS = 10 * 60_000;

export class PreSleepContext {
  /** Retain short sleeps too: every known wake-up constrains the next compaction. */
  private readonly claims = new Map<string, Map<string, PreSleepRequest>>();
  private readonly waiting = new Set<string>();
  private readonly lastCompactedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PreSleepDeps) {}

  /** A session will not be used again until `wakeAt`: shrink it first if that is worth it. */
  async note(request: PreSleepRequest): Promise<PreSleepOutcome> {
    return (await this.noteAll([request]))[0];
  }

  /** Register a complete snapshot before evaluating any session's earliest wake-up. */
  async noteAll(requests: readonly PreSleepRequest[]): Promise<PreSleepOutcome[]> {
    const instanceIds = new Set<string>();
    for (const request of requests) {
      // A retargeted schedule takes its claim with it.
      this.dropClaim(request.claimKey);
      let claims = this.claims.get(request.instanceId);
      if (!claims) {
        claims = new Map<string, PreSleepRequest>();
        this.claims.set(request.instanceId, claims);
      }
      claims.set(request.claimKey, request);
      instanceIds.add(request.instanceId);
    }
    return Promise.all([...instanceIds].map(async (instanceId) => {
      const outcome = await this.evaluateSoonest(instanceId);
      if (outcome.kind === 'deferred') this.waiting.add(instanceId);
      return outcome;
    }));
  }

  /**
   * The schedule behind a claim is gone (deleted, disabled, or no longer a
   * wake-up of anything): drop its deferred request, so the session is not
   * shrunk for a sleep that will not happen. Other claims for the session stay.
   */
  revokeClaim(claimKey: string): void {
    this.dropClaim(claimKey);
  }

  /** The session finished a turn: retry the request that was soonest waiting for it. */
  async onIdle(instanceId: string): Promise<PreSleepOutcome | null> {
    if (!this.waiting.delete(instanceId)) return null;
    const outcome = await this.evaluateSoonest(instanceId);
    if (outcome.kind === 'deferred') this.waiting.add(instanceId);
    return outcome;
  }

  private async evaluateSoonest(instanceId: string): Promise<PreSleepOutcome> {
    const claims = this.claims.get(instanceId);
    if (!claims) return { kind: 'skipped', reason: 'the wake-up has passed' };
    const now = this.deps.now?.() ?? Date.now();
    let soonest: PreSleepRequest | undefined;
    for (const [key, request] of claims) {
      if (request.wakeAt <= now) { claims.delete(key); continue; }
      if (!soonest || request.wakeAt < soonest.wakeAt) soonest = request;
    }
    if (!soonest) { this.claims.delete(instanceId); return { kind: 'skipped', reason: 'the wake-up has passed' }; }
    return this.evaluate(soonest);
  }

  forget(instanceId: string): void {
    this.waiting.delete(instanceId);
    this.claims.delete(instanceId);
    this.lastCompactedAt.delete(instanceId);
    this.inFlight.delete(instanceId);
  }

  private dropClaim(claimKey: string): void {
    for (const [instanceId, claims] of this.claims) {
      if (!claims.delete(claimKey)) continue;
      if (claims.size === 0) {
        this.claims.delete(instanceId);
        this.waiting.delete(instanceId);
      } else this.waiting.add(instanceId);
    }
  }

  private async evaluate(request: PreSleepRequest): Promise<PreSleepOutcome> {
    const { instanceId } = request;
    const now = this.deps.now?.() ?? Date.now();
    const instance = this.deps.getInstance(instanceId);
    if (!instance) return { kind: 'skipped', reason: 'the session is gone' };
    if (instance.provider !== 'claude') return { kind: 'skipped', reason: 'not a Claude session' };
    if (instance.executionLocation && instance.executionLocation.type !== 'local') {
      return { kind: 'skipped', reason: 'the session runs on another machine' };
    }
    if (instance.status === 'hibernated') return { kind: 'skipped', reason: 'the session is hibernated' };
    if (instance.waitReason) return { kind: 'skipped', reason: 'the session is waiting on something else' };

    const decision = decideSleepContext({
      sleepMs: request.wakeAt - now,
      contextTokens: trustedContextTokens(instance.contextUsage),
      cacheLifetimeMs: this.deps.getCacheLifetimeMs(instanceId),
      canCompact: true,
      canRecycle: false,
    });
    if (decision.action !== 'compact') return { kind: 'skipped', reason: decision.reason };

    if (this.inFlight.has(instanceId)) return { kind: 'skipped', reason: 'a compaction is already running' };
    const last = this.lastCompactedAt.get(instanceId);
    if (last !== undefined && now - last < RECOMPACT_GUARD_MS) return { kind: 'skipped', reason: 'compacted a moment ago' };
    if (instance.status !== 'idle') return { kind: 'deferred', reason: 'the session is busy' };
    if (this.deps.hasPendingWork(instanceId)) return { kind: 'skipped', reason: 'background work or a wake-up is pending in the session' };

    logger.info('Compacting a Claude session before a long sleep', {
      instanceId,
      source: request.source,
      sleepMinutes: Math.round((request.wakeAt - now) / 60_000),
      contextTokens: trustedContextTokens(instance.contextUsage),
      cacheLifetimeMinutes: Math.round(decision.cacheLifetimeMs / 60_000),
    });
    this.inFlight.add(instanceId);
    try {
      const ok = await this.deps.compact(instanceId);
      if (ok) this.lastCompactedAt.set(instanceId, now);
      return ok ? { kind: 'compacted' } : { kind: 'failed', reason: 'the compaction did not complete' };
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'the compaction threw' };
    } finally {
      this.inFlight.delete(instanceId);
    }
  }
}

let configured: PreSleepContext | null = null;

/** Set once at startup (`pre-sleep-context-runtime.ts`); null in tests and before startup finishes. */
export function setPreSleepContext(service: PreSleepContext | null): void {
  configured = service;
}

export function getPreSleepContext(): PreSleepContext | null {
  return configured;
}
