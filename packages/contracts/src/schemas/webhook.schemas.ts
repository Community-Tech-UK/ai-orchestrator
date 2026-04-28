import { z } from 'zod';

export const WebhookRouteIdSchema = z.string().min(1).max(100);

export const WebhookCreateRoutePayloadSchema = z.object({
  path: z.string().min(1).max(200).regex(/^\/?[a-zA-Z0-9/_-]+$/),
  secret: z.string().min(16).max(500),
  enabled: z.boolean().optional(),
  allowUnsignedDev: z.boolean().optional(),
  maxBodyBytes: z.number().int().min(1_024).max(5_000_000).optional(),
  allowedAutomationIds: z.array(z.string().min(1).max(100)).max(100).optional(),
  allowedEvents: z.array(z.string().min(1).max(200)).max(100).optional(),
});

export const WebhookGetRoutePayloadSchema = z.object({
  id: WebhookRouteIdSchema,
});

export const WebhookListDeliveriesPayloadSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
}).optional();

export type WebhookCreateRoutePayload = z.infer<typeof WebhookCreateRoutePayloadSchema>;
