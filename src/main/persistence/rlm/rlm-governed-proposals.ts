/**
 * RLM Governed Proposals Module
 *
 * CRUD for `governed_proposals` (the durable, human-reviewable queue of
 * agent-derived memory/skill/hook/rule candidates) and `proposal_audit` (the
 * append-only decision trail for every mutation). Schema: migration
 * 056_governed_proposals.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';

// ---- Types ----------------------------------------------------------------

export type GovernedProposalKind = 'memory' | 'skill' | 'hook' | 'rule';
export type GovernedProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type ProposalAuditAction =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'superseded'
  | 'reinforced'
  | 'backfilled';

export interface GovernedProposalRow {
  id: string;
  kind: GovernedProposalKind;
  status: GovernedProposalStatus;
  provenance: string;
  title: string;
  description: string;
  payload_json: string;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  decision_rationale: string | null;
  reinforcements: number;
  related_ids_json: string;
  tags_json: string;
}

export interface GovernedProposal {
  id: string;
  kind: GovernedProposalKind;
  status: GovernedProposalStatus;
  provenance: string;
  title: string;
  description: string;
  payloadJson: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionRationale: string | null;
  reinforcements: number;
  relatedIdsJson: string;
  tagsJson: string;
}

export interface ProposalAuditRow {
  id: number;
  proposal_id: string;
  action: ProposalAuditAction;
  actor: string | null;
  timestamp: number;
  reason: string | null;
  metadata_json: string;
}

export interface ProposalAuditEntry {
  id: number;
  proposalId: string;
  action: ProposalAuditAction;
  actor: string | null;
  timestamp: number;
  reason: string | null;
  metadataJson: string;
}

function toProposal(row: GovernedProposalRow): GovernedProposal {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    provenance: row.provenance,
    title: row.title,
    description: row.description,
    payloadJson: row.payload_json,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionRationale: row.decision_rationale,
    reinforcements: row.reinforcements,
    relatedIdsJson: row.related_ids_json,
    tagsJson: row.tags_json,
  };
}

function toAuditEntry(row: ProposalAuditRow): ProposalAuditEntry {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    action: row.action,
    actor: row.actor,
    timestamp: row.timestamp,
    reason: row.reason,
    metadataJson: row.metadata_json,
  };
}

// ---- Proposals: write -------------------------------------------------------

export interface InsertGovernedProposalParams {
  id: string;
  kind: GovernedProposalKind;
  status?: GovernedProposalStatus;
  provenance: string;
  title: string;
  description?: string;
  payloadJson?: string;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  createdAt: number;
  reinforcements?: number;
  relatedIdsJson?: string;
  tagsJson?: string;
}

export function insertGovernedProposal(db: SqliteDriver, params: InsertGovernedProposalParams): void {
  db.prepare(`
    INSERT INTO governed_proposals
      (id, kind, status, provenance, title, description, payload_json,
       source_session_id, source_message_id, created_at, reinforcements,
       related_ids_json, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.kind,
    params.status ?? 'pending',
    params.provenance,
    params.title,
    params.description ?? '',
    params.payloadJson ?? '{}',
    params.sourceSessionId ?? null,
    params.sourceMessageId ?? null,
    params.createdAt,
    params.reinforcements ?? 1,
    params.relatedIdsJson ?? '[]',
    params.tagsJson ?? '[]',
  );
}

export interface UpdateGovernedProposalParams {
  status?: GovernedProposalStatus;
  payloadJson?: string;
  description?: string;
  decidedAt?: number | null;
  decidedBy?: string | null;
  decisionRationale?: string | null;
  reinforcements?: number;
  relatedIdsJson?: string;
  tagsJson?: string;
}

export function updateGovernedProposal(
  db: SqliteDriver,
  id: string,
  updates: UpdateGovernedProposalParams,
): void {
  const setClauses: string[] = [];
  const args: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    args.push(updates.status);
  }
  if (updates.payloadJson !== undefined) {
    setClauses.push('payload_json = ?');
    args.push(updates.payloadJson);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    args.push(updates.description);
  }
  if (updates.decidedAt !== undefined) {
    setClauses.push('decided_at = ?');
    args.push(updates.decidedAt);
  }
  if (updates.decidedBy !== undefined) {
    setClauses.push('decided_by = ?');
    args.push(updates.decidedBy);
  }
  if (updates.decisionRationale !== undefined) {
    setClauses.push('decision_rationale = ?');
    args.push(updates.decisionRationale);
  }
  if (updates.reinforcements !== undefined) {
    setClauses.push('reinforcements = ?');
    args.push(updates.reinforcements);
  }
  if (updates.relatedIdsJson !== undefined) {
    setClauses.push('related_ids_json = ?');
    args.push(updates.relatedIdsJson);
  }
  if (updates.tagsJson !== undefined) {
    setClauses.push('tags_json = ?');
    args.push(updates.tagsJson);
  }

  if (setClauses.length === 0) return;

  args.push(id);
  db.prepare(`UPDATE governed_proposals SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

// ---- Proposals: read --------------------------------------------------------

export function getGovernedProposal(db: SqliteDriver, id: string): GovernedProposal | null {
  const row = db.prepare('SELECT * FROM governed_proposals WHERE id = ?').get<GovernedProposalRow>(id);
  return row ? toProposal(row) : null;
}

export interface ListGovernedProposalsQuery {
  kind?: GovernedProposalKind;
  status?: GovernedProposalStatus;
  sourceSessionId?: string;
  limit?: number;
}

export function listGovernedProposals(
  db: SqliteDriver,
  query: ListGovernedProposalsQuery = {},
): GovernedProposal[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (query.kind) {
    clauses.push('kind = ?');
    args.push(query.kind);
  }
  if (query.status) {
    clauses.push('status = ?');
    args.push(query.status);
  }
  if (query.sourceSessionId) {
    clauses.push('source_session_id = ?');
    args.push(query.sourceSessionId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
  const rows = db.prepare(`
    SELECT * FROM governed_proposals
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `).all<GovernedProposalRow>(...args);
  return rows.map(toProposal);
}

/**
 * Find a pending proposal for the given kind whose title matches exactly.
 * Used for reinforce-don't-duplicate; callers MUST pass an already-normalized
 * title so this is effectively a normalized-text dedup lookup.
 */
export function findPendingProposalByTitle(
  db: SqliteDriver,
  kind: GovernedProposalKind,
  title: string,
): GovernedProposal | null {
  const row = db.prepare(`
    SELECT * FROM governed_proposals
    WHERE kind = ? AND status = 'pending' AND title = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get<GovernedProposalRow>(kind, title);
  return row ? toProposal(row) : null;
}

export function countProposalsByKind(db: SqliteDriver, kind: GovernedProposalKind): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM governed_proposals WHERE kind = ?').get<{ count: number }>(kind);
  return row?.count ?? 0;
}

// ---- Audit -------------------------------------------------------------------

export interface InsertProposalAuditParams {
  proposalId: string;
  action: ProposalAuditAction;
  actor?: string | null;
  timestamp: number;
  reason?: string | null;
  metadataJson?: string;
}

export function insertProposalAudit(db: SqliteDriver, params: InsertProposalAuditParams): void {
  db.prepare(`
    INSERT INTO proposal_audit (proposal_id, action, actor, timestamp, reason, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.proposalId,
    params.action,
    params.actor ?? null,
    params.timestamp,
    params.reason ?? null,
    params.metadataJson ?? '{}',
  );
}

export function listProposalAudit(db: SqliteDriver, proposalId: string): ProposalAuditEntry[] {
  const rows = db.prepare(`
    SELECT * FROM proposal_audit WHERE proposal_id = ? ORDER BY timestamp ASC, id ASC
  `).all<ProposalAuditRow>(proposalId);
  return rows.map(toAuditEntry);
}

/** Whether an audit entry with the given action has ever been written (used for one-time backfill guards). */
export function hasAuditAction(db: SqliteDriver, action: ProposalAuditAction): boolean {
  const row = db.prepare('SELECT 1 as found FROM proposal_audit WHERE action = ? LIMIT 1').get<{ found: number }>(action);
  return row !== undefined;
}
