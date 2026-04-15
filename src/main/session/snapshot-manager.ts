/**
 * SnapshotManager — Manages session snapshot creation, listing, loading, and pruning.
 *
 * Extracted from session-continuity.ts to isolate snapshot persistence
 * and retention policy logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { SessionSnapshot, SessionState } from './session-continuity';
import type { SnapshotIndex } from './snapshot-index';
import { getLogger } from '../logging/logger';

const logger = getLogger('SnapshotManager');

const CURRENT_SCHEMA_VERSION = 2;

/** Retention config for snapshot pruning. */
export interface SnapshotRetentionConfig {
  maxSnapshots: number;
  maxTotalSnapshots: number;
  snapshotRetentionDays: number;
}

/** I/O operations the SnapshotManager delegates to the parent persistence layer. */
export interface SnapshotPersistenceOps {
  writePayload: (filePath: string, data: unknown) => Promise<void>;
  readPayload: <T>(filePath: string) => Promise<T | null>;
  migrateSessionState: (raw: Record<string, unknown>) => Record<string, unknown>;
}

export class SnapshotManager extends EventEmitter {
  constructor(
    private readonly snapshotDir: string,
    private readonly snapshotIndex: SnapshotIndex,
    private readonly persistence: SnapshotPersistenceOps,
    private retentionConfig: SnapshotRetentionConfig,
  ) {
    super();
  }

  /** Update retention config (e.g. from user settings change). */
  updateRetentionConfig(config: Partial<SnapshotRetentionConfig>): void {
    this.retentionConfig = { ...this.retentionConfig, ...config };
  }

  /**
   * Create a named snapshot for an instance.
   */
  async createSnapshot(
    state: SessionState,
    instanceId: string,
    name?: string,
    description?: string,
    trigger: 'auto' | 'manual' | 'checkpoint' = 'manual',
    normalizeLookup?: (value: string | null | undefined) => string | null,
  ): Promise<SessionSnapshot | null> {
    if (!state) return null;

    let stateClone: SessionState;
    try {
      stateClone = structuredClone(state);
    } catch {
      stateClone = JSON.parse(JSON.stringify(state)) as SessionState;
    }

    const normalizeId = normalizeLookup ?? ((v: string | null | undefined) => v ?? null);

    const snapshot: SessionSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      instanceId,
      sessionId: normalizeId(state.sessionId) ?? undefined,
      historyThreadId: normalizeId(state.historyThreadId) ?? undefined,
      timestamp: Date.now(),
      name,
      description,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: stateClone,
      metadata: {
        messageCount: state.conversationHistory.length,
        tokensUsed: state.contextUsage.used,
        duration: Date.now() - (state.conversationHistory[0]?.timestamp || Date.now()),
        trigger,
      },
    };

    // Save snapshot
    const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
    await this.persistence.writePayload(snapshotFile, snapshot);

    // Update index
    this.snapshotIndex.add({
      id: snapshot.id,
      instanceId: snapshot.instanceId,
      sessionId: snapshot.sessionId,
      historyThreadId: snapshot.historyThreadId,
      timestamp: snapshot.timestamp,
      messageCount: snapshot.metadata.messageCount,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });

    // Cleanup old snapshots
    await this.cleanupSnapshots(instanceId);

    this.emit('snapshot:created', snapshot);
    return snapshot;
  }

  /**
   * List available snapshots for a session — synchronous, uses index.
   */
  listSnapshots(identifier?: string): SessionSnapshot[] {
    const metas = identifier
      ? this.snapshotIndex.listForIdentifier(identifier)
      : this.snapshotIndex.listAll();

    return metas.map((meta) => ({
      id: meta.id,
      instanceId: meta.instanceId,
      sessionId: meta.sessionId,
      historyThreadId: meta.historyThreadId,
      timestamp: meta.timestamp,
      schemaVersion: meta.schemaVersion,
      state: {} as SessionState, // not loaded for listing
      metadata: {
        messageCount: meta.messageCount,
        tokensUsed: 0,
        duration: 0,
        trigger: 'auto' as const,
      },
    }));
  }

  /**
   * Load a specific snapshot from disk.
   */
  async loadSnapshot(snapshotId: string): Promise<SessionSnapshot | null> {
    const snapshotFile = path.join(this.snapshotDir, `${snapshotId}.json`);

    try {
      await fs.promises.access(snapshotFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const snapshot = await this.persistence.readPayload<SessionSnapshot>(snapshotFile);
    if (snapshot) {
      const migratedState = this.persistence.migrateSessionState(
        snapshot.state as unknown as Record<string, unknown>,
      );
      snapshot.state = migratedState as unknown as SessionState;
    }
    return snapshot;
  }

  /**
   * Prune snapshots for a specific instance using 3-tier retention policy:
   *   1. Age-based: Remove snapshots older than snapshotRetentionDays
   *   2. Per-session: Cap at maxSnapshots per session
   *   3. Global: Keep total under maxTotalSnapshots
   */
  async cleanupSnapshots(instanceId: string): Promise<void> {
    const cutoffTime =
      Date.now() - this.retentionConfig.snapshotRetentionDays * 24 * 60 * 60 * 1000;

    const toRemoveIds = new Set<string>();

    // 1. Expired snapshots (all sessions)
    for (const meta of this.snapshotIndex.getExpiredBefore(cutoffTime)) {
      toRemoveIds.add(meta.id);
    }

    // 2. After removing expired, compute excess for this session
    const sessionMetas = this.snapshotIndex
      .listForSession(instanceId)
      .filter((m) => !toRemoveIds.has(m.id));

    if (sessionMetas.length > this.retentionConfig.maxSnapshots) {
      const excess = sessionMetas.slice(this.retentionConfig.maxSnapshots);
      for (const meta of excess) {
        toRemoveIds.add(meta.id);
      }
    }

    // 3. Global cap
    const remainingTotal = this.snapshotIndex.size - toRemoveIds.size;
    if (remainingTotal > this.retentionConfig.maxTotalSnapshots) {
      const allMetas = this.snapshotIndex.listAll()
        .filter((m) => !toRemoveIds.has(m.id));
      const globalExcess = allMetas.slice(this.retentionConfig.maxTotalSnapshots);
      for (const meta of globalExcess) {
        toRemoveIds.add(meta.id);
      }
    }

    if (toRemoveIds.size > 0) {
      logger.info('Pruning snapshots', {
        count: toRemoveIds.size,
        remainingAfter: this.snapshotIndex.size - toRemoveIds.size,
        trigger: instanceId,
      });
    }

    await this.deleteSnapshotFiles(toRemoveIds);
  }

  /**
   * Global pruning pass — runs at startup to clean up age-expired and
   * globally over-limit snapshots without requiring an instanceId.
   */
  async pruneOnStartup(): Promise<void> {
    const cutoffTime =
      Date.now() - this.retentionConfig.snapshotRetentionDays * 24 * 60 * 60 * 1000;

    const toRemoveIds = new Set<string>();

    // Age-based pruning
    for (const meta of this.snapshotIndex.getExpiredBefore(cutoffTime)) {
      toRemoveIds.add(meta.id);
    }

    // Global cap pruning
    const remainingTotal = this.snapshotIndex.size - toRemoveIds.size;
    if (remainingTotal > this.retentionConfig.maxTotalSnapshots) {
      const allMetas = this.snapshotIndex.listAll()
        .filter((m) => !toRemoveIds.has(m.id));
      const globalExcess = allMetas.slice(this.retentionConfig.maxTotalSnapshots);
      for (const meta of globalExcess) {
        toRemoveIds.add(meta.id);
      }
    }

    if (toRemoveIds.size === 0) return;

    logger.info('Startup snapshot pruning', {
      count: toRemoveIds.size,
      remainingAfter: this.snapshotIndex.size - toRemoveIds.size,
    });

    await this.deleteSnapshotFiles(toRemoveIds);
  }

  /** Delete snapshot files + remove from index. */
  private async deleteSnapshotFiles(ids: Set<string>): Promise<void> {
    for (const id of ids) {
      const snapshotFile = path.join(this.snapshotDir, `${id}.json`);
      try {
        await fs.promises.unlink(snapshotFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Failed to delete snapshot', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.snapshotIndex.remove(id);
    }
  }
}
