import { z } from 'zod';
import { InstanceIdSchema, FileAttachmentSchema } from './common.schemas';

// ============ Session admission schemas ============

const AdmissionStateSchema = z.enum([
  'recorded',
  'suppressed',
  'delivered',
  'failed',
  'cancelled',
  'expired',
  'queued',
  'promoting',
]);

export const SessionAdmissionsListPayloadSchema = z.object({
  instanceId: InstanceIdSchema.optional(),
  states: z.array(AdmissionStateSchema).max(10).optional(),
}).strict().optional();

// ============ Durable renderer send-queue schemas (WS-A1 Phase B) ============

const AdmissionIdSchema = z.string().min(1).max(200);

const QueueSourceMetadataSchema = z.object({
  hadAttachmentsDropped: z.boolean().optional(),
  kind: z.enum(['queue', 'steer']).optional(),
  retryCount: z.number().int().min(0).max(1000).optional(),
  seededAlready: z.boolean().optional(),
}).strict().optional();

export const SessionQueueEnqueuePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  message: z.string().max(500000),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  contextBlock: z.string().max(500000).optional(),
  sourceMetadata: QueueSourceMetadataSchema,
}).strict().refine(
  (data) => data.message.trim().length > 0 || (data.attachments && data.attachments.length > 0),
  { message: 'Either message must be non-empty or attachments must be provided' },
);

export const SessionQueueUpdatePayloadSchema = z.object({
  admissionId: AdmissionIdSchema,
  message: z.string().max(500000).optional(),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  contextBlock: z.string().max(500000).optional(),
}).strict();

export const SessionQueueCancelPayloadSchema = z.object({
  admissionId: AdmissionIdSchema,
}).strict();

export const SessionQueueReorderPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  orderedIds: z.array(AdmissionIdSchema).max(200),
}).strict();

export const SessionQueueListPayloadSchema = z.object({
  instanceId: InstanceIdSchema.optional(),
}).strict().optional();

export const SessionQueuePromotePayloadSchema = z.object({
  admissionId: AdmissionIdSchema,
}).strict();
