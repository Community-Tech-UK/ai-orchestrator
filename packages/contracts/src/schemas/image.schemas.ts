import { z } from 'zod';
import { FileAttachmentSchema } from './common.schemas';

export const ImageResolveKindSchema = z.enum(['local', 'remote', 'data']);
export type ImageResolveKind = z.infer<typeof ImageResolveKindSchema>;

export const ImageResolveRequestSchema = z.object({
  kind: ImageResolveKindSchema,
  src: z.string().min(1).max(8192),
  alt: z.string().trim().min(1).max(256).optional(),
});
export type ImageResolveRequest = z.infer<typeof ImageResolveRequestSchema>;

export const ImageResolveFailureReasonSchema = z.enum([
  'too_large',
  'not_found',
  'denied',
  'fetch_failed',
  'unsupported',
  'timeout',
  'invalid_data_uri',
]);
export type ImageResolveFailureReason = z.infer<typeof ImageResolveFailureReasonSchema>;

export const ResolvedImageAttachmentSchema = FileAttachmentSchema.extend({
  data: z.string().min(1),
});

export const ImageResolveSuccessSchema = z.object({
  ok: z.literal(true),
  attachment: ResolvedImageAttachmentSchema,
});

export const ImageResolveFailureSchema = z.object({
  ok: z.literal(false),
  reason: ImageResolveFailureReasonSchema,
  message: z.string().min(1).max(1000),
});

export const ImageResolveResponseSchema = z.discriminatedUnion('ok', [
  ImageResolveSuccessSchema,
  ImageResolveFailureSchema,
]);
export type ImageResolveResponse = z.infer<typeof ImageResolveResponseSchema>;
