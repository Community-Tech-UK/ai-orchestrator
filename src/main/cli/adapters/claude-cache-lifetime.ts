/**
 * How long Claude's prompt cache lasts for this session (T13 step 3).
 *
 * Whether the next message can reuse the cache depends on its lifetime. Each reply
 * reports what it wrote to the cache split by lifetime
 * (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).
 * This reads the reported split rather than assuming a fixed hour.
 *
 * A reply that only read from the cache carries the previous answer forward,
 * because reads do not change how long the stored prefix lives. Helper frames
 * (tagged with `parent_tool_use_id`) are ignored: their cache is not the main
 * conversation's.
 */

import { readCacheCreationUsage } from '../../../shared/util/usage-normalization';
import { asUnknownRecord } from './claude-cli-adapter.types';

export const CLAUDE_CACHE_LIFETIME_5M_MS = 5 * 60_000;
export const CLAUDE_CACHE_LIFETIME_1H_MS = 60 * 60_000;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;

export interface ClaudeCacheLifetime {
  lifetimeMs: number;
  /** When the main conversation last touched the cache (its newest reply). */
  observedAt: number;
}

/**
 * The lifetime implied by one reply's cache writes, or undefined when it wrote
 * nothing. When both kinds were written the larger share decides (the bulk of
 * the prefix expires with it); a tie takes the shorter lifetime.
 */
export function cacheLifetimeFromUsage(usage: unknown): number | undefined {
  const { cacheWrite5mTokens = 0, cacheWrite1hTokens = 0 } = readCacheCreationUsage(usage);
  if (cacheWrite5mTokens <= 0 && cacheWrite1hTokens <= 0) return undefined;
  return cacheWrite1hTokens > cacheWrite5mTokens ? CLAUDE_CACHE_LIFETIME_1H_MS : CLAUDE_CACHE_LIFETIME_5M_MS;
}

export class ClaudeCacheLifetimeTracker {
  private current: ClaudeCacheLifetime | null = null;

  get(): ClaudeCacheLifetime | null {
    return this.current ? { ...this.current } : null;
  }

  /** Adopt a value measured elsewhere (a remote worker); nonsense is refused. */
  set(value: ClaudeCacheLifetime): boolean {
    if (!Number.isFinite(value.lifetimeMs) || value.lifetimeMs <= 0 || value.lifetimeMs > MAX_LIFETIME_MS
      || !Number.isFinite(value.observedAt) || value.observedAt < 0) return false;
    this.current = { lifetimeMs: value.lifetimeMs, observedAt: value.observedAt };
    return true;
  }

  /** Main-thread assistant frames only. Returns the new state, or null when the frame says nothing. */
  observeAssistant(frame: unknown, now = Date.now()): (ClaudeCacheLifetime & { changed: boolean }) | null {
    const raw = asUnknownRecord(frame);
    if (raw?.['type'] !== 'assistant' || raw['parent_tool_use_id']) return null;
    const usage = asUnknownRecord(raw['message'])?.['usage'];
    if (!usage) return null;
    const lifetimeMs = cacheLifetimeFromUsage(usage) ?? this.current?.lifetimeMs;
    if (lifetimeMs === undefined) return null;
    const changed = lifetimeMs !== this.current?.lifetimeMs;
    this.current = { lifetimeMs, observedAt: now };
    return { ...this.current, changed };
  }
}

type Host = object;
interface Emitter { emit(event: string, ...args: unknown[]): boolean }
const trackers = new WeakMap<Host, ClaudeCacheLifetimeTracker>();

function trackerOf(host: Host): ClaudeCacheLifetimeTracker {
  let tracker = trackers.get(host);
  if (!tracker) {
    tracker = new ClaudeCacheLifetimeTracker();
    trackers.set(host, tracker);
  }
  return tracker;
}

/** Call for every assistant frame. Emits `cache_lifetime` when the lifetime first becomes known or changes. */
export function observeClaudeCacheLifetime(host: Emitter, frame: unknown, now = Date.now()): void {
  const seen = trackerOf(host).observeAssistant(frame, now);
  if (seen?.changed) host.emit('cache_lifetime', { lifetimeMs: seen.lifetimeMs, observedAt: seen.observedAt });
}

/** The lifetime last seen on this adapter (local, worker-hosted or relayed from a remote node), or null. */
export function getClaudeCacheLifetime(host: Host | null | undefined): ClaudeCacheLifetime | null {
  return host ? trackers.get(host)?.get() ?? null : null;
}

/** Store a lifetime that was measured in another process. */
export function recordClaudeCacheLifetime(host: Host, value: ClaudeCacheLifetime): void {
  trackerOf(host).set(value);
}
