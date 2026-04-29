import { z } from 'zod';

export const PauseReasonSchema = z.enum(['vpn', 'user', 'detector-error']);

export const PauseStateSchema = z.object({
  isPaused: z.boolean(),
  reasons: z.array(PauseReasonSchema),
  pausedAt: z.number().nullable(),
  lastChange: z.number(),
});

export const PauseSetManualPayloadSchema = z.object({
  paused: z.boolean(),
});

export const PauseDetectorEventSchema = z.object({
  at: z.number(),
  interfacesAdded: z.array(z.string()),
  interfacesRemoved: z.array(z.string()),
  matchedPattern: z.string().nullable(),
  decision: z.enum(['no-change', 'pause', 'resume', 'flap-suppressed', 'detector-error']),
  note: z.string().optional(),
});

export const PauseDetectorRecentEventsResponseSchema = z.object({
  events: z.array(PauseDetectorEventSchema),
});

export type PauseReason = z.infer<typeof PauseReasonSchema>;
export type PauseStatePayload = z.infer<typeof PauseStateSchema>;
export type PauseSetManualPayload = z.infer<typeof PauseSetManualPayloadSchema>;
export type PauseDetectorEvent = z.infer<typeof PauseDetectorEventSchema>;
