/**
 * The account parts of a worker's capability report. Both are hints or display only, so a malformed value is dropped
 * rather than rejecting the worker's heartbeat.
 */
import { z } from 'zod/v4';

const ProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** Account profiles with a home on the worker: a placement hint. */
export const WorkerAccountProfileIdsSchema = z.object({
  claude: z.array(ProfileIdSchema).max(16).optional(),
  codex: z.array(ProfileIdSchema).max(16).optional(),
  opencode: z.array(ProfileIdSchema).max(16).optional(),
}).optional().catch(undefined);

/** Whether each Claude / Codex account is signed in on the worker: up to 16 profiles plus the default, per tool. */
export const WorkerSignInsSchema = z.array(z.object({
  provider: z.enum(['claude', 'codex']),
  profileId: ProfileIdSchema,
  state: z.enum(['signed-in', 'signed-out', 'unknown']),
  identity: z.string().max(320).optional(),
})).max(34).optional().catch(undefined);
