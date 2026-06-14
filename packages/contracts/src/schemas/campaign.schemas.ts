/**
 * Campaign Mode Zod schemas — IPC payload validation.
 */
import { z } from 'zod';

// -------------------------------------------------------------------------
// Enum schemas
// -------------------------------------------------------------------------

const TerminalStatusPredicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('is'), status: z.string() }),
  z.object({ type: z.literal('in'), statuses: z.array(z.string()) }),
  z.object({ type: z.literal('not'), status: z.string() }),
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
