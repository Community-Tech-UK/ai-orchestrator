import { z } from 'zod';
import {
  InstanceIdSchema,
  WorkingDirectorySchema,
  DisplayNameSchema,
  ModelIdSchema,
} from './common.schemas';

export const SessionRecoveryReasonSchema = z.enum([
  'newer-than-history',
  'unarchived',
  'draft-only',
]);

export const SessionRecoveryProviderSchema = z.enum([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
  'auto',
  'cursor',
  'grok',
]);

export const SessionRecoveryCandidateSchema = z.object({
  recoveryKey: z.string().min(1).max(500),
  sourceInstanceId: InstanceIdSchema,
  historyThreadId: z.string().min(1).max(200).optional(),
  provider: SessionRecoveryProviderSchema,
  modelId: ModelIdSchema.optional(),
  displayName: DisplayNameSchema.optional(),
  workingDirectory: WorkingDirectorySchema.optional(),
  lastActivityAt: z.number().int().nonnegative(),
  historyCoveredThrough: z.number().int().nonnegative().optional(),
  recoveredMessageCount: z.number().int().nonnegative(),
  reason: SessionRecoveryReasonSchema,
  nativeResumeAvailable: z.boolean(),
}).strict();

export const SessionRecoveryListPayloadSchema = z.undefined().optional();
export const SessionRecoveryListResultSchema = z.array(SessionRecoveryCandidateSchema);

export const RecoverSessionRequestSchema = z.object({
  recoveryKey: z.string().min(1).max(500),
}).strict();

export const RecoverSessionResultSchema = z.object({
  instanceId: InstanceIdSchema,
  recoveredMessageCount: z.number().int().nonnegative(),
  usedNativeResume: z.boolean(),
}).strict();
