import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  ArtifactOwnerType,
  ArtifactRegistryRecord,
} from '../../shared/types/artifact-cleanup.types';

interface ArtifactRegistryRow {
  id: string;
  owner_type: ArtifactOwnerType;
  owner_id: string;
  kind: string;
  path: string;
  protected: number;
  metadata_json: string | null;
  created_at: number;
  last_seen_at: number;
}

export class ArtifactAttributionStore {
  constructor(private readonly db: SqliteDriver = getRLMDatabase().getRawDb()) {}

  registerArtifact(input: {
    ownerType: ArtifactOwnerType;
    ownerId: string;
    kind: string;
    path: string;
    protected?: boolean;
    metadata?: Record<string, unknown>;
  }, now = Date.now()): ArtifactRegistryRecord {
    const id = crypto.createHash('sha256')
      .update(`${input.ownerType}:${input.ownerId}:${input.path}`)
      .digest('hex');
    this.db.prepare(`
      INSERT INTO artifact_registry
        (id, owner_type, owner_id, kind, path, protected, metadata_json, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path, owner_type, owner_id) DO UPDATE SET
        kind = excluded.kind,
        protected = excluded.protected,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      id,
      input.ownerType,
      input.ownerId,
      input.kind,
      input.path,
      input.protected === true ? 1 : 0,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): ArtifactRegistryRecord | null {
    const row = this.db.prepare(`SELECT * FROM artifact_registry WHERE id = ?`).get<ArtifactRegistryRow>(id);
    return row ? this.map(row) : null;
  }

  listCleanupCandidates(olderThan: number, limit = 100): ArtifactRegistryRecord[] {
    return this.db.prepare(`
      SELECT *
      FROM artifact_registry
      WHERE last_seen_at <= ?
      ORDER BY last_seen_at ASC
      LIMIT ?
    `).all<ArtifactRegistryRow>(olderThan, limit).map((row) => this.map(row));
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM artifact_registry WHERE id = ?`).run(id);
  }

  private map(row: ArtifactRegistryRow): ArtifactRegistryRecord {
    return {
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      kind: row.kind,
      path: row.path,
      protected: row.protected === 1,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }
}

let artifactAttributionStore: ArtifactAttributionStore | null = null;

export function getArtifactAttributionStore(): ArtifactAttributionStore {
  if (!artifactAttributionStore) {
    artifactAttributionStore = new ArtifactAttributionStore();
  }
  return artifactAttributionStore;
}

export function _resetArtifactAttributionStoreForTesting(): void {
  artifactAttributionStore = null;
}
