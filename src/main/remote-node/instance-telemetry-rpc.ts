import { z } from 'zod';
import { CodexEphemeralUsageSchema } from '../../shared/validation/codex-ephemeral-usage.schemas';

/** Only bounded diagnostics and numeric usage cross the worker boundary. */
export const InstanceTelemetrySchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('codex_ephemeral_usage'),
    payload: z.object({ interactionId: z.string().uuid(), receipt: CodexEphemeralUsageSchema }).strict(),
  }).strict(),
  z.object({
    event: z.literal('system_prompt_delivered'),
    payload: z.object({
      originalChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      deliveredChars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      truncated: z.boolean(),
      omittedHeadings: z.array(z.string().max(120)).max(12),
    }).strict(),
  }).strict(),
  z.object({
    // One Codex round's root/helper token split. Session kind, owner and trial arm are not sent: the controller
    // supplies those from its own spawn options, so a worker cannot label a row as someone else's.
    event: z.literal('session_turn_share'),
    payload: z.object({
      threadId: z.string().min(1).max(512),
      turnId: z.string().min(1).max(512),
      revision: z.number().int().nonnegative().max(1000),
      rootTokens: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
      helperTokens: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
      totalTokens: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
      helperShare: z.number().min(0).max(1),
      wrapUpDelivered: z.boolean(),
      stopRequested: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    event: z.literal('subagent_usage'),
    payload: z.object({
      toolUseId: z.string().min(1).max(512),
      finalContextTokens: z.number().nonnegative(),
      toolUses: z.number().nonnegative(),
      durationMs: z.number().nonnegative(),
      final: z.boolean(),
    }).strict(),
  }).strict(),
]);

export const InstanceTelemetryParamsSchema = z.object({
  instanceId: z.string().min(1).max(200),
  telemetry: InstanceTelemetrySchema,
  durableSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  replay: z.boolean().optional(),
  token: z.string().optional(),
}).strict();

export type InstanceTelemetry = z.infer<typeof InstanceTelemetrySchema>;
export interface RemoteInstanceTelemetry { nodeId: string; instanceId: string; telemetry: InstanceTelemetry }
