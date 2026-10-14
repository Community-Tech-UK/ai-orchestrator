import { z } from 'zod/v4';

const GIT_COMMIT = /^[0-9a-f]{40}$/;

/**
 * `capabilities.workerAgent` in a worker registration/heartbeat. Everything
 * beyond version and start time is diagnostic: a malformed value is dropped
 * rather than failing the heartbeat, so an odd worker build can never knock a
 * node offline.
 */
export const WorkerAgentBuildSummarySchema = z.object({
  version: z.string().min(1).max(128),
  startedAt: z.number().int().nonnegative(),
  hostBootedAt: z.number().int().nonnegative().optional().catch(undefined),
  buildCommit: z.string().regex(GIT_COMMIT).optional().catch(undefined),
  autoUpdate: z.object({
    state: z.enum(['disabled', 'idle', 'waiting_for_idle', 'updating', 'restart_pending', 'blocked']),
    reason: z.string().max(512).optional(),
    targetCommit: z.string().regex(GIT_COMMIT).optional(),
    lastCheckedAt: z.number().int().nonnegative().optional(),
  }).optional().catch(undefined),
});
