import { z } from 'zod';
import { InstanceIdSchema } from './common.schemas';

// ============ Session snapshot / stats schemas ============

export const SessionListSnapshotsPayloadSchema = z.object({
  instanceId: InstanceIdSchema.optional(),
}).strict().optional();

export const SessionCreateSnapshotPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
}).strict();

export const SessionGetStatsPayloadSchema = z.undefined().optional();
