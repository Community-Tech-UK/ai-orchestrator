import { z } from 'zod';

const idSchema = z.string().min(1).max(200);
export const BrowserApprovalStatusRequestSchema = z.object({ requestId: idSchema }).strict();
export type BrowserApprovalStatusRequest = z.infer<typeof BrowserApprovalStatusRequestSchema>;
export const BrowserApprovalRequestLookupSchema = z.object({ requestId: idSchema }).strict();
export type BrowserApprovalRequestLookup = z.infer<typeof BrowserApprovalRequestLookupSchema>;
export const BrowserDenyRequestPayloadSchema = z.object({
  requestId: idSchema,
  reason: z.string().min(1).max(1000).optional(),
}).strict();
export type BrowserDenyRequestPayload = z.infer<typeof BrowserDenyRequestPayloadSchema>;
