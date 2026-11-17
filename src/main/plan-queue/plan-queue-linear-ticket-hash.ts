/**
 * The hash of the text James approved for a Linear ticket, and of the text Linear holds now. Two hashes that match
 * mean the title, the description and the comments are the same; any difference means James is asked again.
 *
 * It lives outside the Linear folder on purpose: it never calls Linear, and the pages and the coordinator that compare
 * hashes may not import the folder (`linear-not-agent-reachable.spec.ts`). The input type is therefore its own.
 */
import { createHash } from 'node:crypto';

export interface TicketTextComment {
  id: string;
  /** The author's Linear id; null when the connector names no author. */
  authorId: string | null;
  body: string;
  /** Any ISO timestamp the connector gave. Comments are hashed in this order, then by id. */
  createdAt: string;
  /** True when the connector marks the comment as from a bot or integration; the programme ignores those. */
  fromBot: boolean;
}

export interface TicketText {
  title: string;
  description: string;
  comments: readonly TicketTextComment[];
}

/** Bumped only if the layout below changes, which would make every approved hash differ from a fresh one. */
const HASH_LAYOUT = 'linear-ticket-text-v1';

/** Windows and old-Mac line endings read the same as Unix ones: Linear may send either for one text. */
export function normaliseTicketLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function createdOrder(a: TicketTextComment, b: TicketTextComment): number {
  const first = Date.parse(a.createdAt);
  const second = Date.parse(b.createdAt);
  if (Number.isFinite(first) && Number.isFinite(second) && first !== second) return first - second;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** SHA-256 (lowercase hex) over the title, the description and each person's comment id, author id and body. */
export function hashTicketText(text: TicketText): string {
  const comments = text.comments
    .filter((comment) => !comment.fromBot)
    .slice()
    .sort(createdOrder)
    .map((comment) => [comment.id, comment.authorId ?? '', normaliseTicketLineEndings(comment.body)]);
  // JSON keeps the parts apart, so no text can run into the next field and look like another ticket's.
  const layout = JSON.stringify([HASH_LAYOUT, normaliseTicketLineEndings(text.title), normaliseTicketLineEndings(text.description), comments]);
  return createHash('sha256').update(layout, 'utf8').digest('hex');
}
