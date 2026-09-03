import { z } from 'zod';

export const LoopAutoUnstickStateSchema = z.object({
  seq: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  max: z.number().int().positive(),
  signalId: z.string().min(1),
});
