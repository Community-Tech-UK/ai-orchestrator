import { z } from 'zod/v4';

/** Renewed every 30 seconds by the coordinator; also enforced inside the native helper. */
export const WORKER_KEEP_AWAKE_TTL_MS = 90_000;
export const NodeKeepAwakeParamsSchema = z.object({ enabled: z.boolean() }).strict();
export const NodeKeepAwakeResultSchema = z.object({ active: z.boolean() }).strict();
