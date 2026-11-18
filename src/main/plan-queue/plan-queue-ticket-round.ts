/**
 * What a round of a Linear ticket is built from: the text James approved, read from the ticket table, and the brief
 * file written from it. Every worker turn and every check starts here, so a prompt never carries text Linear holds
 * now. Nothing in this file imports the Linear folder or calls the connector: the table is the only input.
 *
 * The brief is other people's text. It is never logged and never put in an error message.
 */
import type { DocumentReview } from './plan-queue-document-review';
import type { PlanQueueLinearTicketRecord } from './plan-queue-linear-ticket-store';
import type { PlanQueueItemPin } from './plan-queue-plan-pins';
import { buildTicketBrief, type TicketForBrief } from './plan-queue-ticket-brief';
import { writeTicketBriefFile } from './plan-queue-ticket-brief-file';
import type { TicketPromptContext } from './plan-queue-ticket-prompts';
import type { PlanQueueItem } from './plan-queue.types';

/** A session cannot be told about a ticket whose approved text is gone. Fixed words, so a run's reason can carry them. */
export class TicketTextUnavailable extends Error {
  constructor() {
    super("This ticket's approved text is not available, so no session can be told about it.");
    this.name = 'TicketTextUnavailable';
  }
}

/** The ticket table, as a round needs it. */
export interface TicketRoundDeps {
  record(itemId: string): PlanQueueLinearTicketRecord | undefined;
}

/** The ticket as James approved it, or undefined when its row or its text is gone. */
export function approvedTicketOf(deps: TicketRoundDeps, itemId: string): TicketForBrief | undefined {
  const record = deps.record(itemId);
  return record?.approvedText ? { identifier: record.identifier, title: record.approvedTitle, text: record.approvedText } : undefined;
}

/**
 * Writes the brief file again from the approved text and returns what a ticket prompt is built from. The prompt's block
 * is built from the same text by the prompt builder. Called before every worker turn and every check, never from Linear.
 */
export async function ticketPromptContext(
  deps: TicketRoundDeps,
  input: { item: PlanQueueItem; repoRoot: string; worktreePath: string | null },
): Promise<TicketPromptContext> {
  const ticket = approvedTicketOf(deps, input.item.id);
  if (!ticket) throw new TicketTextUnavailable();
  const briefPath = await writeTicketBriefFile({ itemId: input.item.id, brief: buildTicketBrief(ticket), repoRoot: input.repoRoot, workFolder: input.worktreePath });
  return { item: input.item, repoRoot: input.repoRoot, worktreePath: input.worktreePath ?? '', ticket, briefPath };
}

/** What the checker reviewed: the hash James approved. A changed hash voids a PASS, as a changed document does. */
export function ticketReviewFingerprint(deps: TicketRoundDeps, itemId: string): DocumentReview {
  const record = deps.record(itemId);
  return { version: 1, documentSha256: record?.approvedHash ?? null, linkedSpecSha256: [] };
}

/** The pin taken when a ticket job starts. Null when the approved text is gone, which sets the job aside as missing its work. */
export function ticketPin(deps: TicketRoundDeps, itemId: string, recordedAt: number): PlanQueueItemPin | null {
  const record = deps.record(itemId);
  if (!record?.approvedText) return null;
  return { itemId, documentSha256: record.approvedHash, documentBytes: Buffer.byteLength(JSON.stringify(record.approvedText), 'utf8'), unchecked: [], recordedAt };
}

/** A hash of the approved text for the no-progress check, or null when there is none. */
export function ticketContentHash(deps: TicketRoundDeps, itemId: string): string | null {
  const record = deps.record(itemId);
  return record?.approvedText ? record.approvedHash : null;
}
