import type { ClaudeSelfWakeupEvent } from '../cli/adapters/claude-cli-self-wakeup';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('SelfWakeupTracker');
const EXPIRY_GRACE_MS = 10 * 60_000;
const LOST_WAKEUP_NOTICE = 'This session ended while Claude had a wake-up pending; it will not happen.';

export class SelfWakeupTracker {
  private static instance: SelfWakeupTracker | null = null;
  private pending = new Map<string, Extract<ClaudeSelfWakeupEvent, { kind: 'requested' }>>();
  private daily = new Map<string, number>();
  private seen = new Map<string, Set<string>>();
  private timer = setInterval(() => this.expire(Date.now()), 60_000);

  constructor() { this.timer.unref?.(); }

  static getInstance(): SelfWakeupTracker {
    if (!this.instance) {
      this.instance = new SelfWakeupTracker();
      registerCleanup(() => SelfWakeupTracker._resetForTesting());
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.dispose();
    this.instance = null;
  }

  observe(sessionId: string, event: ClaudeSelfWakeupEvent): void {
    this.expire(Date.now());
    const seen = this.seen.get(sessionId) ?? new Set<string>();
    const key = `${event.kind}:${event.toolUseId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    this.seen.set(sessionId, seen);
    if (event.kind === 'stopped') this.pending.delete(sessionId);
    else if (event.kind === 'refused') {
      if (this.pending.get(sessionId)?.toolUseId === event.toolUseId) this.pending.delete(sessionId);
    } else {
      // Copy only the defined safe fields, even if a transport carries extras.
      this.pending.set(sessionId, { kind: 'requested', toolUseId: event.toolUseId, requestedAt: event.requestedAt,
        delaySeconds: event.delaySeconds, dueAt: event.dueAt, reason: event.reason.slice(0, 120) });
      const day = new Date(event.requestedAt).toISOString().slice(0, 10);
      this.daily.set(day, (this.daily.get(day) ?? 0) + 1);
    }
    logger.info('Claude self wake-up request', { sessionId, kind: event.kind,
      ...(event.kind === 'requested' ? { dueAt: event.dueAt, delaySeconds: event.delaySeconds } : {}) });
  }

  hasPending(sessionId: string, now = Date.now()): boolean {
    this.expire(now);
    return this.pending.has(sessionId);
  }

  tally(day: string): number { return this.daily.get(day) ?? 0; }

  endSession(sessionId: string, now = Date.now()): OutputMessage | null {
    const pending = this.hasPending(sessionId, now);
    this.pending.delete(sessionId);
    this.seen.delete(sessionId);
    return pending ? { id: generateId(), timestamp: now, type: 'system', content: LOST_WAKEUP_NOTICE } : null;
  }

  dispose(): void { clearInterval(this.timer); this.pending.clear(); this.seen.clear(); this.daily.clear(); }

  private expire(now: number): void {
    for (const [sessionId, event] of this.pending) {
      if (now >= event.dueAt + EXPIRY_GRACE_MS) { this.pending.delete(sessionId); this.seen.delete(sessionId); }
    }
  }
}

export function getSelfWakeupTracker(): SelfWakeupTracker { return SelfWakeupTracker.getInstance(); }

/** Called before archive/detach, so both terminated and hibernated transcripts keep the notice. */
export function appendLostSelfWakeupNotice(instance: Pick<Instance, 'id' | 'outputBuffer'>): OutputMessage | null {
  const notice = getSelfWakeupTracker().endSession(instance.id);
  if (notice) instance.outputBuffer.push(notice);
  return notice;
}
