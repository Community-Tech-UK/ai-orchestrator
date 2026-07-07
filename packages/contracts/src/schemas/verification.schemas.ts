import { z } from 'zod';
import { RequiredModelIdSchema } from './common.schemas';

export const VerdictStatusSchema = z.enum([
  'pass',
  'pass-with-notes',
  'needs-changes',
  'blocked',
  'inconclusive',
]);

export const RiskAreaSeveritySchema = z.enum(['low', 'medium', 'high']);

export const RiskAreaCategorySchema = z.enum([
  'correctness',
  'security',
  'performance',
  'compatibility',
  'data-loss',
  'ux',
  'maintainability',
  'unknown',
]);

export const RiskAreaSchema = z.object({
  category: RiskAreaCategorySchema,
  description: z.string().min(1).max(5000),
  severity: RiskAreaSeveritySchema,
  agentIds: z.array(z.string().min(1).max(500)).max(100).optional(),
});

export const VerdictEvidenceSchema = z.object({
  kind: z.enum(['agent-response', 'agreement', 'disagreement', 'outlier', 'unique-insight']),
  agentId: z.string().min(1).max(500).optional(),
  snippet: z.string().max(2000).optional(),
  keyPointId: z.string().min(1).max(500).optional(),
});

const PersonalityTypeSchema = z.enum([
  'methodical-analyst',
  'creative-solver',
  'pragmatic-engineer',
  'security-focused',
  'user-advocate',
  'devils-advocate',
  'domain-expert',
  'generalist',
]);

const ExtractedKeyPointSchema = z.object({
  id: z.string().min(1).max(500),
  content: z.string().min(1).max(5000),
  category: z.enum(['conclusion', 'recommendation', 'warning', 'fact', 'opinion']),
  confidence: z.number().min(0).max(1),
  supportingEvidence: z.string().max(5000).optional(),
});

const AgentResponseSchema = z.object({
  agentId: z.string().min(1).max(500),
  agentIndex: z.number().int().min(0),
  model: RequiredModelIdSchema,
  response: z.string(),
  keyPoints: z.array(ExtractedKeyPointSchema),
  confidence: z.number().min(0).max(1),
  personality: PersonalityTypeSchema.optional(),
  reasoning: z.string().optional(),
  duration: z.number().min(0),
  tokens: z.number().min(0),
  cost: z.number().min(0),
  error: z.string().optional(),
  timedOut: z.boolean().optional(),
});

export const VerificationVerdictSchema = z.object({
  status: VerdictStatusSchema,
  confidence: z.number().min(0).max(1),
  headline: z.string().max(500).optional(),
  requiredActions: z.array(z.string().min(1).max(5000)).max(100),
  riskAreas: z.array(RiskAreaSchema).max(100),
  evidence: z.array(VerdictEvidenceSchema).max(500),
  rawResponses: z.array(AgentResponseSchema).max(100),
  sourceResultId: z.string().min(1).max(500),
  derivedAt: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
});

export const VerdictDerivationDiagnosticSchema = z.object({
  reason: z.enum([
    'normal',
    'low-confidence',
    'missing-analysis',
    'no-disagreements',
    'unknown-error',
  ]),
  note: z.string().max(5000).optional(),
});

export const VerificationVerdictReadyPayloadSchema = z.object({
  resultId: z.string().min(1).max(500),
  instanceId: z.string().min(1).max(500),
  verdict: VerificationVerdictSchema,
  diagnostic: VerdictDerivationDiagnosticSchema.optional(),
});

export type VerificationVerdictPayload = z.infer<typeof VerificationVerdictSchema>;
export type VerificationVerdictReadyPayload = z.infer<typeof VerificationVerdictReadyPayloadSchema>;
