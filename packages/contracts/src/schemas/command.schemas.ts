import { z } from 'zod';
import { InstanceIdSchema } from './common.schemas';

export const CommandIdSchema = z.string().min(1).max(200);

export const CommandListPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const CommandResolvePayloadSchema = z.object({
  input: z.string().min(1).max(10000),
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export const CommandExecutePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  commandId: CommandIdSchema,
  args: z.array(z.string().max(10000)).max(50).optional(),
  context: z.object({
    isGitRepo: z.boolean().optional(),
    featureFlags: z.record(z.string(), z.boolean()).optional(),
  }).optional(),
});

export const CommandCreatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  template: z.string().min(1).max(100000),
  hint: z.string().max(500).optional(),
  shortcut: z.string().max(50).optional(),
});

export const CommandUpdatePayloadSchema = z.object({
  commandId: CommandIdSchema,
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(1000).optional(),
    template: z.string().min(1).max(100000).optional(),
    hint: z.string().max(500).optional(),
    shortcut: z.string().max(50).optional(),
  }),
});

export const CommandDeletePayloadSchema = z.object({
  commandId: CommandIdSchema,
});

export const UsageKindSchema = z.enum(['command', 'session', 'model', 'prompt', 'resume']);

export const UsageRecordPayloadSchema = z.object({
  kind: UsageKindSchema,
  id: z.string().min(1).max(500),
  context: z.string().max(500).optional(),
  timestamp: z.number().int().positive().optional(),
});

export const UsageSnapshotPayloadSchema = z.object({
  kind: UsageKindSchema.optional(),
});

export const WorkspaceIsGitRepoPayloadSchema = z.object({
  workingDirectory: z.string().min(1).max(10000),
});

// --- Magic Prompts (schema-backed one-shot structured commands) ---

/** Identifier of a registered magic prompt (e.g. 'recap', 'commit-message'). */
export const MagicPromptIdSchema = z.string().min(1).max(100);

export const MagicPromptListPayloadSchema = z.object({}).optional();

export const MagicPromptRunPayloadSchema = z.object({
  id: MagicPromptIdSchema,
  /** Primary text the prompt operates on — a transcript, a diff, etc. */
  text: z.string().min(1).max(500_000),
  /** Optional extra context appended to the prompt. */
  context: z.string().max(100_000).optional(),
  /** Preferred provider; falls back to the first available fast CLI. */
  provider: z.string().min(1).max(100).optional(),
  /** Working directory the one-shot adapter should run in. */
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export type CommandListPayload = z.infer<typeof CommandListPayloadSchema>;
export type CommandResolvePayload = z.infer<typeof CommandResolvePayloadSchema>;
export type CommandExecutePayload = z.infer<typeof CommandExecutePayloadSchema>;
export type UsageRecordPayload = z.infer<typeof UsageRecordPayloadSchema>;
export type UsageSnapshotPayload = z.infer<typeof UsageSnapshotPayloadSchema>;
export type WorkspaceIsGitRepoPayload = z.infer<typeof WorkspaceIsGitRepoPayloadSchema>;
export type MagicPromptListPayload = z.infer<typeof MagicPromptListPayloadSchema>;
export type MagicPromptRunPayload = z.infer<typeof MagicPromptRunPayloadSchema>;

// --- Multi-provider compare ---

export const CompareRunPayloadSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  providers: z.array(z.string().min(1).max(50)).min(1).max(8),
  workingDirectory: z.string().min(1).max(10000).optional(),
});

export type CompareRunPayload = z.infer<typeof CompareRunPayloadSchema>;

// --- Ask Council: progressive compare with synthesis (WS-B6) ---

export const CouncilMemberStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export type CouncilMemberStatus = z.infer<typeof CouncilMemberStatusSchema>;

export const CouncilMemberSchema = z.object({
  provider: z.string().min(1).max(50),
  status: CouncilMemberStatusSchema,
  model: z.string().max(200).optional(),
  answer: z.string().max(200_000).optional(),
  error: z.string().max(5000).optional(),
  startedAt: z.number().optional(),
  durationMs: z.number().optional(),
});

export type CouncilMember = z.infer<typeof CouncilMemberSchema>;

/** consensus/debate reuse AIO's own synthesis machinery; a provider id routes
 *  the attributed synthesis prompt through that single chosen provider. */
export const CouncilSynthesisMethodSchema = z.union([
  z.literal('consensus'),
  z.literal('debate'),
  z.object({ providerId: z.string().min(1).max(50) }),
]);

export type CouncilSynthesisMethod = z.infer<typeof CouncilSynthesisMethodSchema>;

export const CouncilSynthesisAttributionSchema = z.object({
  provider: z.string().min(1).max(50),
  included: z.boolean(),
  /** Why an absent member was excluded (its terminal status/error). */
  reason: z.string().max(500).optional(),
});

export type CouncilSynthesisAttribution = z.infer<typeof CouncilSynthesisAttributionSchema>;

export const CouncilSynthesisResultSchema = z.object({
  method: CouncilSynthesisMethodSchema,
  text: z.string().max(200_000),
  attribution: z.array(CouncilSynthesisAttributionSchema).max(8),
  generatedAt: z.number(),
  error: z.string().max(2000).optional(),
});

export type CouncilSynthesisResult = z.infer<typeof CouncilSynthesisResultSchema>;

export const CouncilRunSchema = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  workingDirectory: z.string().max(10000).optional(),
  createdAt: z.number(),
  members: z.array(CouncilMemberSchema).max(8),
  cancelled: z.boolean(),
  synthesis: CouncilSynthesisResultSchema.optional(),
});

export type CouncilRun = z.infer<typeof CouncilRunSchema>;

/** Same shape as compare:run — start a progressive run instead of awaiting all answers. */
export const CompareStartPayloadSchema = CompareRunPayloadSchema;
export type CompareStartPayload = z.infer<typeof CompareStartPayloadSchema>;

export const CompareCancelPayloadSchema = z.object({
  runId: z.string().min(1).max(200),
});
export type CompareCancelPayload = z.infer<typeof CompareCancelPayloadSchema>;

export const CompareSynthesizePayloadSchema = z.object({
  runId: z.string().min(1).max(200),
  method: CouncilSynthesisMethodSchema,
});
export type CompareSynthesizePayload = z.infer<typeof CompareSynthesizePayloadSchema>;

/** Omit runId to fetch the most recently started run (renderer reload/restart rehydrate). */
export const CompareGetRunPayloadSchema = z.object({
  runId: z.string().min(1).max(200).optional(),
});
export type CompareGetRunPayload = z.infer<typeof CompareGetRunPayloadSchema>;

export const CompareRunUpdatedEventSchema = CouncilRunSchema;
