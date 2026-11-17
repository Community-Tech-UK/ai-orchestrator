/**
 * What Harness reads from Linear's three ticket tools (`list_issues`, `get_issue`, `list_comments`). Field names are
 * the ones the connector reported on 16 November 2026 (see the history file). Objects are not strict, because Linear
 * may add fields, but every field Harness reads is typed, and every name, title and list is capped.
 *
 * Descriptions and comments are other people's text and are not capped here: a text over its limit has to be an error
 * that names the ticket, which a schema failure cannot do. `linear-tickets.ts` checks `LINEAR_DESCRIPTION_MAX_CHARS`
 * and `LINEAR_COMMENT_MAX_CHARS` after parsing, and fails instead of cutting.
 */
import { z } from 'zod';

export const LINEAR_DESCRIPTION_MAX_CHARS = 100_000;
export const LINEAR_COMMENT_MAX_CHARS = 50_000;

/** Linear's largest page for the list tools is 250; a page with more is not one Harness asked for. */
export const LINEAR_PAGE_MAX_ITEMS = 250;
/** The most tickets one kind of relation may name on one ticket. */
export const LINEAR_RELATIONS_MAX_ITEMS = 200;

const Name = z.string().max(200);
const Id = z.string().min(1).max(200);
const Cursor = z.string().min(1).max(2000);
const Title = z.string().max(1000);
const Timestamp = z.string().min(1).max(40);

/** A ticket's short address, such as `COM-123`. Checked for its shape so it is safe to name in an error. */
export const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;
const Identifier = z.string().regex(LINEAR_IDENTIFIER_PATTERN);

const pageFields = {
  hasNextPage: z.boolean(),
  cursor: Cursor.nullish(),
};

/** A person as the connector names them: a bare name, or an object with one. */
const PersonName = z
  .union([Name, z.object({ name: Name })])
  .transform((person) => (typeof person === 'string' ? person : person.name));

/**
 * The fields both the list and the single read return. The connector's `id` is the ticket's short address; the
 * long id comes back as `uuid`. A status comes back as a name and a kind only: Linear sends no status id here.
 */
const ticketFields = {
  id: Identifier,
  uuid: Id,
  title: Title,
  url: z.string().min(1).max(2000),
  priority: z.object({ value: z.number().int().min(0).max(4) }),
  status: Name,
  statusType: z.string().min(1).max(40),
  labels: z.array(Name).max(200),
  assignee: PersonName.nullish(),
  assigneeId: Id.nullish(),
  project: Name.nullish(),
  projectId: Id.nullish(),
  team: Name,
  teamId: Id,
  parentId: Id.nullish(),
};

/** One ticket from the list tool. The list carries no description (it would arrive cut short). */
export const LinearListedTicketSchema = z.object(ticketFields);
export type LinearListedTicketRaw = z.infer<typeof LinearListedTicketSchema>;
export const LinearTicketsPageSchema = z.object({
  issues: z.array(LinearListedTicketSchema).max(LINEAR_PAGE_MAX_ITEMS),
  ...pageFields,
});

const RelatedTicket = z.object({ id: Identifier, title: Title });
/** `duplicateOf` is one ticket or none; a list is accepted too, because the connector does not say. */
const Duplicates = z
  .union([RelatedTicket, z.array(RelatedTicket).max(LINEAR_RELATIONS_MAX_ITEMS)])
  .nullish()
  .transform((value) => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]));

export const LinearRelationsSchema = z.object({
  blocks: z.array(RelatedTicket).max(LINEAR_RELATIONS_MAX_ITEMS),
  blockedBy: z.array(RelatedTicket).max(LINEAR_RELATIONS_MAX_ITEMS),
  relatedTo: z.array(RelatedTicket).max(LINEAR_RELATIONS_MAX_ITEMS),
  duplicateOf: Duplicates,
});

/** An attachment is named by its title; a bare name is accepted too. */
const AttachmentName = z
  .union([Name, z.object({ title: Name.nullish() })])
  .transform((attachment) => (typeof attachment === 'string' ? attachment : (attachment.title ?? '')));

/** One ticket from the single read, asked for with its description, relations and attachments. */
export const LinearTicketDetailSchema = z.object({
  ...ticketFields,
  description: z.string().nullish(),
  relations: LinearRelationsSchema,
  attachments: z.array(AttachmentName).max(500),
});
export type LinearTicketDetailRaw = z.infer<typeof LinearTicketDetailSchema>;

/**
 * A comment's author. `onBehalfOf` is set when an agent or integration wrote the comment for a person; that, and an
 * author that is missing, are what tell a bot from a person.
 */
const CommentPerson = z.object({ id: Id, name: Name });
const OnBehalfOf = z
  .union([z.object({ id: Id.optional(), name: Name }), Name])
  .transform((person) => (typeof person === 'string' ? { name: person } : person));

export const LinearCommentSchema = z.object({
  id: Id,
  body: z.string(),
  author: CommentPerson.nullish(),
  onBehalfOf: OnBehalfOf.nullish(),
  parentId: Id.nullish(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type LinearCommentRaw = z.infer<typeof LinearCommentSchema>;
export const LinearCommentsPageSchema = z.object({
  comments: z.array(LinearCommentSchema).max(LINEAR_PAGE_MAX_ITEMS),
  ...pageFields,
});
