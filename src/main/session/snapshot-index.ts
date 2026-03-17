/**
 * SnapshotIndex
 *
 * In-memory index for fast snapshot lookups without disk I/O.
 * Tracks snapshot metadata keyed by id, with secondary lookups by
 * instance id, stable thread id, and native provider session id.
 */

export interface SnapshotMeta {
  id: string;
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  timestamp: number;
  messageCount: number;
  schemaVersion: number;
}

export class SnapshotIndex {
  private byId = new Map<string, SnapshotMeta>();
  private byIdentifier = new Map<string, Set<string>>();

  private getLookupKeys(meta: Pick<SnapshotMeta, 'instanceId' | 'sessionId' | 'historyThreadId'>): string[] {
    const keys = new Set<string>();
    const addKey = (value: string | undefined): void => {
      const normalized = value?.trim();
      if (normalized) {
        keys.add(normalized);
      }
    };

    addKey(meta.instanceId);
    addKey(meta.historyThreadId);
    addKey(meta.sessionId);

    return Array.from(keys);
  }

  /**
   * Add or update a snapshot entry.
   */
  add(meta: SnapshotMeta): void {
    const existing = this.byId.get(meta.id);

    if (existing) {
      this.removeFromIdentifierIndex(meta.id, existing);
    }

    this.byId.set(meta.id, meta);

    for (const key of this.getLookupKeys(meta)) {
      let identifierSet = this.byIdentifier.get(key);
      if (!identifierSet) {
        identifierSet = new Set<string>();
        this.byIdentifier.set(key, identifierSet);
      }
      identifierSet.add(meta.id);
    }
  }

  /**
   * Remove a snapshot entry by id.
   */
  remove(id: string): void {
    const meta = this.byId.get(id);
    if (!meta) return;

    this.removeFromIdentifierIndex(id, meta);
    this.byId.delete(id);
  }

  /**
   * Get a single snapshot entry by id.
   */
  get(id: string): SnapshotMeta | undefined {
    return this.byId.get(id);
  }

  /**
   * List all snapshots for a specific instance, thread, or native session id,
   * sorted by timestamp descending (newest first).
   */
  listForIdentifier(identifier: string): SnapshotMeta[] {
    const normalized = identifier.trim();
    if (!normalized) return [];

    const ids = this.byIdentifier.get(normalized);
    if (!ids || ids.size === 0) return [];

    return Array.from(ids)
      .map(id => this.byId.get(id)!)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Backward-compatible alias retained for callers that still pass a
   * session-like identifier.
   */
  listForSession(sessionId: string): SnapshotMeta[] {
    return this.listForIdentifier(sessionId);
  }

  /**
   * List all snapshots across all sessions, sorted by timestamp descending.
   */
  listAll(): SnapshotMeta[] {
    return Array.from(this.byId.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Return snapshots with timestamp strictly less than cutoffTimestamp.
   * Sorted by timestamp descending.
   */
  getExpiredBefore(cutoffTimestamp: number): SnapshotMeta[] {
    return Array.from(this.byId.values())
      .filter(meta => meta.timestamp < cutoffTimestamp)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Return the excess snapshots for a session beyond maxCount.
   * The excess entries are the oldest ones (those beyond the maxCount newest).
   * Returns them sorted oldest-first (the ones that should be removed first).
   */
  getExcessForSession(sessionId: string, maxCount: number): SnapshotMeta[] {
    const sorted = this.listForIdentifier(sessionId); // newest first
    if (sorted.length <= maxCount) return [];

    // Entries beyond the newest maxCount are excess; return oldest first.
    return sorted.slice(maxCount).reverse();
  }

  /**
   * Total number of snapshot entries in the index.
   */
  get size(): number {
    return this.byId.size;
  }

  private removeFromIdentifierIndex(id: string, meta: Pick<SnapshotMeta, 'instanceId' | 'sessionId' | 'historyThreadId'>): void {
    for (const key of this.getLookupKeys(meta)) {
      const identifierSet = this.byIdentifier.get(key);
      if (identifierSet) {
        identifierSet.delete(id);
        if (identifierSet.size === 0) {
          this.byIdentifier.delete(key);
        }
      }
    }
  }
}
