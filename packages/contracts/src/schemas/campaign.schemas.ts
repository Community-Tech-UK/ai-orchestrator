/**
 * Campaign Mode Zod schemas — IPC payload validation.
 */
import { z } from 'zod';

// -------------------------------------------------------------------------
// Enum schemas
// -------------------------------------------------------------------------

const LoopTerminalStatusSchema = z.enum([
  'completed',
  'completed-needs-review',
  'failed',
  'operator-halted',
]);

const CampaignStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'halted',
]);

const CampaignNodeStatusSchema = z.enum([
  'pending',
  'running',
  'skipped',
  'completed',
  'completed-needs-review',
  'failed',
  'provider-limit',
  'operator-halted',
]);

const TerminalStatusPredicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('is'), status: LoopTerminalStatusSchema }),
  z.object({ type: z.literal('in'), statuses: z.array(LoopTerminalStatusSchema).min(1) }),
  z.object({ type: z.literal('not'), status: LoopTerminalStatusSchema }),
]);

const CampaignEdgeSchema = z.object({
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  when: TerminalStatusPredicateSchema.optional(),
});

const CampaignPolicySchema = z.object({
  onNodeNeedsReview: z.enum(['pause-campaign', 'continue', 'halt']),
  maxParallel: z.number().int().min(1).max(16),
  isolation: z.enum(['worktree']).optional(),
});

const LoopConfigInputSchema = z.object({
  initialPrompt: z.string().min(1).max(100_000),
  workspaceCwd: z.string().min(1).max(2000),
}).passthrough();

const CampaignNodeSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(500).optional(),
  loopConfig: LoopConfigInputSchema,
  dependsOn: z.array(z.string()).default([]),
});

export const CampaignSpecSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  nodes: z.array(CampaignNodeSchema).min(1),
  edges: z.array(CampaignEdgeSchema),
  policy: CampaignPolicySchema,
  createdAt: z.number().int().positive(),
  sourceRef: z.string().max(2000).optional(),
  /** WS8: preview-time plan digest for the start-time staleness check. */
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

// -------------------------------------------------------------------------
// IPC payload schemas
// -------------------------------------------------------------------------

export const CampaignStartPayloadSchema = CampaignSpecSchema;

export const CampaignGetPayloadSchema = z.object({
  campaignId: z.string().min(1).max(200),
});

export const CampaignListPayloadSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export const CampaignHaltPayloadSchema = z.object({
  campaignId: z.string().min(1).max(200),
});

export const CampaignResumePayloadSchema = z.object({
  campaignId: z.string().min(1).max(200),
});

export const CampaignValidatePayloadSchema = CampaignSpecSchema;

/** WS8: preview payload — plan path + base loop settings for node configs. */
export const CampaignImportPlanPreviewPayloadSchema = z.object({
  workspaceCwd: z.string().min(1).max(2000),
  planFile: z.string().min(1).max(2000),
  baseLoop: z.object({
    verifyCommand: z.string().max(4000),
    provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']).optional(),
    maxCostCents: z.number().int().positive().max(1_000_000).optional(),
    maxTurnsPerIteration: z.number().int().positive().max(1000).optional(),
  }),
});

// -------------------------------------------------------------------------
// Main-to-renderer event schemas
// -------------------------------------------------------------------------

const CampaignNodeRunDtoSchema = z.object({
  nodeId: z.string().min(1).max(200),
  campaignId: z.string().min(1).max(200),
  status: CampaignNodeStatusSchema,
  loopRunId: z.string().min(1).max(200).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  skippedReason: z.string().max(10_000).optional(),
}).strict();

const CampaignRunDtoSchema = z.object({
  id: z.string().min(1).max(200),
  spec: CampaignSpecSchema,
  status: CampaignStatusSchema,
  nodeRuns: z.array(CampaignNodeRunDtoSchema),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  pausedReason: z.string().max(10_000).optional(),
}).strict();

const CampaignIdEventDataSchema = z.object({
  campaignId: z.string().min(1).max(200),
}).strict();

const CampaignReasonEventDataSchema = CampaignIdEventDataSchema.extend({
  reason: z.string().min(1).max(10_000),
}).strict();

const CampaignNodeStartedEventDataSchema = CampaignIdEventDataSchema.extend({
  nodeId: z.string().min(1).max(200),
  loopRunId: z.string().min(1).max(200),
}).strict();

const CampaignNodeTerminalEventDataSchema = CampaignIdEventDataSchema.extend({
  nodeId: z.string().min(1).max(200),
  status: LoopTerminalStatusSchema,
}).strict();

const CampaignNodeSkippedEventDataSchema = CampaignIdEventDataSchema.extend({
  nodeId: z.string().min(1).max(200),
  reason: z.string().min(1).max(10_000),
}).strict();

const CampaignStateEventDataSchema = CampaignIdEventDataSchema.extend({
  nodeId: z.string().min(1).max(200),
  nodeStatus: CampaignNodeStatusSchema,
  campaignStatus: CampaignStatusSchema,
}).strict();

const campaignEvent = <TEvent extends string, TData extends z.ZodType>(
  event: TEvent,
  data: TData,
) => z.object({
  event: z.literal(event),
  data,
  campaignId: z.string().min(1).max(200),
  campaign: CampaignRunDtoSchema.nullable(),
}).strict();

export const CampaignStateChangedEventSchema = z.discriminatedUnion('event', [
  campaignEvent('campaign:started', CampaignIdEventDataSchema),
  campaignEvent('campaign:paused', CampaignReasonEventDataSchema),
  campaignEvent('campaign:resumed', CampaignIdEventDataSchema),
  campaignEvent('campaign:completed', CampaignIdEventDataSchema),
  campaignEvent('campaign:failed', CampaignIdEventDataSchema),
  campaignEvent('campaign:halted', CampaignReasonEventDataSchema),
  campaignEvent('campaign:node-started', CampaignNodeStartedEventDataSchema),
  campaignEvent('campaign:node-terminal', CampaignNodeTerminalEventDataSchema),
  campaignEvent('campaign:node-skipped', CampaignNodeSkippedEventDataSchema),
  campaignEvent('campaign:state-changed', CampaignStateEventDataSchema),
]).superRefine((payload, context) => {
  if (payload.campaignId !== payload.data.campaignId) {
    context.addIssue({
      code: 'custom',
      path: ['campaignId'],
      message: 'campaignId must match data.campaignId',
    });
  }
  if (payload.campaign && payload.campaign.id !== payload.campaignId) {
    context.addIssue({
      code: 'custom',
      path: ['campaign', 'id'],
      message: 'campaign.id must match campaignId',
    });
  }
});
