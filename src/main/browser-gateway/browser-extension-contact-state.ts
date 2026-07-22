export const BROWSER_EXTENSION_CONTACT_FRESH_MS = 90_000;

/**
 * Reserved channel id for the AIO host's OWN Chrome extension session. The
 * local extension reaches the coordinator through the native host + unix
 * socket rather than the worker relay, so it has no worker nodeId — but it is
 * otherwise the same channel with the same freshness, queue and disconnect
 * semantics. Keying it under a reserved id lets health, freshness prechecks and
 * error messages treat local and remote identically instead of leaving local
 * completely untracked (the failure mode where "no local extension installed",
 * "installed but not polling" and "healthy, nothing shared" were all an
 * indistinguishable empty list).
 *
 * Matches the command store's default queue key, so `queueKey` and channel id
 * agree for the local channel.
 */
export const BROWSER_LOCAL_EXTENSION_CHANNEL_ID = 'local';

/**
 * A contact gap larger than this is a channel outage worth counting: the
 * extension long-polls continuously (≤10s holds, 250ms idle re-poll), so a
 * >30s silence means the service worker slept, the native host dropped, or
 * the worker link broke — the situations the undelivered-wait rides out.
 */
export const BROWSER_EXTENSION_CONTACT_GAP_THRESHOLD_MS = 30_000;

export interface BrowserExtensionContactSnapshot {
  nodeId: string;
  lastContactAt?: number;
  silent: boolean;
  staleForMs?: number;
  /** Set when the native host reported the extension channel closing. */
  lastDisconnect?: BrowserExtensionDisconnectRecord;
}

export interface BrowserExtensionDisconnectRecord {
  at: number;
  reason: string;
}

/**
 * Self-reported build evidence the extension stamps on every native message.
 * Used for local/remote version-compatibility reporting in health; the remote
 * path carries the same fields on the worker node's relay capabilities.
 */
export interface BrowserExtensionRuntimeRecord {
  extensionVersion?: string;
  /** Epoch ms the MV3 service worker started; changes on every SW restart. */
  extensionStartedAt?: number;
}

/** Telemetry about observed channel outages, for tuning recovery budgets. */
export interface BrowserExtensionContactGapStats {
  /** Contact gaps above the outage threshold since this node registered. */
  gapCount: number;
  longestGapMs: number;
  /** Duration of the most recent outage-sized gap. */
  lastGapMs?: number;
  /** When the most recent outage-sized gap ended (contact resumed). */
  lastGapEndedAt?: number;
}

export interface BrowserExtensionContactStateReader {
  getLastExtensionContactAt(nodeId: string): number | undefined;
  isExtensionContactFresh(nodeId: string): boolean;
  describeExtensionContact(nodeId: string): BrowserExtensionContactSnapshot;
  getContactGapStats(nodeId: string): BrowserExtensionContactGapStats;
  /** Optional so lightweight fakes need not implement it. */
  getLastDisconnect?(nodeId: string): BrowserExtensionDisconnectRecord | undefined;
  /** Optional so lightweight fakes need not implement it. */
  getExtensionRuntime?(nodeId: string): BrowserExtensionRuntimeRecord | undefined;
}

export interface BrowserExtensionContactStateOptions {
  now?: () => number;
  freshMs?: number;
}

export class BrowserExtensionContactState implements BrowserExtensionContactStateReader {
  private static instance: BrowserExtensionContactState | null = null;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly lastContactAtByNode = new Map<string, number>();
  private readonly gapStatsByNode = new Map<string, BrowserExtensionContactGapStats>();
  private readonly lastDisconnectByNode = new Map<string, BrowserExtensionDisconnectRecord>();
  private readonly runtimeByNode = new Map<string, BrowserExtensionRuntimeRecord>();

  constructor(options: BrowserExtensionContactStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? BROWSER_EXTENSION_CONTACT_FRESH_MS;
  }

  static getInstance(): BrowserExtensionContactState {
    if (!this.instance) {
      this.instance = new BrowserExtensionContactState();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  markExtensionContact(nodeId: string, contactedAt = this.now()): void {
    const previousContactAt = this.lastContactAtByNode.get(nodeId);
    if (previousContactAt !== undefined) {
      const gapMs = contactedAt - previousContactAt;
      if (gapMs > BROWSER_EXTENSION_CONTACT_GAP_THRESHOLD_MS) {
        const stats = this.gapStatsByNode.get(nodeId) ?? { gapCount: 0, longestGapMs: 0 };
        this.gapStatsByNode.set(nodeId, {
          gapCount: stats.gapCount + 1,
          longestGapMs: Math.max(stats.longestGapMs, gapMs),
          lastGapMs: gapMs,
          lastGapEndedAt: contactedAt,
        });
      }
    }
    this.lastContactAtByNode.set(nodeId, contactedAt);
  }

  getContactGapStats(nodeId: string): BrowserExtensionContactGapStats {
    return this.gapStatsByNode.get(nodeId) ?? { gapCount: 0, longestGapMs: 0 };
  }

  /**
   * The native host told us the extension channel closed (Chrome quit, port
   * torn down, service worker replaced). Deliberately does NOT touch
   * lastContactAt — freshness semantics stay the same; this is honesty for
   * health, error messages, and outage telemetry.
   */
  markExtensionDisconnect(nodeId: string, reason: string, at = this.now()): void {
    this.lastDisconnectByNode.set(nodeId, { at, reason });
  }

  getLastDisconnect(nodeId: string): BrowserExtensionDisconnectRecord | undefined {
    return this.lastDisconnectByNode.get(nodeId);
  }

  /**
   * Record build evidence the extension stamped on a native message. Fields are
   * merged, never cleared: an older message that omits `extensionVersion` must
   * not erase a version we already learned.
   */
  markExtensionRuntime(nodeId: string, runtime: BrowserExtensionRuntimeRecord): void {
    const previous = this.runtimeByNode.get(nodeId);
    const merged: BrowserExtensionRuntimeRecord = {
      ...previous,
      ...(runtime.extensionVersion ? { extensionVersion: runtime.extensionVersion } : {}),
      ...(runtime.extensionStartedAt !== undefined
        ? { extensionStartedAt: runtime.extensionStartedAt }
        : {}),
    };
    if (merged.extensionVersion === undefined && merged.extensionStartedAt === undefined) {
      return;
    }
    this.runtimeByNode.set(nodeId, merged);
  }

  getExtensionRuntime(nodeId: string): BrowserExtensionRuntimeRecord | undefined {
    return this.runtimeByNode.get(nodeId);
  }

  forgetNode(nodeId: string): void {
    this.lastContactAtByNode.delete(nodeId);
    this.gapStatsByNode.delete(nodeId);
    this.lastDisconnectByNode.delete(nodeId);
    this.runtimeByNode.delete(nodeId);
  }

  getLastExtensionContactAt(nodeId: string): number | undefined {
    return this.lastContactAtByNode.get(nodeId);
  }

  isExtensionContactFresh(nodeId: string): boolean {
    const lastContactAt = this.getLastExtensionContactAt(nodeId);
    return isBrowserExtensionContactFresh(lastContactAt, this.now(), this.freshMs);
  }

  describeExtensionContact(nodeId: string): BrowserExtensionContactSnapshot {
    return describeBrowserExtensionContact(
      nodeId,
      this.getLastExtensionContactAt(nodeId),
      this.now(),
      this.freshMs,
    );
  }
}

export function getBrowserExtensionContactState(): BrowserExtensionContactState {
  return BrowserExtensionContactState.getInstance();
}

export function describeBrowserExtensionContact(
  nodeId: string,
  lastContactAt: number | undefined,
  now: number,
  freshMs = BROWSER_EXTENSION_CONTACT_FRESH_MS,
): BrowserExtensionContactSnapshot {
  const silent = !isBrowserExtensionContactFresh(lastContactAt, now, freshMs);
  return {
    nodeId,
    ...(lastContactAt !== undefined ? { lastContactAt } : {}),
    silent,
    ...(lastContactAt !== undefined && silent
      ? { staleForMs: Math.max(0, now - lastContactAt - freshMs) }
      : {}),
  };
}

export function isBrowserExtensionContactFresh(
  lastContactAt: number | undefined,
  now: number,
  freshMs = BROWSER_EXTENSION_CONTACT_FRESH_MS,
): boolean {
  return lastContactAt !== undefined && now - lastContactAt <= freshMs;
}
