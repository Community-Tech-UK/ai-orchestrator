/**
 * Plan Queue schemas for the question a Linear ticket opens when its text no longer matches what James approved: read the
 * question, and answer it. Re-exported from `plan-queue.schemas.ts`, so callers import them from
 * `@contracts/schemas/plan-queue`.
 *
 * Both channels answer the Plan Queue page only. The question's text is other people's text: it is shown to James as
 * plain text and is never placed in a prompt, a tool result, a log line or a phone message.
 */
import { z } from 'zod';

/** The refusal for an answer to a question that has since been replaced. The page matches it to reload the card. */
export const TICKET_ASK_CHANGED_AGAIN = 'The ticket changed again. Read the new version.';
/** The refusal for an answer to a question that is already closed. */
export const TICKET_ASK_ALREADY_ANSWERED = 'This question has already been answered.';

/** Read the open question about one job's ticket. */
export const PlanQueueTicketAskReadPayloadSchema = z.object({ itemId: z.string().trim().min(1).max(200) }).strict();
export type PlanQueueTicketAskReadPayload = z.infer<typeof PlanQueueTicketAskReadPayloadSchema>;

/**
 * Answer it. `askHash` is the hash the read returned: the answer is applied only while the question is still the one James
 * was shown, so a ticket that changed again is never answered unseen.
 */
export const PlanQueueTicketAskAnswerPayloadSchema = z.object({
  itemId: z.string().trim().min(1).max(200),
  optionId: z.string().trim().min(1).max(50),
  askHash: z.string().trim().min(1).max(200),
}).strict();
export type PlanQueueTicketAskAnswerPayload = z.infer<typeof PlanQueueTicketAskAnswerPayloadSchema>;

/** One side of the question: a ticket's title and its text as a plain string, with the hash that pins it. */
export interface PlanQueueTicketAskText {
  title: string;
  /** The brief a worker would be told: priority, project, labels, description, people's comments, related tickets. */
  text: string;
  /** SHA-256 (lowercase hex) of the title, description and people's comments. */
  hash: string;
}

/** The question as the page shows it. */
export interface PlanQueueTicketAskView {
  itemId: string;
  /** The ticket's short address, such as `COM-123`. */
  identifier: string;
  /**
   * `changed`: the text differs. `cleared`: the approved text was deleted and the ticket was read again. `gone`: the ticket is
   * deleted or moved. `unconfirmed`: what James approved cannot be confirmed.
   */
  kind: 'changed' | 'cleared' | 'gone' | 'unconfirmed';
  /** Sent back with the answer. */
  askHash: string;
  /** Unix milliseconds. */
  openedAt: number;
  /** What James approved, with when. Null once its text has been cleared. */
  approved: (PlanQueueTicketAskText & { approvedAt: number }) | null;
  /**
   * What Linear says now. Null unless the ticket changed or was cleared; `changed` is empty for a cleared one.
   * `newCommentAuthors` names who wrote each comment that was not in the approved text (an unnamed author is null).
   */
  held: (PlanQueueTicketAskText & { changed: ('title' | 'description' | 'comments')[]; newCommentAuthors: (string | null)[] }) | null;
  /** The answers offered, in the order to show them. */
  options: { id: string; label: string }[];
}
