import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const PlanQueueCapabilityGapSchema = z.object({
  capabilityKey: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  check: text(500),
  requiredAction: text(2000),
  platform: z.enum(['macos', 'windows', 'linux', 'any']),
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  classification: z.enum(['capability', 'setup', 'human-authority', 'human-input']),
  attempts: z.array(z.object({ operation: text(500), observedAt: z.number().int().nonnegative(), result: text(2000) }).strict()).min(1).max(12),
  alternative: text(2000),
  expectedResult: text(2000),
  implementation: text(8000),
  repairRepository: text(4000).optional(),
}).strict();

export const PlanQueueReportCapabilityGapArgsSchema = z.object({
  item_id: text(200).optional(),
  run_id: text(200).optional(),
  document_path: text(4000).optional(),
  gap: PlanQueueCapabilityGapSchema,
}).strict().refine(value => value.item_id ? !value.run_id && !value.document_path : !!value.run_id && !!value.document_path,
  'Give item_id, or run_id and document_path for a triage batch.');

export const PlanQueueCapabilityProbeSchema = z.object({
  computer: z.enum(['windows-pc', 'ct-test-mac']),
  runtimeBuild: z.string().regex(/^[a-f0-9]{40,64}$/),
  testedTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  observedAt: z.number().int().nonnegative(),
  operation: text(2000),
  result: text(4000),
  receiptPath: text(4000),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const PlanQueueCapabilityControlArgsSchema = z.object({
  run_id: text(200),
  repository: text(4000),
}).strict();
export const PlanQueueReportCapabilityCheckArgsSchema = z.object({
  item_id: text(200), repair_id: text(200), check: text(500), evidence: text(4000),
}).strict();

export const PlanQueueReportCapabilityProbeArgsSchema = z.object({
  item_id: text(200),
  probe: PlanQueueCapabilityProbeSchema,
}).strict();

export const PlanQueueCapabilityStateSchema = z.enum(['investigating', 'planned', 'running', 'waiting', 'verifying-origin', 'resolved', 'cancelled']);
export type PlanQueueCapabilityGap = z.infer<typeof PlanQueueCapabilityGapSchema>;
export type PlanQueueReportCapabilityGapArgs = z.infer<typeof PlanQueueReportCapabilityGapArgsSchema>;
export type PlanQueueCapabilityProbe = z.infer<typeof PlanQueueCapabilityProbeSchema>;
export type PlanQueueReportCapabilityProbeArgs = z.infer<typeof PlanQueueReportCapabilityProbeArgsSchema>;
export type PlanQueueCapabilityState = z.infer<typeof PlanQueueCapabilityStateSchema>;
export type PlanQueueCapabilityControlArgs = z.infer<typeof PlanQueueCapabilityControlArgsSchema>;
export type PlanQueueReportCapabilityCheckArgs = z.infer<typeof PlanQueueReportCapabilityCheckArgsSchema>;
