/**
 * Plan Queue history persistence (insert and read only).
 *
 * Four tables from migration 031: one row per item state change and one row
 * per verification round (history proper), one pin per job recording the
 * criteria it started from (Step 5), and one remembered triage decision per
 * document content (Step 6). Nothing here updates or deletes history: it is
 * the evidence for repeated findings, park causes and restart loops, so it
 * outlives the item row's own mutable fields. `detail_head` keeps a bounded
 * copy of the detail a change carried, with absolute paths stripped. Pins keep
 * the first snapshot; a newer triage decision or answer may update its memory key.
 */

import { randomUUID } from 'node:crypto';
import { documentReviewSchema, type DocumentReview } from './plan-queue-document-review';
import type { PlanQueueFinding, PlanQueueItemState, PlanQueueQuestion, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { planQueueFindingId } from './plan-queue-progress';
import type { PlanQueueItemPin } from './plan-queue-plan-pins';
import type { PlanQueueItem } from './plan-queue.types';
import { NOT_TIMING_SQL, TIMING_REASONS } from './plan-queue-timings';

export interface PlanQueueItemEvent {
  id: string;
  itemId: string;
  runId: string;
  at: number;
  fromState: PlanQueueItemState | null;
  toState: PlanQueueItemState;
  reason: string | null;
  detailHead: string | null;
  round: number;
  tokens: number;
}

/** One verification round, with the progress fingerprint it judged. */
export interface PlanQueueVerdictRecord {
  id: string;
  itemId: string;
  runId: string;
  round: number;
  at: number;
  verdict: 'PASS' | 'FAIL';
  findings: (PlanQueueFinding & { id: string })[];
  gatesRun: { command: string; exitCode: number }[];
  notChecked: string[];
  worktreeHead: string | null;
  documentSha256: string | null;
  /** Missing on persisted legacy reviews: these require a new check before closure. */
  documentReview?: DocumentReview;
}

/** Stored times behind an item's current step (see `PlanQueueHistoryStore.stageMarks`). */
export interface PlanQueueStageMarks {
  /** When the item last moved into its current state. */
  enteredAt: number | null;
  /** The latest time Harness started running this item's checklist. */
  checksAt: number | null;
  /** The latest time this item's landing turn began. */
  landingAt: number | null;
}

export type PlanQueueEventInput = Omit<PlanQueueItemEvent, 'id' | 'at'> & { at?: number };
export type PlanQueueVerdictInput = Omit<PlanQueueVerdictRecord, 'id' | 'at' | 'findings'> & {
  at?: number;
  findings: readonly PlanQueueFinding[];
};

/** One answered question, keyed by its question text within the document key. */
export interface PlanQueueTriageAnswer {
  question: string;
  optionId: string;
  optionLabel: string;
}

/**
 * A remembered triage decision (Step 6), keyed by SHA-256 of the document
 * content plus its linked spec. Cancelled-run leftovers are never remembered:
 * "not reached" is not a skip decision.
 */
export interface PlanQueueTriageDecision {
  documentSha256: string;
  disposition: 'ready' | 'needs-answer' | 'skip';
  reason: string | null;
  question: PlanQueueQuestion | null;
  /** James's answers, keyed by question text so a different question is asked. */
  answers: PlanQueueTriageAnswer[];
  source: 'triage' | 'james';
  decidedAt: number;
}

const DETAIL_HEAD_LIMIT = 500;

/** One execution may cover jobs in several runs; each participating run counts it once. */
export const PLAN_QUEUE_CHECK_SUMMARIES_SQL = `
  SELECT items.run_id, COUNT(DISTINCT events.id) AS runs, COUNT(DISTINCT items.id) AS jobs
  FROM plan_queue_item_events events
  JOIN json_each(CASE WHEN events.reason = 'checklist-run' THEN events.detail_head ELSE '{}' END,
    '$.memberItemIds') members
  JOIN plan_queue_items items ON items.id = members.value
  WHERE events.reason = 'checklist-run'
  GROUP BY items.run_id`;

export class PlanQueueHistoryStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly now: () => number = Date.now,
  ) {}

  recordEvent(event: PlanQueueEventInput): void {
    this.db.prepare(`
      INSERT INTO plan_queue_item_events (id, item_id, run_id, at, from_state, to_state, reason, detail_head, round, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), event.itemId, event.runId, event.at ?? this.now(),
      event.fromState, event.toState, event.reason, detailHead(event.detailHead), event.round, event.tokens,
    );
  }

  recordChecklistRun(item: PlanQueueItem, memberItemIds: readonly string[], groupId?: string): void {
    const detail = JSON.stringify({ ...(groupId ? { groupId } : {}), memberItemIds });
    if (detail.length > DETAIL_HEAD_LIMIT) throw new Error('Checklist history exceeds its detail limit');
    this.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
      reason: 'checklist-run', detailHead: detail, round: item.round, tokens: 0 });
  }

  checksSummary(runId: string): PlanQueueRunDto['checks'] {
    return this.db.prepare(`SELECT runs, jobs FROM (${PLAN_QUEUE_CHECK_SUMMARIES_SQL}) WHERE run_id = ?`)
      .get<NonNullable<PlanQueueRunDto['checks']>>(runId);
  }

  /**
   * For each item: when it entered its current state, and its latest check run and landing turn. One read for every
   * item a list shows; the session list uses these to say how long a step with no session has taken.
   */
  stageMarks(itemIds: readonly string[]): Map<string, PlanQueueStageMarks> {
    const rows = this.db.prepare(`SELECT items.id,
        (SELECT MAX(at) FROM plan_queue_item_events e WHERE e.item_id = items.id AND e.to_state = items.state
          AND (e.from_state IS NULL OR e.from_state <> e.to_state)) AS entered_at,
        (SELECT MAX(at) FROM plan_queue_item_events e WHERE e.item_id = items.id AND e.reason = 'checklist-run') AS checks_at,
        (SELECT MAX(at) FROM plan_queue_item_events e WHERE e.item_id = items.id AND e.reason = ?) AS landing_at
      FROM plan_queue_items items WHERE items.id IN (SELECT value FROM json_each(?))`)
      .all<{ id: string; entered_at: number | null; checks_at: number | null; landing_at: number | null }>(
        TIMING_REASONS.landingStart, JSON.stringify(itemIds));
    return new Map(rows.map(row => [row.id, { enteredAt: row.entered_at, checksAt: row.checks_at, landingAt: row.landing_at }]));
  }

  hasFailedCheckGroup(itemId: string, head: string): boolean {
    return this.db.prepare(`SELECT 1 FROM plan_queue_item_events
      WHERE item_id = ? AND reason = 'check-group-failed' AND detail_head = ? LIMIT 1`)
      .get(itemId, JSON.stringify({ head })) !== undefined;
  }

  /** Use the complete event history, including a member that left and later returned. */
  checkGroupRoundIntact(groupId: string, memberItemIds: readonly string[]): boolean {
    if (memberItemIds.length < 2 || memberItemIds.length > 8) return false;
    const started = this.db.prepare(`SELECT rowid AS sequence FROM plan_queue_item_events
      WHERE reason = 'checklist-run' AND json_valid(detail_head)
        AND json_extract(detail_head, '$.groupId') = ? ORDER BY rowid DESC LIMIT 1`)
      .get<{ sequence: number }>(groupId);
    if (!started) return false;
    return this.db.prepare(`SELECT 1 FROM plan_queue_item_events WHERE rowid > ?
      AND item_id IN (${memberItemIds.map(() => '?').join(',')})
      AND to_state IN ('fixing', 'parked', 'skipped') AND ${NOT_TIMING_SQL} LIMIT 1`).get(started.sequence, ...memberItemIds) === undefined;
  }

  recordVerdict(record: PlanQueueVerdictInput): void {
    const findings = record.findings.map((finding) => ({ ...finding, id: planQueueFindingId(finding) }));
    this.db.prepare(`
      INSERT INTO plan_queue_verdicts (id, item_id, run_id, round, at, verdict, findings_json, gates_json, not_checked_json, worktree_head, document_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), record.itemId, record.runId, record.round, record.at ?? this.now(), record.verdict,
      JSON.stringify(findings), JSON.stringify(record.gatesRun), JSON.stringify(record.notChecked),
      record.worktreeHead, record.documentReview ? JSON.stringify(documentReviewSchema.parse(record.documentReview)) : record.documentSha256,
    );
  }

  /**
   * Every round of this item, oldest first. Ordered by time, never by the
   * round counter: a Resume resets `round` to 0 while earlier verdicts stay,
   * so round order would put the newest round after an obsolete one.
   */
  listVerdicts(itemId: string): PlanQueueVerdictRecord[] {
    return this.db
      .prepare('SELECT * FROM plan_queue_verdicts WHERE item_id = ? ORDER BY at ASC, rowid ASC')
      .all<VerdictRow>(itemId)
      .map(rowToVerdict);
  }

  /** The last PASS plus exact coordinator transformations; the original verdict stays immutable. */
  reviewedDocumentSha256(itemId: string): string | null {
    const verdict = this.listVerdicts(itemId).at(-1);
    if (verdict?.verdict !== 'PASS' || !verdict.documentSha256) return null;
    const row = this.db.prepare(`SELECT detail_head FROM plan_queue_item_events
      WHERE item_id = ? AND reason = 'reviewed-document-transformed' ORDER BY at DESC, rowid DESC LIMIT 1`)
      .get<{ detail_head: string }>(itemId);
    if (!row) return verdict.documentSha256;
    const change = JSON.parse(row.detail_head) as { verdictId: string; sha256: string };
    return change.verdictId === verdict.id ? change.sha256 : verdict.documentSha256;
  }

  reviewedDocuments(itemId: string): DocumentReview | null {
    const verdict = this.listVerdicts(itemId).at(-1);
    const documentSha256 = this.reviewedDocumentSha256(itemId);
    return verdict?.documentReview && documentSha256 ? { ...verdict.documentReview, documentSha256 } : null;
  }

  /** Only a deterministic change whose exact input was accepted can extend that acceptance. */
  recordDocumentTransformation(item: { id: string; runId: string; state: PlanQueueItemState; round: number },
    change: { beforeSha256: string; afterSha256: string } | undefined): void {
    if (!change || this.reviewedDocumentSha256(item.id) !== change.beforeSha256) return;
    const verdict = this.listVerdicts(item.id).at(-1)!;
    this.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
      reason: 'reviewed-document-transformed', detailHead: JSON.stringify({ verdictId: verdict.id, sha256: change.afterSha256 }),
      round: item.round, tokens: 0 });
  }

  /**
   * This item's recent state changes and decision notes, newest first. Timing rows (`plan-queue-timings.ts`) are
   * left out: decisions read a bounded window of this list, and a measurement must not push an older event out of it.
   */
  listEvents(itemId: string, limit = 50): PlanQueueItemEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Queue history limit must be between 1 and 1000');
    return this.db
      .prepare(`SELECT * FROM plan_queue_item_events WHERE item_id = ? AND ${NOT_TIMING_SQL} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all<EventRow>(itemId, limit)
      .map(rowToEvent);
  }

  /** The criteria this job started from. First writer wins (Step 5). */
  recordPinIfAbsent(pin: PlanQueueItemPin): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO plan_queue_item_pins (item_id, document_sha256, document_bytes, unchecked_json, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(pin.itemId, pin.documentSha256, pin.documentBytes, JSON.stringify(pin.unchecked), pin.recordedAt);
  }

  getPin(itemId: string): PlanQueueItemPin | null {
    const row = this.db.prepare('SELECT * FROM plan_queue_item_pins WHERE item_id = ?')
      .get<PinRow>(itemId);
    return row ? {
      itemId: row.item_id,
      documentSha256: row.document_sha256,
      documentBytes: row.document_bytes,
      unchecked: JSON.parse(row.unchecked_json) as string[],
      recordedAt: row.recorded_at,
    } : null;
  }

  /** Remember one triage decision per document content (Step 6). Replaces. */
  rememberTriageDecision(decision: PlanQueueTriageDecision): void {
    this.db.prepare(`
      INSERT INTO plan_queue_triage_decisions (document_sha256, decision_json, decided_at)
      VALUES (?, ?, ?)
      ON CONFLICT(document_sha256) DO UPDATE SET decision_json = excluded.decision_json, decided_at = excluded.decided_at
    `).run(decision.documentSha256, JSON.stringify({
      disposition: decision.disposition,
      reason: decision.reason,
      question: decision.question,
      answers: decision.answers,
      source: decision.source,
    }), decision.decidedAt);
  }

  getTriageDecision(documentSha256: string): PlanQueueTriageDecision | null {
    const row = this.db.prepare('SELECT * FROM plan_queue_triage_decisions WHERE document_sha256 = ?')
      .get<DecisionRow>(documentSha256);
    if (!row) return null;
    const body = JSON.parse(row.decision_json) as Omit<PlanQueueTriageDecision, 'documentSha256' | 'decidedAt'>;
    return { ...body, documentSha256: row.document_sha256, decidedAt: row.decided_at };
  }

  /** Merge one answered question into a remembered decision (per key + question). */
  rememberTriageAnswer(documentSha256: string, answer: PlanQueueTriageAnswer, decidedAt: number): void {
    const existing = this.getTriageDecision(documentSha256);
    this.rememberTriageDecision({
      documentSha256,
      disposition: existing?.disposition ?? 'needs-answer',
      reason: existing?.reason ?? null,
      question: existing?.question ?? null,
      answers: [...(existing?.answers ?? []).filter((entry) => entry.question !== answer.question), answer],
      source: 'james',
      decidedAt,
    });
  }
}

interface EventRow {
  id: string; item_id: string; run_id: string; at: number;
  from_state: string | null; to_state: string; reason: string | null;
  detail_head: string | null; round: number; tokens: number;
}

interface PinRow {
  item_id: string; document_sha256: string; document_bytes: number;
  unchecked_json: string; recorded_at: number;
}

interface DecisionRow {
  document_sha256: string; decision_json: string; decided_at: number;
}

interface VerdictRow {
  id: string; item_id: string; run_id: string; round: number; at: number; verdict: string;
  findings_json: string; gates_json: string; not_checked_json: string;
  worktree_head: string | null; document_sha256: string | null;
}

function rowToEvent(row: EventRow): PlanQueueItemEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    at: row.at,
    fromState: row.from_state as PlanQueueItemState | null,
    toState: row.to_state as PlanQueueItemState,
    reason: row.reason,
    detailHead: row.detail_head,
    round: row.round,
    tokens: row.tokens,
  };
}

function rowToVerdict(row: VerdictRow): PlanQueueVerdictRecord {
  // The TEXT column originally held only a root hash. Versioned JSON adds the
  // full review without rewriting immutable history or guessing legacy spec state.
  const review = row.document_sha256?.startsWith('{') ? documentReviewSchema.parse(JSON.parse(row.document_sha256)) : undefined;
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    round: row.round,
    at: row.at,
    verdict: row.verdict as 'PASS' | 'FAIL',
    findings: JSON.parse(row.findings_json) as (PlanQueueFinding & { id: string })[],
    gatesRun: JSON.parse(row.gates_json) as { command: string; exitCode: number }[],
    notChecked: JSON.parse(row.not_checked_json) as string[],
    worktreeHead: row.worktree_head,
    documentSha256: review ? review.documentSha256 : row.document_sha256,
    ...(review ? { documentReview: review } : {}),
  };
}

/** Bounded and path-free: history must not leak absolute paths onto the panel. */
function detailHead(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const stripped = detail
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/(?:\/[\w.@+-]+){2,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, DETAIL_HEAD_LIMIT);
}
