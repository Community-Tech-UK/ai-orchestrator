import { z } from 'zod';
import { InstanceIdSchema } from './common.schemas';

/** A session that needs the user, in the agent's own words. Mirrors `WatcherFlag` in the main process. */
export const SessionWatcherFlagSchema = z.object({
  instanceId: InstanceIdSchema,
  requestCount: z.number().int().nonnegative(),
  question: z.string(),
  closing: z.string(),
  stop: z.string(),
  note: z.string().optional(),
  acceptsYes: z.boolean(),
  since: z.number(),
});
export type SessionWatcherFlagPayload = z.infer<typeof SessionWatcherFlagSchema>;

export const SessionWatcherFlagListSchema = z.array(SessionWatcherFlagSchema);

export const SessionWatcherAnswerYesPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  requestCount: z.number().int().nonnegative(),
}).strict();
export type SessionWatcherAnswerYesPayload = z.infer<typeof SessionWatcherAnswerYesPayloadSchema>;

export const SessionWatcherSetMutedPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  muted: z.boolean(),
}).strict();
export type SessionWatcherSetMutedPayload = z.infer<typeof SessionWatcherSetMutedPayloadSchema>;

export const SessionWatcherTypingHoldPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  /** Epoch ms until which the watcher holds its reply; 0 releases the hold. */
  untilMs: z.number().int().nonnegative(),
}).strict();
export type SessionWatcherTypingHoldPayload = z.infer<typeof SessionWatcherTypingHoldPayloadSchema>;
