/**
 * The brief: what a worker and a checker are told a Linear ticket says. A pure function of the text James approved
 * and nothing else, so a session never reads what Linear says now, and a prompt built a week later from the same
 * approved text is the same text.
 *
 * It is other people's text from the first character to the last. Prompts put it in a data block
 * (`plan-queue-ticket-prompts.ts`); nothing here logs it or names it in an error.
 */
import { escapeForDataBlock, MAX_DATA_CHARS } from './plan-queue-prompts';
import { createdOrder } from './plan-queue-linear-ticket-hash';
import type { ApprovedRelatedTicket, ApprovedTicketText, TicketRelationKind } from './plan-queue-ticket-approved-text';

/** A label, an attachment name and a related ticket's title are each cut to this many characters. */
export const BRIEF_ITEM_MAX_CHARS = 200;

export interface TicketForBrief {
  identifier: string;
  /** The title James approved. */
  title: string;
  text: ApprovedTicketText;
}

const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

const RELATION_NAMES: Record<TicketRelationKind, string> = {
  parent: 'Parent',
  'sub-issue': 'Sub-issue',
  'blocked-by': 'Blocked by',
  blocks: 'Blocks',
  related: 'Related',
  'duplicate-of': 'Duplicate of',
};

/** One line: runs of white space (new lines included) become one space, so a value cannot start a line of its own. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** One line, cut to 200 characters. Counted in whole characters, so a pair of UTF-16 halves is never split. */
function cutItem(value: string): string {
  return Array.from(oneLine(value)).slice(0, BRIEF_ITEM_MAX_CHARS).join('');
}

/** The date of a Linear timestamp (`2026-11-01`); a value that is not a date is shown as it came. */
function dateOf(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : oneLine(timestamp);
}

function relatedLine(related: ApprovedRelatedTicket): string {
  const title = related.title === null ? '' : cutItem(related.title);
  return `- ${RELATION_NAMES[related.relation]}: ${oneLine(related.identifier)}${title ? ` ${title}` : ''}`;
}

/**
 * The brief, in this order: the identifier and title; priority, project and labels; the description; the comments
 * James approved, with their authors and dates; related tickets; attachment names. A section with nothing in it is
 * left out. A comment from a bot or integration is left out, as it is from the hash: a change to it would never be
 * put to James, so it must not reach a session.
 */
export function buildTicketBrief(ticket: TicketForBrief): string {
  const { text } = ticket;
  const priority = PRIORITY_NAMES[text.priority] ?? PRIORITY_NAMES[0];
  const labels = text.labels.map(cutItem).filter(Boolean);
  const comments = text.comments.filter((comment) => !comment.fromBot).slice().sort(createdOrder);
  const attachments = text.attachmentNames.map(cutItem).filter(Boolean);
  const description = text.description.trim();

  const sections: string[] = [
    `${oneLine(ticket.identifier)}: ${oneLine(ticket.title)}`,
    [`Priority: ${priority}`, ...(text.projectName === null ? [] : [`Project: ${oneLine(text.projectName)}`]), ...(labels.length ? [`Labels: ${labels.join(', ')}`] : [])].join('\n'),
  ];
  if (description) sections.push(`Description:\n${description}`);
  if (comments.length) {
    sections.push(['Comments:', ...comments.map((comment) => `${comment.authorName === null ? 'Unknown author' : oneLine(comment.authorName)}, ${dateOf(comment.createdAt)}:\n${comment.body.trim()}`)].join('\n\n'));
  }
  if (text.relatedTickets.length) sections.push(['Related tickets:', ...text.relatedTickets.map(relatedLine)].join('\n'));
  if (attachments.length) sections.push(['Attachments:', ...attachments.map((name) => `- ${name}`)].join('\n'));
  return sections.join('\n\n');
}

/** The name of the data block a prompt puts the brief in. */
export const TICKET_BRIEF_TAG = 'ticket_brief';

/** The brief as its data block carries it: a closing tag inside it is escaped, which adds a character each time. */
export function briefAsBlockText(brief: string): string {
  return escapeForDataBlock(TICKET_BRIEF_TAG, brief);
}

/** Whether a prompt cannot hold the whole brief: its block text is longer than a data block holds, so the block would hold only its start. */
export function isBriefOverLimit(brief: string): boolean {
  return briefAsBlockText(brief).length > MAX_DATA_CHARS;
}
