import { classifyQuestionRisk } from '../../shared/attention/question-need';
import type { LoopOutstandingOutcome, LoopQuestionRiskClass } from '../../shared/types/loop-outstanding.types';
import type { OutstandingSections } from './loop-stage-markdown';
import { createHash } from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopOutstandingItem, LoopOutstandingItemKind, LoopOutstandingItemStatus, LoopState, LoopStatus } from '../../shared/types/loop.types';
/** Deterministic id for an aggregated outstanding item: same (run, kind, text)
 *  always collapses to the same row so re-captures upsert (and keep the user's
 *  resolved/dismissed status) instead of duplicating. */
export function outstandingItemId(
  loopRunId: string,
  kind: LoopOutstandingItemKind,
  text: string,
): string {
  return createHash('sha256').update(`${loopRunId}\0${kind}\0${text}`).digest('hex').slice(0, 32);
}

interface LoopOutstandingItemRow {
  id: string;
  loop_run_id: string;
  chat_id: string;
  workspace_cwd: string;
  kind: string;
  text: string;
  user_response: string | null;
  recommended_answer: string | null;
  status: string;
  loop_status: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  risk_class: LoopQuestionRiskClass | null;
  first_seen_round: number | null;
  outcome: LoopOutstandingOutcome | null;
  answer_sent_at: number | null;
}

function rowToOutstandingItem(row: LoopOutstandingItemRow): LoopOutstandingItem {
  return {
    id: row.id,
    loopRunId: row.loop_run_id,
    chatId: row.chat_id,
    workspaceCwd: row.workspace_cwd,
    kind: row.kind as LoopOutstandingItemKind,
    text: row.text,
    userResponse: row.user_response ?? null,
    recommendedAnswer: row.recommended_answer ?? null,
    status: row.status as LoopOutstandingItemStatus,
    loopStatus: row.loop_status as LoopStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    riskClass: row.risk_class ?? null, firstSeenRound: row.first_seen_round ?? null, outcome: row.outcome ?? null, answerSentAt: row.answer_sent_at ?? null,
  };
}

export interface OutstandingSnapshotResult { insertedIds: string[]; changedIds: string[]; closedIds: string[]; flagged: LoopOutstandingItem[] }

export function upsertOutstandingSnapshot(db: SqliteDriver, input: { state: LoopState; sections: OutstandingSections; round: number; legacyInformation?: boolean; riskOf?: typeof classifyQuestionRisk }): OutstandingSnapshotResult {
  const { state, sections } = input;
  const result: OutstandingSnapshotResult = { insertedIds: [], changedIds: [], closedIds: [], flagged: [] };
  db.transaction(() => {
    const previous = db.prepare('SELECT * FROM loop_outstanding_items WHERE loop_run_id = ?').all<LoopOutstandingItemRow>(state.id);
    const existing = new Map(previous.map(row => [row.id, row]));
    const rows = [
      ...sections.needsHuman.map(entry => ({ ...entry, kind: 'needs-human' as const })),
      ...sections.decisionsApplied.map(entry => ({ ...entry, kind: 'decision-applied' as const })),
      ...sections.forInformation.map(entry => ({ ...entry, kind: input.legacyInformation ? 'open-question' as const : 'for-information' as const })),
    ];
    const now = Date.now();
    const present = new Set<string>();
    const insert = db.prepare(`INSERT INTO loop_outstanding_items (id, loop_run_id, chat_id, workspace_cwd, kind, text, recommended_answer, status, loop_status, created_at, updated_at, resolved_at, risk_class, first_seen_round)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET recommended_answer = excluded.recommended_answer, loop_status = excluded.loop_status, updated_at = excluded.updated_at, risk_class = excluded.risk_class`);
    for (const row of rows) {
      const id = outstandingItemId(state.id, row.kind, row.text);
      present.add(id);
      const prior = existing.get(id);
      const risk = (input.riskOf ?? classifyQuestionRisk)(row.text, row.recommendation ?? '');
      insert.run(id, state.id, state.chatId, state.config.workspaceCwd, row.kind, row.text, row.recommendation, state.status, now, now, risk, input.round);
      if (!prior) result.insertedIds.push(id);
      else if (prior.recommended_answer !== row.recommendation || prior.risk_class !== risk) result.changedIds.push(id);
      if (risk && row.kind !== 'needs-human' && (!prior || prior.risk_class !== risk)) {
        result.flagged.push(rowToOutstandingItem(db.prepare('SELECT * FROM loop_outstanding_items WHERE id = ?').get<LoopOutstandingItemRow>(id)!));
      }
    }
    for (const row of previous) {
      if (row.status !== 'open' || present.has(row.id)) continue;
      const superseded = rows.some(next => next.kind === row.kind && next.text.length > row.text.length && next.text.startsWith(row.text));
      const outcome = superseded ? 'superseded' : row.outcome === 'undone' ? 'undone' : row.user_response ? 'answered' : 'withdrawn';
      db.prepare("UPDATE loop_outstanding_items SET status = 'resolved', outcome = ?, resolved_at = ?, updated_at = ? WHERE id = ?").run(outcome, now, now, row.id);
      result.closedIds.push(row.id);
    }
  })();
  return result;
}

export function recordOutstandingAnswer(db: SqliteDriver, id: string, input: { response?: string; status: LoopOutstandingItemStatus; outcome?: LoopOutstandingOutcome; answerSentAt?: number | null }): boolean {
  const prior = db.prepare('SELECT * FROM loop_outstanding_items WHERE id = ?').get<LoopOutstandingItemRow>(id);
  if (!prior) return false;
  const now = Date.now();
  db.prepare('UPDATE loop_outstanding_items SET user_response = ?, status = ?, outcome = ?, answer_sent_at = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(input.response ?? prior.user_response, input.status, input.outcome ?? prior.outcome, input.answerSentAt === undefined ? prior.answer_sent_at : input.answerSentAt, input.status === 'open' ? null : now, now, id);
  return true;
}

export function getOutstandingItem(db: SqliteDriver, id: string): LoopOutstandingItem | null {
  const row = db.prepare('SELECT * FROM loop_outstanding_items WHERE id = ?').get<LoopOutstandingItemRow>(id);
  return row ? rowToOutstandingItem(row) : null;
}

export function saveOutstandingItems(db: SqliteDriver, state: LoopState): void {
  if (!state.outstanding) return;
  const snapshot = state.outstanding;
  upsertOutstandingSnapshot(db, { state, legacyInformation: snapshot.forInformation === undefined, round: Math.max(0, state.totalIterations - 1), sections: { needsHuman: snapshot.needsHuman, decisionsApplied: snapshot.decisionsApplied ?? [], forInformation: snapshot.forInformation ?? snapshot.openQuestions, openQuestions: snapshot.openQuestions } });
}

export function listOutstandingItems(db: SqliteDriver, opts: {
    chatId?: string;
    workspaceCwd?: string;
    status?: LoopOutstandingItemStatus | 'all';
    limit?: number;
  } = {}): LoopOutstandingItem[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push('chat_id = ?');
      args.push(opts.chatId);
    }
    if (opts.workspaceCwd) {
      where.push('workspace_cwd = ?');
      args.push(opts.workspaceCwd);
    }
    const status = opts.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(Math.min(1000, Math.max(1, opts.limit ?? 1000)));
    const rows = db
      .prepare(`
        SELECT id, loop_run_id, chat_id, workspace_cwd, kind, text, user_response,
               recommended_answer, status, loop_status, created_at, updated_at, resolved_at, risk_class, first_seen_round, outcome, answer_sent_at
        FROM loop_outstanding_items
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all<LoopOutstandingItemRow>(...args);
    return rows.map(rowToOutstandingItem);
  }

export function setOutstandingItemStatus(db: SqliteDriver,
    id: string,
    status: LoopOutstandingItemStatus,
    response?: string,
  ): boolean {
    const resolvedAt = status === 'open' ? null : Date.now();
    const now = Date.now();
    const res = response === undefined
      ? db
        .prepare('UPDATE loop_outstanding_items SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
        .run(status, resolvedAt, now, id)
      : db
        .prepare('UPDATE loop_outstanding_items SET status = ?, resolved_at = ?, updated_at = ?, user_response = ? WHERE id = ?')
        .run(status, resolvedAt, now, response, id);
    return Number(res.changes ?? 0) > 0;
  }

export function countOpenOutstanding(db: SqliteDriver, opts: { chatId?: string; workspaceCwd?: string; loopRunId?: string } = {}): number {
    const where = ["status = 'open'"];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push('chat_id = ?');
      args.push(opts.chatId);
    }
    if (opts.workspaceCwd) {
      where.push('workspace_cwd = ?');
      args.push(opts.workspaceCwd);
    }
    if (opts.loopRunId) {
      where.push('loop_run_id = ?');
      args.push(opts.loopRunId);
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM loop_outstanding_items WHERE ${where.join(' AND ')}`)
      .get<{ n: number }>(...args);
    return row?.n ?? 0;
  }
