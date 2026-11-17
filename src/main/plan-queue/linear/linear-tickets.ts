/**
 * Reads tickets through Linear's connector: the tickets of one project in one status, one ticket with its relations,
 * and one ticket's comments. All reads, all through `callLinearTool`. Nothing calls these until a later step.
 *
 * Ticket text is other people's text. It is returned to the caller and goes nowhere else here: no log line, no error
 * message and no `detail` ever holds it. An over-long description or comment is an error naming the ticket's short
 * address, never a cut text.
 *
 * Every function takes a `LinearCallCounter`. It counts the connector calls the function makes, and a call that would
 * pass the counter's limit is not made.
 */
import { callLinearTool, type LinearCallDependencies } from './linear-call';
import { LinearCallError } from './linear-errors';
import { readAllLinearPages, toLinearPage } from './linear-paging';
import {
  LINEAR_COMMENT_MAX_CHARS,
  LINEAR_DESCRIPTION_MAX_CHARS,
  LINEAR_IDENTIFIER_PATTERN,
  LinearCommentsPageSchema,
  LinearTicketDetailSchema,
  LinearTicketsPageSchema,
  type LinearCommentRaw,
  type LinearListedTicketRaw,
  type LinearTicketDetailRaw,
} from './linear-ticket-schemas';

/** Linear's most results per page for the list and comment tools is 250; 50 matches the project list. */
const PAGE_SIZE = 50;

/** Fields asked of the list tool. No description: the list would cut it short. */
const LIST_FIELDS = [
  'uuid',
  'title',
  'priority',
  'url',
  'status',
  'statusType',
  'labels',
  'assignee',
  'assigneeId',
  'project',
  'projectId',
  'parentId',
  'team',
  'teamId',
] as const;

const DETAIL_FIELDS = [...LIST_FIELDS, 'description', 'relations', 'attachments'] as const;

/** A call that would pass the limit. Not a `LinearCallError`: it is Harness's own budget, not a Linear failure. */
export class LinearCallLimitError extends Error {
  readonly code = 'call-limit' as const;
  constructor(readonly limit: number) {
    super(`Harness stopped reading Linear after ${limit} calls.`);
    this.name = 'LinearCallLimitError';
  }
}

export function isLinearCallLimitError(error: unknown): error is LinearCallLimitError {
  return error instanceof LinearCallLimitError;
}

/** Counts connector calls against a limit. Share one across the functions that make up one job. */
export class LinearCallCounter {
  private made = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('The call limit must be a whole number, zero or more.');
  }

  get calls(): number {
    return this.made;
  }

  /** Called before each connector call. Throws, and counts nothing, when the call would pass the limit. */
  beforeCall(): void {
    if (this.made >= this.limit) throw new LinearCallLimitError(this.limit);
    this.made += 1;
  }
}

export interface LinearPerson {
  id?: string;
  name: string;
}

/** A ticket as the list returns it: no description, no relations. */
export interface LinearListedTicket {
  /** Linear's long id. */
  id: string;
  /** The short address, such as `COM-123`. */
  identifier: string;
  title: string;
  /** The ticket's address in Linear's web app. */
  url: string;
  /** Linear sends the status name and kind only, never its id. */
  status: { name: string; kind: string };
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  assignee: LinearPerson | null;
  /** Label names: the list sends no label ids. */
  labels: string[];
  project: { id: string | null; name: string } | null;
  team: { id: string; name: string };
  /** The parent ticket's id as Linear sends it, when this is a sub-ticket. */
  parentId: string | null;
}

export interface LinearRelatedTicket {
  identifier: string;
  title: string;
}

export interface LinearTicketRelations {
  blocks: LinearRelatedTicket[];
  blockedBy: LinearRelatedTicket[];
  related: LinearRelatedTicket[];
  duplicateOf: LinearRelatedTicket[];
}

export interface LinearTicket extends LinearListedTicket {
  description: string;
  relations: LinearTicketRelations;
  attachmentNames: string[];
}

export interface LinearComment {
  id: string;
  body: string;
  /** Null when Linear names no author (a deleted user, or an integration). */
  author: LinearPerson | null;
  /** Set when an agent or integration wrote the comment for this person. */
  onBehalfOf: LinearPerson | null;
  /** The comment this one replies to, when it is a reply. */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a read returns, and how many connector calls it took. */
export interface LinearRead<T> {
  value: T;
  calls: number;
}

export interface ListLinearTicketsInput {
  projectId: string;
  /** The status id James saved for the team. Matched by id: no status name is compared. */
  statusId: string;
}

/** Every ticket of one project in one status, every page. */
export async function listLinearTickets(
  input: ListLinearTicketsInput,
  counter: LinearCallCounter,
  dependencies?: LinearCallDependencies,
): Promise<LinearRead<LinearListedTicket[]>> {
  if (!input.projectId || !input.statusId) throw new Error('A ticket list needs a project id and a status id.');
  const started = counter.calls;
  const raw = await readAllLinearPages<LinearListedTicketRaw>(async (cursor) => {
    counter.beforeCall();
    const page = await callLinearTool(
      'list_issues',
      {
        project: input.projectId,
        state: input.statusId,
        fields: [...LIST_FIELDS],
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      LinearTicketsPageSchema,
      dependencies,
    );
    return toLinearPage(page.issues, page);
  });
  return { value: raw.map(listedTicket), calls: counter.calls - started };
}

/** One ticket with its full description, relations and attachment names. */
export async function readLinearTicket(
  identifier: string,
  counter: LinearCallCounter,
  dependencies?: LinearCallDependencies,
): Promise<LinearRead<LinearTicket>> {
  requireIdentifier(identifier);
  const started = counter.calls;
  counter.beforeCall();
  const raw = await callLinearTool(
    'get_issue',
    { id: identifier, fields: [...DETAIL_FIELDS] },
    LinearTicketDetailSchema,
    dependencies,
  );
  return { value: detailedTicket(raw), calls: counter.calls - started };
}

/** Every comment on one ticket, every page, in the order Linear sorts them by creation time. */
export async function listLinearTicketComments(
  identifier: string,
  counter: LinearCallCounter,
  dependencies?: LinearCallDependencies,
): Promise<LinearRead<LinearComment[]>> {
  requireIdentifier(identifier);
  const started = counter.calls;
  const raw = await readAllLinearPages<LinearCommentRaw>(async (cursor) => {
    counter.beforeCall();
    const page = await callLinearTool(
      'list_comments',
      { issueId: identifier, orderBy: 'createdAt', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      LinearCommentsPageSchema,
      dependencies,
    );
    return toLinearPage(page.comments, page);
  });
  const comments = raw.map((comment) => {
    if (comment.body.length > LINEAR_COMMENT_MAX_CHARS)
      throw tooLong(identifier, `a comment of more than ${LINEAR_COMMENT_MAX_CHARS.toLocaleString('en-GB')} characters`);
    return linearComment(comment);
  });
  return { value: comments, calls: counter.calls - started };
}

function requireIdentifier(identifier: string): void {
  if (!LINEAR_IDENTIFIER_PATTERN.test(identifier)) throw new Error('A ticket is read by its short address, such as COM-123.');
}

/** Names the ticket by its short address, which has been checked for its shape: it is not ticket text. */
function tooLong(identifier: string, what: string): LinearCallError {
  return new LinearCallError('unexpected-result', `Ticket ${identifier} has ${what}, so Harness did not read it.`);
}

function listedTicket(raw: LinearListedTicketRaw): LinearListedTicket {
  return {
    id: raw.uuid,
    identifier: raw.id,
    title: raw.title,
    url: raw.url,
    status: { name: raw.status, kind: raw.statusType },
    priority: raw.priority.value,
    assignee: raw.assignee ? { ...(raw.assigneeId ? { id: raw.assigneeId } : {}), name: raw.assignee } : null,
    labels: raw.labels,
    project: raw.project ? { id: raw.projectId ?? null, name: raw.project } : null,
    team: { id: raw.teamId, name: raw.team },
    parentId: raw.parentId ?? null,
  };
}

function detailedTicket(raw: LinearTicketDetailRaw): LinearTicket {
  const description = raw.description ?? '';
  if (description.length > LINEAR_DESCRIPTION_MAX_CHARS)
    throw tooLong(raw.id, `a description of more than ${LINEAR_DESCRIPTION_MAX_CHARS.toLocaleString('en-GB')} characters`);
  const related = (tickets: readonly { id: string; title: string }[]): LinearRelatedTicket[] =>
    tickets.map((ticket) => ({ identifier: ticket.id, title: ticket.title }));
  return {
    ...listedTicket(raw),
    description,
    relations: {
      blocks: related(raw.relations.blocks),
      blockedBy: related(raw.relations.blockedBy),
      related: related(raw.relations.relatedTo),
      duplicateOf: related(raw.relations.duplicateOf),
    },
    attachmentNames: raw.attachments.filter((name) => name !== ''),
  };
}

function linearComment(raw: LinearCommentRaw): LinearComment {
  return {
    id: raw.id,
    body: raw.body,
    author: raw.author ? { id: raw.author.id, name: raw.author.name } : null,
    onBehalfOf: raw.onBehalfOf ? { ...(raw.onBehalfOf.id ? { id: raw.onBehalfOf.id } : {}), name: raw.onBehalfOf.name } : null,
    parentId: raw.parentId ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
