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
