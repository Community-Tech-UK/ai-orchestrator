/**
 * GovernedProposalStore — persistence facade over `governed_proposals` /
 * `proposal_audit` for the WS-A4 memory promotion review inbox.
 *
 * Design rules (mirrors SkillAttributionService):
 *   - Lazily binds to the RLM database; if RLM is not initialised (unit
 *     tests, early startup) writes are skipped fail-soft and reads return
 *     empty results rather than throwing.
 *   - Every mutation (create/decide/reinforce) writes a `proposal_audit` row
 *     in the same call so the decision trail can never silently drift from
 *     the proposal state.
 *   - Dedup is "reinforce, don't duplicate": capturing a proposal for a kind
 *     whose normalized title already has a PENDING row bumps that row's
 *     `reinforcements` counter instead of inserting a near-duplicate.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  countProposalsByKind,
  findPendingProposalByTitle,
  getGovernedProposal,
  hasAuditAction,
  insertGovernedProposal,
  insertProposalAudit,
  listGovernedProposals,
  listProposalAudit,
  updateGovernedProposal,
  type GovernedProposal,
  type GovernedProposalKind,
  type GovernedProposalStatus,
  type InsertGovernedProposalParams,
  type ListGovernedProposalsQuery,
  type ProposalAuditAction,
  type ProposalAuditEntry,
  type UpdateGovernedProposalParams,
} from '../persistence/rlm/rlm-governed-proposals';

export type {
  GovernedProposal,
  GovernedProposalKind,
  GovernedProposalStatus,
  ProposalAuditAction,
  ProposalAuditEntry,
} from '../persistence/rlm/rlm-governed-proposals';

const logger = getLogger('GovernedProposalStore');

export interface CaptureProposalParams {
  kind: GovernedProposalKind;
  /** Normalized dedup key — callers own normalization for their kind. */
  normalizedTitle: string;
  title: string;
  provenance: string;
  description?: string;
  payloadJson?: string;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  relatedIdsJson?: string;
  tagsJson?: string;
  actor?: string | null;
}

export interface CaptureProposalResult {
  proposal: GovernedProposal;
  reinforced: boolean;
}

export class GovernedProposalStore extends EventEmitter {
  private static instance: GovernedProposalStore | null = null;

  private db: SqliteDriver | null = null;
  private dbResolved = false;

  static getInstance(): GovernedProposalStore {
    if (!GovernedProposalStore.instance) {
      GovernedProposalStore.instance = new GovernedProposalStore();
    }
    return GovernedProposalStore.instance;
  }

  static _resetForTesting(): void {
    if (GovernedProposalStore.instance) {
      GovernedProposalStore.instance.removeAllListeners();
    }
    GovernedProposalStore.instance = null;
  }

  /** Test seam: bind directly to a database instead of the RLM singleton. */
  _bindDatabaseForTesting(db: SqliteDriver): void {
    this.db = db;
    this.dbResolved = true;
  }

  /** Test seam: simulate a permanently unavailable database. */
  _bindUnavailableForTesting(): void {
    this.db = null;
    this.dbResolved = true;
  }

  private resolveDb(): SqliteDriver | null {
    if (this.db) return this.db;
    if (this.dbResolved) return null;
    this.dbResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) {
        this.dbResolved = false; // retry on next call; RLM may init later
        return null;
      }
      this.db = rlm.getDb();
      return this.db;
    } catch (err) {
      logger.warn('RLM database unavailable; governed proposal store disabled', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Capture (create-or-reinforce) a proposal. Fail-soft: returns null when
   * the database is unavailable rather than throwing on the memory hot path.
   */
  capture(params: CaptureProposalParams): CaptureProposalResult | null {
    const db = this.resolveDb();
    if (!db) return null;
    const now = Date.now();

    try {
      const existing = findPendingProposalByTitle(db, params.kind, params.normalizedTitle);
      if (existing) {
        const reinforcements = existing.reinforcements + 1;
        updateGovernedProposal(db, existing.id, { reinforcements });
        this.writeAudit(db, {
          proposalId: existing.id,
          action: 'reinforced',
          actor: params.actor ?? null,
          timestamp: now,
          metadataJson: JSON.stringify({ reinforcements }),
        });
        const updated = getGovernedProposal(db, existing.id)!;
        this.emit('proposal:reinforced', updated);
        return { proposal: updated, reinforced: true };
      }

      const id = crypto.randomUUID();
      const insertParams: InsertGovernedProposalParams = {
        id,
        kind: params.kind,
        provenance: params.provenance,
        title: params.normalizedTitle,
        description: params.description ?? params.title,
        payloadJson: params.payloadJson,
        sourceSessionId: params.sourceSessionId ?? null,
        sourceMessageId: params.sourceMessageId ?? null,
        createdAt: now,
        relatedIdsJson: params.relatedIdsJson,
        tagsJson: params.tagsJson,
      };
      insertGovernedProposal(db, insertParams);
      this.writeAudit(db, {
        proposalId: id,
        action: 'created',
        actor: params.actor ?? null,
        timestamp: now,
      });
      const created = getGovernedProposal(db, id)!;
      this.emit('proposal:created', created);
      return { proposal: created, reinforced: false };
    } catch (err) {
      logger.warn('capture failed (fail-soft)', {
        kind: params.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  get(id: string): GovernedProposal | null {
    const db = this.resolveDb();
    if (!db) return null;
    try {
      return getGovernedProposal(db, id);
    } catch (err) {
      logger.warn('get failed (fail-soft)', { id, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  list(query: ListGovernedProposalsQuery = {}): GovernedProposal[] {
    const db = this.resolveDb();
    if (!db) return [];
    try {
      return listGovernedProposals(db, query);
    } catch (err) {
      logger.warn('list failed (fail-soft)', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  getAuditTrail(proposalId: string): ProposalAuditEntry[] {
    const db = this.resolveDb();
    if (!db) return [];
    try {
      return listProposalAudit(db, proposalId);
    } catch (err) {
      logger.warn('getAuditTrail failed (fail-soft)', {
        proposalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Whether a one-time audit action (e.g. 'backfilled') has ever run. */
  hasEverRun(action: ProposalAuditAction): boolean {
    const db = this.resolveDb();
    if (!db) return false;
    try {
      return hasAuditAction(db, action);
    } catch {
      return false;
    }
  }

  countByKind(kind: GovernedProposalKind): number {
    const db = this.resolveDb();
    if (!db) return 0;
    try {
      return countProposalsByKind(db, kind);
    } catch {
      return 0;
    }
  }

  /**
   * Apply a status transition + audit entry in one step. Callers (the
   * service layer) own decision semantics; this is a thin, always-audited
   * persistence primitive.
   */
  applyDecision(
    id: string,
    updates: UpdateGovernedProposalParams,
    audit: { action: ProposalAuditAction; actor?: string | null; reason?: string | null; metadataJson?: string },
  ): GovernedProposal | null {
    const db = this.resolveDb();
    if (!db) return null;
    try {
      updateGovernedProposal(db, id, updates);
      const now = Date.now();
      this.writeAudit(db, {
        proposalId: id,
        action: audit.action,
        actor: audit.actor ?? null,
        timestamp: now,
        reason: audit.reason ?? null,
        metadataJson: audit.metadataJson,
      });
      const updated = getGovernedProposal(db, id);
      if (updated) this.emit('proposal:decided', updated);
      return updated;
    } catch (err) {
      logger.warn('applyDecision failed', {
        id,
        action: audit.action,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Insert a standalone audit row (e.g. 'backfilled') not tied to a status change. */
  writeAuditOnly(proposalId: string, action: ProposalAuditAction, opts: { actor?: string | null; reason?: string | null; metadataJson?: string } = {}): void {
    const db = this.resolveDb();
    if (!db) return;
    try {
      this.writeAudit(db, {
        proposalId,
        action,
        actor: opts.actor ?? null,
        timestamp: Date.now(),
        reason: opts.reason ?? null,
        metadataJson: opts.metadataJson,
      });
    } catch (err) {
      logger.warn('writeAuditOnly failed', {
        proposalId,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private writeAudit(
    db: SqliteDriver,
    params: { proposalId: string; action: ProposalAuditAction; actor?: string | null; timestamp: number; reason?: string | null; metadataJson?: string },
  ): void {
    insertProposalAudit(db, params);
  }
}

export function getGovernedProposalStore(): GovernedProposalStore {
  return GovernedProposalStore.getInstance();
}
