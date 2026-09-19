import { z } from 'zod';
import { LoopStatusSchema } from '@contracts/schemas/loop';

export const LOOP_CLI_METHODS = {
  list: 'orchestrator_tools.loop.list',
  resume: 'orchestrator_tools.loop.resume',
} as const;

export type LoopCliRpcMethod = typeof LOOP_CLI_METHODS[keyof typeof LOOP_CLI_METHODS];

/** Keep list output small enough to paste into a turn without truncation. */
export const LOOP_CLI_GOAL_PREVIEW_CHARS = 200;
export const LOOP_CLI_MAX_LIST_LIMIT = 200;
export const LOOP_CLI_DEFAULT_LIST_LIMIT = 50;

export const LoopCliListPayloadSchema = z.object({
  /** When false (the default) only resumable loops are returned. */
  all: z.boolean().default(false),
  limit: z.number().int().min(1).max(LOOP_CLI_MAX_LIST_LIMIT).default(LOOP_CLI_DEFAULT_LIST_LIMIT),
}).strict();

export const LoopCliResumePayloadSchema = z.object({
  loopRunId: z.string().min(1).max(200),
}).strict();

export const LoopCliRunSchema = z.object({
  loopRunId: z.string(),
  status: LoopStatusSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  endReason: z.string().nullable(),
  totalIterations: z.number().int().nonnegative(),
  workspaceCwd: z.string(),
  /** Truncated `initialPrompt` — enough to recognise the run, not the whole prompt. */
  goal: z.string(),
  /** True when the coordinator still holds live state for this run. */
  live: z.boolean(),
  /** True when a stored checkpoint exists to re-hydrate the run from. */
  checkpointAvailable: z.boolean(),
  /** True when `aio-mcp loop resume <loopRunId>` would be accepted. */
  resumable: z.boolean(),
}).strict();

export const LoopCliListResultSchema = z.object({
  count: z.number().int().nonnegative(),
  runs: z.array(LoopCliRunSchema).max(LOOP_CLI_MAX_LIST_LIMIT),
}).strict();

export const LoopCliResumeResultSchema = z.object({
  loopRunId: z.string(),
  resumed: z.literal(true),
  status: LoopStatusSchema,
  previousStatus: LoopStatusSchema,
  restoredFromCheckpoint: z.boolean(),
}).strict();

export type LoopCliListPayload = z.infer<typeof LoopCliListPayloadSchema>;
export type LoopCliResumePayload = z.infer<typeof LoopCliResumePayloadSchema>;
export type LoopCliRun = z.infer<typeof LoopCliRunSchema>;
export type LoopCliListResult = z.infer<typeof LoopCliListResultSchema>;
export type LoopCliResumeResult = z.infer<typeof LoopCliResumeResultSchema>;

/**
 * Parent-process operations behind `aio-mcp loop`. Implemented in
 * `src/main/orchestration/default-loop-cli-operations.ts`; kept as an
 * interface so the RPC dispatch layer never imports the coordinator
 * (and, through it, Electron) into the SEA bundle.
 */
export interface LoopCliOperations {
  list(payload: LoopCliListPayload): unknown | Promise<unknown>;
  resume(payload: LoopCliResumePayload): unknown | Promise<unknown>;
}
