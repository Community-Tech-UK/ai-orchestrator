/**
 * The ticket text of Linear runs (`plan_queue_linear_tickets`, migration 059). A store module of its own, not methods
 * on `PlanQueueStore`, so ticket text has no path onto the item row that `plan_queue_status`, the page and the phone
 * are sent. Every method is synchronous: reading a row and writing it again cannot be interleaved with another start.
 *
 * Ticket text is other people's text. This module never logs it and never puts it in an error message.
 */
import { z } from 'zod';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ApprovedTicketTextSchema, type ApprovedTicketText } from './plan-queue-ticket-approved-text';

/** Which part of a ticket differs from what James approved. */
export const TicketChangeKindSchema = z.enum(['title', 'description', 'comments']);

/**
 * A question for James. `changed`: Linear's text no longer matches what he approved, and the held text waits here, unseen
 * by any session. `gone`: the ticket was deleted, archived, moved out of its project or team, or can no longer be read as
 * that ticket. `unconfirmed`: the run's saved hash and the ticket table disagree, so what he approved cannot be confirmed.
 * `cleared`: the approved text was deleted (`plan-queue-ticket-retention.ts`) and the ticket was read again; its text waits
 * here for him to read, as a change's does. `gone` and `unconfirmed` hold no text at all.
 */
export const OpenTicketAskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('changed'),
    heldTitle: z.string(),
    heldText: ApprovedTicketTextSchema,
    heldHash: z.string().regex(/^[0-9a-f]{64}$/),
    changed: z.array(TicketChangeKindSchema).min(1),
    openedAt: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('cleared'),
    heldTitle: z.string(),
    heldText: ApprovedTicketTextSchema,
    heldHash: z.string().regex(/^[0-9a-f]{64}$/),
    openedAt: z.number().int().positive(),
  }).strict(),
  z.object({ kind: z.literal('gone'), openedAt: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('unconfirmed'), openedAt: z.number().int().positive() }).strict(),
]);

export type OpenTicketAsk = z.infer<typeof OpenTicketAskSchema>;
export type OpenTicketAskKind = OpenTicketAsk['kind'];

/**
 * What James is shown with a question and sends back with his answer, so an answer is applied only while the question is
 * still the one he saw. A question that holds text is identified by the hash of that text; the other two hold none, so their
 * opening time stands in.
 */
export function openTicketAskHash(ask: OpenTicketAsk): string {
  return ask.kind === 'changed' || ask.kind === 'cleared' ? ask.heldHash : `${ask.kind}:${ask.openedAt}`;
}

/** What James chose for a question: new text approved, a change left out, or neither (work on the ticket stops). */
export type TicketAnswerChoice = { choice: 'use-now'; at: number } | { choice: 'keep-approved' } | { choice: 'stop' };

/** `applied`; `no-ask` (nothing is open: already answered); `stale` (a different question is open than the one James saw). */
export type TicketAnswerResult = 'applied' | 'no-ask' | 'stale';
export type TicketChangeKind = z.infer<typeof TicketChangeKindSchema>;

export interface PlanQueueLinearTicketRecord {
  itemId: string;
  linearId: string;
  identifier: string;
  address: string;
  teamId: string;
  projectId: string;
  approvedTitle: string;
  /** Null once the text has been cleared. */
  approvedText: ApprovedTicketText | null;
  approvedHash: string;
  approvedAt: number;
  claimedAt: number | null;
  openAsk: OpenTicketAsk | null;
  /** The hash of a change James chose to leave out, so the same change is not asked about again. */
  leftOutHash: string | null;
  textClearedAt: number | null;
}

/** What a new row needs: the claim, the question and the clearing all start empty. */
export type NewPlanQueueLinearTicket = Omit<PlanQueueLinearTicketRecord, 'claimedAt' | 'openAsk' | 'leftOutHash' | 'textClearedAt'>;

/** The item a ticket belongs to, without any ticket text. */
export interface LinearTicketItemRef {
  itemId: string;
  runId: string;
  state: string;
  createdAt: number;
}

export interface LandedLinearTicket extends LinearTicketItemRef {
  linearId: string;
  identifier: string;
  landedCommit: string | null;
  /** When the item row was last saved. The item has no landing time of its own, and a landed item is rarely saved again. */
  landedAt: number;
}

/** What decides how long a ticket's text is kept. */
export interface TicketRetentionRow {
  itemId: string;
  runId: string;
  /** The job's state. */
  state: string;
  discardedAt: number | null;
  /** When the job was last set aside, from the queue's own record of its moves; when it was last saved if that has none. */
  setAsideAt: number;
  runStatus: string | null;
  textClearedAt: number | null;
}

/** What a ticket is called, from its newest row. The title is the one James approved. */
export interface LinearTicketNames {
  identifier: string;
  approvedTitle: string;
}

interface Row {
  item_id: string;
  linear_id: string;
  identifier: string;
  address: string;
  team_id: string;
  project_id: string;
  approved_title: string;
  approved_text_json: string | null;
  approved_hash: string;
  approved_at: number;
  claimed_at: number | null;
  open_ask_json: string | null;
  left_out_hash: string | null;
  text_cleared_at: number | null;
}

/** A finished item: landed, parked or skipped (`isTerminalItemState`). Written out here so the query needs no item import. */
const FINISHED_STATES = "('landed', 'parked', 'skipped')";

function toRecord(row: Row): PlanQueueLinearTicketRecord {
  return {
    itemId: row.item_id,
    linearId: row.linear_id,
    identifier: row.identifier,
    address: row.address,
    teamId: row.team_id,
    projectId: row.project_id,
    approvedTitle: row.approved_title,
    approvedText: row.approved_text_json === null ? null : ApprovedTicketTextSchema.parse(JSON.parse(row.approved_text_json)),
    approvedHash: row.approved_hash,
    approvedAt: row.approved_at,
    claimedAt: row.claimed_at,
    openAsk: row.open_ask_json === null ? null : OpenTicketAskSchema.parse(JSON.parse(row.open_ask_json)),
    leftOutHash: row.left_out_hash,
    textClearedAt: row.text_cleared_at,
  };
}

export class PlanQueueLinearTicketStore {
  constructor(private readonly db: SqliteDriver) {}

  get(itemId: string): PlanQueueLinearTicketRecord | undefined {
    const row = this.db.prepare('SELECT * FROM plan_queue_linear_tickets WHERE item_id = ?').get<Row>(itemId);
    return row ? toRecord(row) : undefined;
  }

  /** One row per item: a second insert for the same item fails on the primary key, and nothing is changed. */
  insert(ticket: NewPlanQueueLinearTicket): void {
    this.db.prepare(`INSERT INTO plan_queue_linear_tickets
      (item_id, linear_id, identifier, address, team_id, project_id, approved_title, approved_text_json, approved_hash, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ticket.itemId, ticket.linearId, ticket.identifier, ticket.address, ticket.teamId, ticket.projectId, ticket.approvedTitle,
      ticket.approvedText === null ? null : JSON.stringify(ApprovedTicketTextSchema.parse(ticket.approvedText)), ticket.approvedHash, ticket.approvedAt);
  }

  /**
   * The first check that finds no change is the claim. Returns true when this call recorded it and false when the
   * ticket was claimed before, so a later round never moves the time.
   */
  recordClaim(itemId: string, at: number): boolean {
    this.requireRow(itemId);
    return this.db.prepare('UPDATE plan_queue_linear_tickets SET claimed_at = ? WHERE item_id = ? AND claimed_at IS NULL').run(at, itemId).changes > 0;
  }

  /** James approved new text: it replaces the old, and a text that had been cleared is held again. */
  replaceApprovedText(itemId: string, approved: { title: string; text: ApprovedTicketText; hash: string; approvedAt: number }): void {
    this.requireRow(itemId);
    this.db.prepare(`UPDATE plan_queue_linear_tickets
      SET approved_title = ?, approved_text_json = ?, approved_hash = ?, approved_at = ?, text_cleared_at = NULL WHERE item_id = ?`)
      .run(approved.title, JSON.stringify(ApprovedTicketTextSchema.parse(approved.text)), approved.hash, approved.approvedAt, itemId);
  }

  /** Opens the question. Refused while one is already open: the question James is looking at must not change under him. */
  openAsk(itemId: string, ask: OpenTicketAsk): void {
    this.requireRow(itemId);
    const changed = this.db.prepare('UPDATE plan_queue_linear_tickets SET open_ask_json = ? WHERE item_id = ? AND open_ask_json IS NULL')
      .run(JSON.stringify(OpenTicketAskSchema.parse(ask)), itemId).changes;
    if (changed === 0) throw new Error(`A question about this ticket is already open (item ${itemId}).`);
  }

  /** Closes the question. `leftOutHash` is the hash of a change James chose to leave out, or null when he approved it. */
  closeAsk(itemId: string, leftOutHash: string | null): void {
    this.requireRow(itemId);
    this.db.prepare('UPDATE plan_queue_linear_tickets SET open_ask_json = NULL, left_out_hash = ? WHERE item_id = ?').run(leftOutHash, itemId);
  }

  /**
   * James's answer, applied in one transaction and only while the open question is the one he was shown (`askHash`). So the
   * new text, the closed question and the claim are saved together or not at all: a stop between them cannot leave the
   * text replaced with the question still open, or the question closed with the old text still approved.
   *
   * `use-now`: the held text becomes the approved text, with its hash and the time; a change left out earlier is forgotten, and
   * a ticket not yet claimed is claimed now, because the hash the run was started with is no longer what he approves. For a
   * cleared ticket this is how its text comes back.
   * `keep-approved`: the held hash is recorded as left out, so the same change does not ask again. `stop`: the question
   * closes and nothing else changes.
   */
  answerAsk(itemId: string, askHash: string, answer: TicketAnswerChoice): TicketAnswerResult {
    return this.db.transaction((): TicketAnswerResult => {
      const record = this.get(itemId);
      if (!record) throw new Error(`No Linear ticket row for item ${itemId}.`);
      const ask = record.openAsk;
      if (!ask) return 'no-ask';
      if (openTicketAskHash(ask) !== askHash) return 'stale';
      if (answer.choice === 'use-now' && ask.kind !== 'changed' && ask.kind !== 'cleared') throw new Error('Only a question that holds text can be answered with the text.');
      if (answer.choice === 'keep-approved' && ask.kind !== 'changed') throw new Error('Only a question about changed text can be answered with the version he approved.');
      if (answer.choice === 'use-now' && (ask.kind === 'changed' || ask.kind === 'cleared')) {
        this.replaceApprovedText(itemId, { title: ask.heldTitle, text: ask.heldText, hash: ask.heldHash, approvedAt: answer.at });
        this.closeAsk(itemId, null);
        this.recordClaim(itemId, answer.at);
      } else {
        this.closeAsk(itemId, answer.choice === 'keep-approved' && ask.kind === 'changed' ? ask.heldHash : record.leftOutHash);
      }
      return 'applied';
    })();
  }

  /**
   * Deletes the approved text, any held text and every hash, and records when. The identifier, the approved title, the address and
   * the ids that place the ticket stay. The hash column cannot be null, so an empty string stands for "none".
   * A job already in a final state also loses the question on its own row, in the same step: the question it showed was the
   * ticket's open one, which is gone, so nothing could answer it. (A Resume asks again from a fresh read of the ticket.)
   */
  clearText(itemId: string, at: number): void {
    this.requireRow(itemId);
    this.db.transaction((): void => {
      this.db.prepare(`UPDATE plan_queue_linear_tickets
        SET approved_text_json = NULL, open_ask_json = NULL, approved_hash = '', left_out_hash = NULL, text_cleared_at = ? WHERE item_id = ?`).run(at, itemId);
      this.db.prepare(`UPDATE plan_queue_items SET question_json = NULL WHERE id = ? AND state IN ('landed', 'skipped', 'parked')`).run(itemId);
    })();
  }

  /**
   * Every ticket with the facts that decide how long its text is kept: the job's state, whether it was discarded, when it was last
   * set aside, and its run's status. No ticket text is read.
   */
  retentionRows(): TicketRetentionRow[] {
    return this.db.prepare(`SELECT t.item_id, t.text_cleared_at, i.state, i.discarded_at, i.run_id, r.status AS run_status,
      COALESCE((SELECT MAX(e.at) FROM plan_queue_item_events e
        WHERE e.item_id = i.id AND e.to_state = 'parked' AND (e.from_state IS NULL OR e.from_state != 'parked')), i.updated_at) AS set_aside_at
      FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id
      LEFT JOIN plan_queue_runs r ON r.id = i.run_id`).all<{
      item_id: string; text_cleared_at: number | null; state: string; discarded_at: number | null; set_aside_at: number; run_id: string; run_status: string | null;
    }>().map((row) => ({
      itemId: row.item_id, runId: row.run_id, state: row.state, discardedAt: row.discarded_at, setAsideAt: row.set_aside_at,
      runStatus: row.run_status, textClearedAt: row.text_cleared_at,
    }));
  }

  /** The item that holds this ticket and has not finished, if any. Step 11 owns the rule that stops a second one. */
  findUnfinishedItem(linearId: string): LinearTicketItemRef | undefined {
    const row = this.db.prepare(`SELECT t.item_id, i.run_id, i.state, i.created_at FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id
      WHERE t.linear_id = ? AND i.state NOT IN ${FINISHED_STATES}
      ORDER BY i.created_at DESC, i.id DESC LIMIT 1`).get<{ item_id: string; run_id: string; state: string; created_at: number }>(linearId);
    return row ? { itemId: row.item_id, runId: row.run_id, state: row.state, createdAt: row.created_at } : undefined;
  }

  /** The newest item of this ticket that landed, by when its attempt began. */
  findLatestLandedItem(linearId: string): LandedLinearTicket | undefined {
    const row = this.db.prepare(`SELECT t.item_id, t.linear_id, t.identifier, i.run_id, i.state, i.created_at, i.updated_at, i.landed_commit FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id
      WHERE t.linear_id = ? AND i.state = 'landed'
      ORDER BY i.created_at DESC, i.id DESC LIMIT 1`)
      .get<{ item_id: string; linear_id: string; identifier: string; run_id: string; state: string; created_at: number; updated_at: number; landed_commit: string | null }>(linearId);
    return row ? { itemId: row.item_id, runId: row.run_id, state: row.state, createdAt: row.created_at, linearId: row.linear_id, identifier: row.identifier, landedCommit: row.landed_commit, landedAt: row.updated_at } : undefined;
  }

  /** The identifier and approved title from this ticket's newest row, for naming sessions, branches and commits. */
  findNames(linearId: string): LinearTicketNames | undefined {
    const row = this.db.prepare(`SELECT t.identifier, t.approved_title FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id
      WHERE t.linear_id = ? ORDER BY i.created_at DESC, i.id DESC LIMIT 1`).get<{ identifier: string; approved_title: string }>(linearId);
    return row ? { identifier: row.identifier, approvedTitle: row.approved_title } : undefined;
  }

  /**
   * What the pump needs to know about a job, without reading the ticket text: its short address, the kind of question
   * open on it, and the addresses of the tickets it is blocked by. Asked on every pump pass, so it parses no text.
   */
  holdState(itemId: string): { identifier: string; askKind: OpenTicketAskKind | null; blockedBy: string[] } | undefined {
    const row = this.db.prepare(`SELECT identifier, json_extract(open_ask_json, '$.kind') AS ask_kind FROM plan_queue_linear_tickets WHERE item_id = ?`)
      .get<{ identifier: string; ask_kind: OpenTicketAskKind | null }>(itemId);
    if (!row) return undefined;
    const blockedBy = this.db.prepare(`SELECT json_extract(j.value, '$.identifier') AS identifier
      FROM plan_queue_linear_tickets t, json_each(t.approved_text_json, '$.relatedTickets') j
      WHERE t.item_id = ? AND json_extract(j.value, '$.relation') = 'blocked-by'`).all<{ identifier: string }>(itemId);
    return { identifier: row.identifier, askKind: row.ask_kind, blockedBy: blockedBy.map((blocker) => blocker.identifier) };
  }

  /** The job that holds each ticket of a run, by the ticket's short address. */
  itemIdsByIdentifier(runId: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT t.item_id, t.identifier FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id WHERE i.run_id = ?`).all<{ item_id: string; identifier: string }>(runId);
    return new Map(rows.map((row) => [row.identifier, row.item_id]));
  }

  /** Every team with a ticket in this run, with one of its tickets' short addresses (the address starts with the team's key). */
  teamsOfRun(runId: string): { teamId: string; identifier: string }[] {
    return this.db.prepare(`SELECT t.team_id, MIN(t.identifier) AS identifier FROM plan_queue_linear_tickets t
      JOIN plan_queue_items i ON i.id = t.item_id
      WHERE i.run_id = ? GROUP BY t.team_id ORDER BY t.team_id`).all<{ team_id: string; identifier: string }>(runId)
      .map((row) => ({ teamId: row.team_id, identifier: row.identifier }));
  }

  private requireRow(itemId: string): void {
    if (!this.db.prepare('SELECT 1 AS present FROM plan_queue_linear_tickets WHERE item_id = ?').get(itemId)) {
      throw new Error(`No Linear ticket row for item ${itemId}.`);
    }
  }
}
