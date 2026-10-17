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
  /**
   * Stable random id of one extension install, i.e. one Chrome profile. Absent
   * from extension builds before 0.2.42, which keeps their per-channel
   * behaviour unchanged.
   */
  extensionInstanceId?: string;
}

const EXTENSION_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accept only an id that is safe to embed in an existing-tab profile id
 * (no `:` separators) and bounded in size. Anything else is treated as "no
 * instance", never as an error, so a malformed id degrades to the legacy
 * per-channel behaviour instead of breaking the channel.
 */
export function normalizeBrowserExtensionInstanceId(value: unknown): string | undefined {
  return typeof value === 'string' && EXTENSION_INSTANCE_ID_PATTERN.test(value)
    ? value
    : undefined;
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
  getExtensionRuntime?(
    nodeId: string,
    extensionInstanceId?: string,
  ): BrowserExtensionRuntimeRecord | undefined;
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
  // The runtime maps below are keyed by runtimeKey(): one service-worker
  // lineage per extension install. Several Chrome profiles on one machine each
  // run their own install with their own startedAt clock, so a single
  // per-node watermark let the later-started profile silence the other one,
  // and one profile's disconnect tombstoned both.
  private readonly runtimeByNode = new Map<string, BrowserExtensionRuntimeRecord>();
  private readonly runtimeGenerationWatermarkByNode = new Map<string, number>();
  private readonly blockedRuntimeGenerationByNode = new Map<string, number>();
  /**
   * Generations tombstoned by a port/node drop, not by contradictory
   * version evidence. A later complete poll from the same SW (the other
   * native-host bridge, or the same host after reconnect) may restore.
   */
  private readonly reconnectableRuntimeGenerationByNode = new Map<string, number>();
  /** Every runtime key ever recorded for a node, for node-wide invalidation. */
  private readonly runtimeKeysByNode = new Map<string, Set<string>>();
  /** Key of the install that most recently sent evidence, for instance-less reads. */
  private readonly latestRuntimeKeyByNode = new Map<string, string>();

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
   * health, error messages, and outage telemetry. The runtime tombstone is
   * reconnectable: one of two native-host bridges EOFing must not permanently
   * block the still-alive sibling that shares this SW generation.
   *
   * With an instance id only that install is tombstoned; another Chrome
   * profile on the same machine keeps its trust. Without one (a legacy native
   * host, or the whole node link dropping) every install on the node is.
   */
  markExtensionDisconnect(
    nodeId: string,
    reason: string,
    at = this.now(),
    extensionInstanceId?: string,
  ): void {
    const instanceId = normalizeBrowserExtensionInstanceId(extensionInstanceId);
    for (const key of instanceId ? [runtimeKey(nodeId, instanceId)] : this.runtimeKeysFor(nodeId)) {
      this.invalidateExtensionRuntime(key, true, { reconnectable: true });
    }
    this.lastDisconnectByNode.set(nodeId, { at, reason });
  }

  getLastDisconnect(nodeId: string): BrowserExtensionDisconnectRecord | undefined {
    return this.lastDisconnectByNode.get(nodeId);
  }

  /**
   * Record build evidence from one authenticated native message without
   * allowing delayed messages from an older service-worker generation to
   * restore stale trust. Incomplete evidence cannot establish trust and
   * must not tombstone a generation another host already proved. A true
   * version conflict on the same startedAt still fails closed.
   */
  markExtensionRuntime(nodeId: string, runtime: BrowserExtensionRuntimeRecord): void {
    const instanceId = normalizeBrowserExtensionInstanceId(runtime.extensionInstanceId);
    const incoming: BrowserExtensionRuntimeRecord = {
      ...(runtime.extensionVersion ? { extensionVersion: runtime.extensionVersion } : {}),
      ...(runtime.extensionStartedAt !== undefined
        && Number.isInteger(runtime.extensionStartedAt)
        && runtime.extensionStartedAt >= 0
        ? { extensionStartedAt: runtime.extensionStartedAt }
        : {}),
      ...(instanceId ? { extensionInstanceId: instanceId } : {}),
    };

    const incomingStartedAt = incoming.extensionStartedAt;
    if (incomingStartedAt === undefined) {
      return;
    }
    const key = this.trackRuntimeKey(nodeId, instanceId);

    const watermark = this.runtimeGenerationWatermarkByNode.get(key);
    if (watermark !== undefined && incomingStartedAt < watermark) {
      return;
    }
    // After the stale check: a delayed message must not redirect instance-less reads.
    this.latestRuntimeKeyByNode.set(nodeId, key);
    if (
      watermark === incomingStartedAt
      && this.blockedRuntimeGenerationByNode.get(key) === incomingStartedAt
    ) {
      if (
        incoming.extensionVersion
        && this.reconnectableRuntimeGenerationByNode.get(key) === incomingStartedAt
      ) {
        this.blockedRuntimeGenerationByNode.delete(key);
        this.reconnectableRuntimeGenerationByNode.delete(key);
        this.runtimeByNode.set(key, incoming);
      }
      return;
    }

    const current = this.runtimeByNode.get(key);
    const currentStartedAt = current?.extensionStartedAt;
    const currentVersion = current?.extensionVersion;
    if (currentStartedAt === incomingStartedAt) {
      if (!incoming.extensionVersion || currentVersion === incoming.extensionVersion) {
        return;
      }
      if (currentVersion !== undefined && currentVersion !== incoming.extensionVersion) {
        this.runtimeByNode.set(key, { extensionStartedAt: incomingStartedAt });
        this.blockedRuntimeGenerationByNode.set(key, incomingStartedAt);
        this.reconnectableRuntimeGenerationByNode.delete(key);
        return;
      }
    }

    this.runtimeGenerationWatermarkByNode.set(key, incomingStartedAt);
    if (incoming.extensionVersion === undefined) {
      this.blockedRuntimeGenerationByNode.set(key, incomingStartedAt);
      this.reconnectableRuntimeGenerationByNode.delete(key);
    } else {
      this.blockedRuntimeGenerationByNode.delete(key);
      this.reconnectableRuntimeGenerationByNode.delete(key);
    }
    this.runtimeByNode.set(key, incoming);
  }

  private invalidateExtensionRuntime(
    key: string,
    exposeTombstone: boolean,
    options: { reconnectable?: boolean } = {},
  ): void {
    const currentStartedAt = this.runtimeByNode.get(key)?.extensionStartedAt
      ?? this.runtimeGenerationWatermarkByNode.get(key);
    if (currentStartedAt === undefined) {
      this.runtimeByNode.delete(key);
      return;
    }
    this.runtimeGenerationWatermarkByNode.set(key, currentStartedAt);
    this.blockedRuntimeGenerationByNode.set(key, currentStartedAt);
    if (options.reconnectable) {
      this.reconnectableRuntimeGenerationByNode.set(key, currentStartedAt);
    } else {
      this.reconnectableRuntimeGenerationByNode.delete(key);
    }
    if (exposeTombstone) {
      this.runtimeByNode.set(key, { extensionStartedAt: currentStartedAt });
    } else {
      this.runtimeByNode.delete(key);
    }
  }

  /**
   * Runtime evidence for one install when `extensionInstanceId` is given.
   * Without it, the install that most recently sent evidence — which is the
   * only install on a single-profile machine, i.e. the pre-instance behaviour.
   */
  getExtensionRuntime(
    nodeId: string,
    extensionInstanceId?: string,
  ): BrowserExtensionRuntimeRecord | undefined {
    const instanceId = normalizeBrowserExtensionInstanceId(extensionInstanceId);
    const key = instanceId
      ? runtimeKey(nodeId, instanceId)
      : this.latestRuntimeKeyByNode.get(nodeId) ?? nodeId;
    return this.runtimeByNode.get(key);
  }

  forgetNode(nodeId: string, options: { preserveRuntimeWatermark?: boolean } = {}): void {
    this.lastContactAtByNode.delete(nodeId);
    this.gapStatsByNode.delete(nodeId);
    this.lastDisconnectByNode.delete(nodeId);
    for (const key of this.runtimeKeysFor(nodeId)) {
      if (options.preserveRuntimeWatermark) {
        this.invalidateExtensionRuntime(key, true, { reconnectable: true });
      } else {
        this.runtimeByNode.delete(key);
        this.runtimeGenerationWatermarkByNode.delete(key);
        this.blockedRuntimeGenerationByNode.delete(key);
        this.reconnectableRuntimeGenerationByNode.delete(key);
      }
    }
    if (!options.preserveRuntimeWatermark) {
      this.runtimeKeysByNode.delete(nodeId);
      this.latestRuntimeKeyByNode.delete(nodeId);
    }
  }

  private trackRuntimeKey(nodeId: string, instanceId: string | undefined): string {
    const key = runtimeKey(nodeId, instanceId);
    let keys = this.runtimeKeysByNode.get(nodeId);
    if (!keys) {
      keys = new Set<string>();
      this.runtimeKeysByNode.set(nodeId, keys);
    }
    keys.add(key);
    return key;
  }

  /** Includes the bare node key so state recorded before any instance is covered. */
  private runtimeKeysFor(nodeId: string): string[] {
    return [...new Set<string>([nodeId, ...(this.runtimeKeysByNode.get(nodeId) ?? [])])];
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

function runtimeKey(nodeId: string, instanceId: string | undefined): string {
  // NUL cannot occur in a node id or a normalized instance id.
  return instanceId ? `${nodeId}\u0000${instanceId}` : nodeId;
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
