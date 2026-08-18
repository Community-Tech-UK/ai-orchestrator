import { z } from 'zod';

/**
 * Zod payload schemas for the generic PermissionRegistry approval surface
 * (LT-095) — see `packages/contracts/src/channels/permission-registry.channels.ts`
 * for the channels and the defect writeup this closes.
 */

const requestIdSchema = z.string().trim().min(1).max(256);

export const PermissionRegistryListPendingRequestSchema = z.object({
  /** Narrow to one instance's pending requests; omitted lists every instance. */
  instanceId: z.string().trim().min(1).max(256).optional(),
}).strict();

export const PermissionRegistryResolveRequestSchema = z.object({
  requestId: requestIdSchema,
  granted: z.boolean(),
  /** Optional operator note recorded for the calling code's own audit trail. */
  reason: z.string().trim().max(2000).optional(),
}).strict();

/** Bounds an extension to something a human could plausibly need: 30s–10min. */
export const PermissionRegistryExtendRequestSchema = z.object({
  requestId: requestIdSchema,
  extraMs: z.number().int().min(30_000).max(10 * 60_000),
}).strict();
