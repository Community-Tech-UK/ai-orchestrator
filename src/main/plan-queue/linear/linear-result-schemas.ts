/**
 * What Harness reads from Linear's connector tools. Field names are the ones the connector reported on
 * 15 November 2026 (see the history file). Objects are not strict, because Linear may add fields, but every field
 * Harness reads is typed, and every name is capped at 200 characters. Names are shown as plain text and never placed
 * in a prompt.
 */
import { z } from 'zod';

const Name = z.string().max(200);
const Id = z.string().min(1).max(200);
const Cursor = z.string().min(1).max(2000);

/** Fields every list tool puts beside its items. `cursor` is absent on the last page. */
const pageFields = {
  hasNextPage: z.boolean(),
  cursor: Cursor.nullish(),
};

/** "Who am I": the signed-in user and the workspace. */
export const LinearWhoAmISchema = z.object({
  user: z.object({ id: Id, name: Name, email: z.string().max(320) }),
  workspace: z.object({ id: Id, name: Name }),
});
export type LinearWhoAmI = z.infer<typeof LinearWhoAmISchema>;

export const LinearTeamSchema = z.object({
  id: Id,
  key: z.string().min(1).max(20),
  name: Name,
  /** Linear's own word: `public`, `private` or `restricted`. Not every connector reports it, so it is optional. */
  visibility: z.string().max(40).optional(),
  parentId: Id.nullish(),
});
export type LinearTeam = z.infer<typeof LinearTeamSchema>;
export const LinearTeamsPageSchema = z.object({ teams: z.array(LinearTeamSchema), ...pageFields });

/** A status, with Linear's own kind word (`started`, `unstarted`, `completed` ...). The list tool is not paged. */
export const LinearStatusSchema = z.object({ id: Id, name: Name, type: z.string().min(1).max(40) });
export type LinearStatus = z.infer<typeof LinearStatusSchema>;
export const LinearStatusListSchema = z.array(LinearStatusSchema);

export const LinearLabelSchema = z.object({ id: Id, name: Name });
export type LinearLabel = z.infer<typeof LinearLabelSchema>;
export const LinearLabelsPageSchema = z.object({ labels: z.array(LinearLabelSchema), ...pageFields });

/** A project with the teams it belongs to. The projects tool only returns `teams` when asked for that field. */
export const LinearProjectSchema = z.object({
  id: Id,
  name: Name,
  teams: z.array(z.object({ id: Id, key: z.string().min(1).max(20), name: Name })),
});
export type LinearProject = z.infer<typeof LinearProjectSchema>;
export const LinearProjectsPageSchema = z.object({ projects: z.array(LinearProjectSchema), ...pageFields });

export const LinearUserSchema = z.object({ id: Id, name: Name });
export type LinearUser = z.infer<typeof LinearUserSchema>;
export const LinearUsersPageSchema = z.object({ users: z.array(LinearUserSchema), ...pageFields });
