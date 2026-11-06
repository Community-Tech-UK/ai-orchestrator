import { z } from 'zod';

const observationNumber = z.number().nonnegative();
/** Only sanitized process observations cross the worker boundary. */
export const StallProcessFactsSchema = z.object({
  pid: z.number().int().min(2),
  state: z.enum(['running', 'sleeping', 'disk-wait', 'stopped', 'zombie', 'unknown']),
  cpuPercent: observationNumber.nullable(),
  rssMb: observationNumber,
  child: z.object({
    label: z.string().max(60).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
    runningSeconds: observationNumber,
    cpuPercent: observationNumber.nullable(),
  }).strict().nullable(),
  sampledAt: observationNumber,
}).strict();

export const InstanceSampleStallProcessParamsSchema = z.object({
  instanceId: z.string().min(1).max(256),
  silenceMs: observationNumber,
}).strict();
