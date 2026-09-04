import { z } from 'zod';

/**
 * Every activity kind the main process can put on the `loop:activity` push
 * channel (LT-021). This is the single source of truth: `LoopInvocationActivity`
 * in the main process derives its kind from `LoopActivityKind` below, so adding
 * one there without adding it here is a type error rather than an event the
 * renderer-boundary validator silently drops.
 */
export const LoopActivityKindSchema = z.enum([
  'spawned',
  'status',
  'tool_use',
  'tool_result',
  'assistant',
  'system',
  'input_required',
  'error',
  'stream-idle',
  'complete',
  'heartbeat',
]);
