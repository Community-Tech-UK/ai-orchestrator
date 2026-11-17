/**
 * The ticket text of Linear runs (`plan_queue_linear_tickets`, migration 059). A store module of its own, not methods
 * on `PlanQueueStore`, so ticket text has no path onto the item row that `plan_queue_status`, the page and the phone
 * are sent. Every method is synchronous: reading a row and writing it again cannot be interleaved with another start.
 *
 * Ticket text is other people's text. This module never logs it and never puts it in an error message.
 */
import { z } from 'zod';
import type { SqliteDriver } from '../db/sqlite-driver';

const ApprovedCommentSchema = z.object({
  id: z.string().min(1),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  fromBot: z.boolean(),
}).strict();

/** The description and comments of a ticket as James saw them. The title is kept in its own column. */
export const ApprovedTicketTextSchema = z.object({
  description: z.string(),
  comments: z.array(ApprovedCommentSchema),
}).strict();

/** Which part of a ticket differs from what James approved. */
export const TicketChangeKindSchema = z.enum(['title', 'description', 'comments']);

/** A question for James: Linear's text no longer matches what he approved. The held text waits here, unseen by any session. */
export const OpenTicketAskSchema = z.object({
  heldTitle: z.string(),
  heldText: ApprovedTicketTextSchema,
  heldHash: z.string().regex(/^[0-9a-f]{64}$/),
  changed: z.array(TicketChangeKindSchema).min(1),
  openedAt: z.number().int().positive(),
}).strict();

export type ApprovedTicketText = z.infer<typeof ApprovedTicketTextSchema>;
export type OpenTicketAsk = z.infer<typeof OpenTicketAskSchema>;
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

  /** Deletes the approved text and any held text. The title, the hash and the times stay. */
  clearText(itemId: string, at: number): void {
    this.requireRow(itemId);
    this.db.prepare('UPDATE plan_queue_linear_tickets SET approved_text_json = NULL, open_ask_json = NULL, text_cleared_at = ? WHERE item_id = ?').run(at, itemId);
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

  private requireRow(itemId: string): void {
    if (!this.db.prepare('SELECT 1 AS present FROM plan_queue_linear_tickets WHERE item_id = ?').get(itemId)) {
      throw new Error(`No Linear ticket row for item ${itemId}.`);
    }
  }
}
