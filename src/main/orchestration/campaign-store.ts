/**
 * Campaign Mode Persistence (DAO)
 *
 * Stores campaigns and campaign_nodes in the same SQLite DB as loop_runs.
 * Schema is added by migration 007_campaigns in loop-schema.ts.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type {
  CampaignNodeRun,
  CampaignNodeStatus,
  CampaignRun,
  CampaignSpec,
  CampaignStatus,
} from './campaign.types';

const logger = getLogger('CampaignStore');

// -------------------------------------------------------------------------
// Row shapes
// -------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  spec_json: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  paused_reason: string | null;
  updated_at: number;
}

interface CampaignNodeRow {
  node_id: string;
  campaign_id: string;
  status: string;
  loop_run_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  skipped_reason: string | null;
  updated_at: number;
}

// -------------------------------------------------------------------------
// CampaignStore DAO
// -------------------------------------------------------------------------

export class CampaignStore {
  constructor(private readonly db: SqliteDriver) {}

  // -------------------------------------------------------------------------
  // Campaign CRUD
  // -------------------------------------------------------------------------

  upsertCampaign(run: Pick<CampaignRun, 'id' | 'spec' | 'status' | 'startedAt' | 'endedAt' | 'pausedReason'>): void {
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO campaigns (id, spec_json, status, started_at, ended_at, paused_reason, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          spec_json    = excluded.spec_json,
          status       = excluded.status,
          ended_at     = excluded.ended_at,
          paused_reason = excluded.paused_reason,
          updated_at   = excluded.updated_at
      `).run(
        run.id,
        JSON.stringify(run.spec),
        run.status,
        run.startedAt,
        run.endedAt ?? null,
        run.pausedReason ?? null,
        now,
      );
    } catch (err) {
      logger.error('CampaignStore.upsertCampaign failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  getCampaign(campaignId: string): CampaignRun | null {
    try {
      const row = this.db.prepare(
        'SELECT * FROM campaigns WHERE id = ?',
      ).get<CampaignRow>(campaignId);
      if (!row) return null;
      return this.rowToCampaignRun(row);
    } catch (err) {
      logger.error('CampaignStore.getCampaign failed', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  listActiveCampaigns(): CampaignRun[] {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM campaigns WHERE status IN ('pending', 'running', 'paused') ORDER BY started_at DESC",
      ).all<CampaignRow>();
      return rows.map((r) => this.rowToCampaignRun(r));
    } catch (err) {
      logger.error('CampaignStore.listActiveCampaigns failed', err instanceof Error ? err : new Error(String(err)));
      return [];
    }
  }

  listAllCampaigns(limit = 50): CampaignRun[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM campaigns ORDER BY started_at DESC LIMIT ?',
      ).all<CampaignRow>(limit);
      return rows.map((r) => this.rowToCampaignRun(r));
    } catch (err) {
      logger.error('CampaignStore.listAllCampaigns failed', err instanceof Error ? err : new Error(String(err)));
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Campaign node CRUD
  // -------------------------------------------------------------------------

  upsertNode(node: Omit<CampaignNodeRun, never>): void {
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO campaign_nodes (node_id, campaign_id, status, loop_run_id, started_at, ended_at, skipped_reason, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, node_id) DO UPDATE SET
          status        = excluded.status,
          loop_run_id   = excluded.loop_run_id,
          started_at    = COALESCE(campaign_nodes.started_at, excluded.started_at),
          ended_at      = excluded.ended_at,
          skipped_reason = excluded.skipped_reason,
          updated_at    = excluded.updated_at
      `).run(
        node.nodeId,
        node.campaignId,
        node.status,
        node.loopRunId ?? null,
        node.startedAt ?? null,
        node.endedAt ?? null,
        node.skippedReason ?? null,
        now,
      );
    } catch (err) {
      logger.error('CampaignStore.upsertNode failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  getNodeRuns(campaignId: string): Map<string, CampaignNodeRun> {
    const result = new Map<string, CampaignNodeRun>();
    try {
      const rows = this.db.prepare(
        'SELECT * FROM campaign_nodes WHERE campaign_id = ?',
      ).all<CampaignNodeRow>(campaignId);
      for (const r of rows) {
        result.set(r.node_id, this.rowToNodeRun(r));
      }
    } catch (err) {
      logger.error('CampaignStore.getNodeRuns failed', err instanceof Error ? err : new Error(String(err)));
    }
    return result;
  }

  /** Find the campaign and node that own a given loop run. */
  findNodeByLoopRunId(loopRunId: string): { campaignId: string; nodeId: string } | null {
    try {
      const row = this.db.prepare(
        'SELECT campaign_id, node_id FROM campaign_nodes WHERE loop_run_id = ?',
      ).get<{ campaign_id: string; node_id: string }>(loopRunId);
      if (!row) return null;
      return { campaignId: row.campaign_id, nodeId: row.node_id };
    } catch (err) {
      logger.error('CampaignStore.findNodeByLoopRunId failed', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private rowToCampaignRun(row: CampaignRow): CampaignRun {
    const spec = JSON.parse(row.spec_json) as CampaignSpec;
    const nodeRuns = this.getNodeRuns(row.id);
    return {
      id: row.id,
      spec,
      status: row.status as CampaignStatus,
      nodeRuns,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      pausedReason: row.paused_reason ?? undefined,
    };
  }

  private rowToNodeRun(row: CampaignNodeRow): CampaignNodeRun {
    return {
      nodeId: row.node_id,
      campaignId: row.campaign_id,
      status: row.status as CampaignNodeStatus,
      loopRunId: row.loop_run_id ?? undefined,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
      skippedReason: row.skipped_reason ?? undefined,
    };
  }
}
