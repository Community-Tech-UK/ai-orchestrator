import { z } from 'zod';

export const GlobalPausePhaseSchema = z.enum(['none', 'holding', 'collecting', 'ready', 'resuming']);
export const GlobalPauseEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['session', 'queue-run', 'loop', 'campaign', 'automation-run', 'repo-job']),
  targetId: z.string(),
  displayName: z.string(),
  workspace: z.string().nullable(),
  provider: z.string().nullable(),
  originalInstanceId: z.string().nullable(),
  historyThreadId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  wasBusy: z.boolean(),
  noteText: z.string().nullable(),
  noteKind: z.enum(['agent', 'basic', 'none']),
  state: z.enum(['pending', 'note-requested', 'ready', 'resumed', 'failed', 'void']),
  voidReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const GlobalPauseStateSchema = z.object({
  phase: GlobalPausePhaseSchema,
  collectionStage: z.enum(['stopping-work', 'writing-notes']).optional(),
  since: z.number().nullable(),
  reason: z.string().nullable(),
  batchId: z.string().nullable(),
  heldInstanceIds: z.array(z.string()),
  entries: z.array(GlobalPauseEntrySchema),
  completedNotes: z.number().int().nonnegative(),
  totalNotes: z.number().int().nonnegative(),
  resumeInterrupted: z.boolean(),
  stale: z.boolean(),
  summary: z.string().nullable(),
  runningWork: z.object({ sessions: z.number().int().nonnegative(), queueJobs: z.number().int().nonnegative(), loops: z.number().int().nonnegative() }).optional(),
});
export const GlobalPauseHoldSchema = z.object({ reason: z.string().max(500).optional() }).strict();
export const GlobalPauseRestartSchema = z.object({ withNotes: z.boolean() }).strict();
export const GlobalPausePickUpSchema = z.object({ instanceId: z.string().min(1).max(200) }).strict();
export type GlobalPausePhase = z.infer<typeof GlobalPausePhaseSchema>;
export type GlobalPauseEntry = z.infer<typeof GlobalPauseEntrySchema>;
export type GlobalPauseState = z.infer<typeof GlobalPauseStateSchema>;
