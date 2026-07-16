import { z } from 'zod';
import type {
  AccuracyGateResult,
  ContextEvidenceRendererMetrics,
  ContextEvidenceCompareRequest,
  ContextEvidenceGetCardRequest,
  ContextEvidenceGetMetricsRequest,
  ContextEvidenceListRequest,
  ContextEvidenceReadRequest,
  ContextEvidenceSearchRequest,
  ContextEvidenceStateChanged,
  ContextEvidenceVerifyRequest,
  ContextOccupancy,
  ContextPressureSample,
  EnforcementAction,
  EvidenceCaptureRequest,
  EvidenceCaptureResult,
  EvidenceCard,
  EvidenceCitation,
  EvidenceContradiction,
  EvidenceContradictionResolution,
  EvidenceFinding,
  EvidenceRecord,
  EvidenceRetrievalRequest,
  EvidenceRetrievalResponse,
  ProviderContextCapabilities,
  WorkingSetAllocation,
} from '../types/context-evidence.types';

const IdentifierSchema = z.string().min(1).max(500);
const DisclosureSchema = z.string().min(1).max(5_000);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();
const KeyedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const EvidenceSourceKindSchema = z.enum([
  'command',
  'file',
  'database',
  'web',
  'mcp',
  'browser',
  'other',
]);
export const EvidenceStatusSchema = z.enum(['staging', 'complete', 'failed', 'corrupt', 'deleted']);
export const EvidenceSensitivitySchema = z.enum(['normal', 'sensitive', 'restricted']);
export const EvidenceProvenanceTrustSchema = z.enum(['runtime-authenticated', 'legacy-unverified']);
export const EvidenceCaptureModeSchema = z.enum(['pre-retention', 'post-retention', 'observed-only']);
export const EvidenceCaptureCompletenessSchema = z.enum(['complete', 'bounded', 'metadata-only']);

function requireIncompleteCaptureDisclosure(
  value: { captureCompleteness: 'complete' | 'bounded' | 'metadata-only'; truncationReason?: string },
  context: z.RefinementCtx,
): void {
  if (value.captureCompleteness !== 'complete' && !value.truncationReason?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['truncationReason'],
      message: 'A truncation reason is required when capture is not complete.',
    });
  }
}

export const EvidenceRecordSchema: z.ZodType<EvidenceRecord> = z.object({
  id: IdentifierSchema,
  conversationId: IdentifierSchema,
  provider: IdentifierSchema,
  providerThreadRef: IdentifierSchema.optional(),
  turnRef: IdentifierSchema.optional(),
  toolCallRef: IdentifierSchema.optional(),
  toolName: IdentifierSchema,
  sourceKind: EvidenceSourceKindSchema,
  sourceLocatorRedacted: z.string().min(1).max(2_000).optional(),
  status: EvidenceStatusSchema,
  keyedContentId: KeyedDigestSchema.optional(),
  byteCount: NonNegativeIntegerSchema,
  tokenEstimate: NonNegativeIntegerSchema.optional(),
  mimeType: z.string().min(1).max(255),
  sensitivity: EvidenceSensitivitySchema,
  provenanceTrust: EvidenceProvenanceTrustSchema,
  createdAt: NonNegativeIntegerSchema,
  completedAt: NonNegativeIntegerSchema.optional(),
  keyVersion: PositiveIntegerSchema.optional(),
  captureMode: EvidenceCaptureModeSchema,
  captureCompleteness: EvidenceCaptureCompletenessSchema,
  truncationReason: DisclosureSchema.optional(),
}).strict().superRefine((record, context) => {
  requireIncompleteCaptureDisclosure(record, context);
  if (record.status !== 'complete') {
    return;
  }
  for (const field of ['keyedContentId', 'completedAt', 'keyVersion'] as const) {
    if (record[field] === undefined) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is required when evidence is complete.`,
      });
    }
  }
  if (record.completedAt !== undefined && record.completedAt < record.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'Evidence cannot complete before it was created.',
    });
  }
});

export const EvidenceCitationSchema: z.ZodType<EvidenceCitation> = z.object({
  evidenceId: IdentifierSchema,
  startByte: NonNegativeIntegerSchema,
  endByte: NonNegativeIntegerSchema,
  contentDigest: KeyedDigestSchema,
}).strict().superRefine((value, context) => {
  if (value.endByte <= value.startByte) {
    context.addIssue({
      code: 'custom',
      path: ['endByte'],
      message: 'The end byte must be greater than the start byte.',
    });
  }
});

export const EvidenceFindingSchema: z.ZodType<EvidenceFinding> = z.object({
  id: IdentifierSchema,
  kind: z.enum(['fact', 'change', 'warning', 'error', 'verification']),
  statement: DisclosureSchema,
  importance: z.enum(['info', 'warning', 'critical']),
  citations: z.array(EvidenceCitationSchema).min(1).max(1_000),
}).strict();

export const EvidenceContradictionResolutionSchema: z.ZodType<EvidenceContradictionResolution> = z.object({
  statement: DisclosureSchema,
  citations: z.array(EvidenceCitationSchema).min(1).max(1_000),
}).strict();

const EvidenceContradictionBaseShape = {
  id: IdentifierSchema,
  statement: DisclosureSchema,
  leftCitations: z.array(EvidenceCitationSchema).min(1).max(1_000),
  rightCitations: z.array(EvidenceCitationSchema).min(1).max(1_000),
};

export const EvidenceContradictionSchema: z.ZodType<EvidenceContradiction> = z.discriminatedUnion('status', [
  z.object({
    ...EvidenceContradictionBaseShape,
    status: z.literal('unresolved'),
    resolution: z.never().optional(),
  }).strict(),
  z.object({
    ...EvidenceContradictionBaseShape,
    status: z.literal('resolved'),
    resolution: EvidenceContradictionResolutionSchema,
  }).strict(),
]);

function citationKey(citation: EvidenceCitation): string {
  return JSON.stringify([
    citation.evidenceId,
    citation.startByte,
    citation.endByte,
    citation.contentDigest,
  ]);
}

export const EvidenceCardSchema: z.ZodType<EvidenceCard> = z.object({
  id: IdentifierSchema,
  evidenceId: IdentifierSchema,
  version: PositiveIntegerSchema,
  status: z.enum(['validated', 'partial', 'failed']),
  summary: z.string().max(20_000),
  findings: z.array(EvidenceFindingSchema).max(1_000),
  citations: z.array(EvidenceCitationSchema).max(5_000),
  freshness: z.object({
    observedAt: NonNegativeIntegerSchema,
    sourcePublishedAt: NonNegativeIntegerSchema.optional(),
  }).strict().optional(),
  contradictions: z.array(EvidenceContradictionSchema).max(1_000),
  derivedBy: z.object({
    kind: z.enum(['deterministic', 'model-assisted']),
    version: IdentifierSchema,
  }).strict(),
  createdAt: NonNegativeIntegerSchema,
}).strict().superRefine((card, context) => {
  const included = new Set<string>(card.citations.map(citationKey));
  const citedByDerivedClaims = [
    ...card.findings.flatMap((finding) => finding.citations),
    ...card.contradictions.flatMap((contradiction) => [
      ...contradiction.leftCitations,
      ...contradiction.rightCitations,
      ...(contradiction.resolution?.citations ?? []),
    ]),
  ];

  for (const citation of citedByDerivedClaims) {
    if (!included.has(citationKey(citation))) {
      context.addIssue({
        code: 'custom',
        path: ['citations'],
        message: 'Every finding and contradiction citation must be included by the card.',
      });
      break;
    }
  }
});

const KnownContextOccupancySchema = z.object({
  status: z.literal('known'),
  used: NonNegativeIntegerSchema,
  total: PositiveIntegerSchema,
}).strict().superRefine((occupancy, context) => {
  if (occupancy.used > occupancy.total) {
    context.addIssue({
      code: 'custom',
      path: ['used'],
      message: 'Known occupancy cannot exceed the provider context total.',
    });
  }
});

const UnknownContextOccupancySchema = z.object({
  status: z.literal('unknown'),
  reason: DisclosureSchema,
}).strict();

export const ContextOccupancySchema: z.ZodType<ContextOccupancy> = z.discriminatedUnion('status', [
  KnownContextOccupancySchema,
  UnknownContextOccupancySchema,
]);

export const ContextPressureSampleSchema: z.ZodType<ContextPressureSample> = z.object({
  occupancy: ContextOccupancySchema,
  cumulativeTokens: NonNegativeIntegerSchema.optional(),
  outputBytesSinceCompaction: NonNegativeIntegerSchema,
  providerRequestCount: NonNegativeIntegerSchema,
  newEvidenceCount: NonNegativeIntegerSchema,
  newValidatedFindingCount: NonNegativeIntegerSchema,
  recoveryEpoch: NonNegativeIntegerSchema,
}).strict();

export const ProviderContextCapabilitiesSchema: z.ZodType<ProviderContextCapabilities> = z.object({
  toolResultControl: z.enum(['pre-retention', 'post-retention', 'none']),
  toolResultVisibility: z.enum(['full', 'bounded', 'metadata-only', 'none']),
  transcriptControl: z.enum(['rebuild', 'native-compaction', 'none']),
  occupancyReporting: z.enum(['current', 'aggregate-only', 'none']),
  cumulativeReporting: z.enum(['available', 'none']),
  interruptProof: z.enum(['observed', 'acknowledged-only', 'none']),
  compactionProof: z.enum(['observed', 'acknowledged-only', 'none']),
  sameThreadContinuation: z.boolean(),
}).strict();

export const EvidenceCaptureRequestSchema: z.ZodType<EvidenceCaptureRequest> = z.object({
  captureKey: IdentifierSchema,
  conversationId: IdentifierSchema,
  provider: IdentifierSchema,
  providerThreadRef: IdentifierSchema.optional(),
  turnRef: IdentifierSchema.optional(),
  toolCallRef: IdentifierSchema.optional(),
  toolName: IdentifierSchema,
  sourceKind: EvidenceSourceKindSchema,
  sourceLocatorRedacted: z.string().min(1).max(2_000).optional(),
  mimeType: z.string().min(1).max(255),
  sensitivity: EvidenceSensitivitySchema,
  provenanceTrust: EvidenceProvenanceTrustSchema,
  captureMode: EvidenceCaptureModeSchema,
  captureCompleteness: EvidenceCaptureCompletenessSchema,
  truncationReason: DisclosureSchema.optional(),
  content: z.instanceof(Uint8Array),
}).strict().superRefine(requireIncompleteCaptureDisclosure);

export const EvidenceCaptureResultSchema: z.ZodType<EvidenceCaptureResult> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), record: EvidenceRecordSchema }).strict(),
  z.object({ status: z.literal('duplicate'), record: EvidenceRecordSchema }).strict(),
  z.object({
    status: z.literal('failed'),
    errorCode: IdentifierSchema,
    disclosure: DisclosureSchema,
  }).strict(),
  z.object({
    status: z.literal('conflict'),
    errorCode: IdentifierSchema,
    disclosure: DisclosureSchema,
  }).strict(),
]);

const RetrievalRangeShape = {
  evidenceId: IdentifierSchema,
  startByte: NonNegativeIntegerSchema,
  endByte: NonNegativeIntegerSchema,
  tokenLimit: PositiveIntegerSchema.max(4_096),
};

const ContextEvidenceOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), chatId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal('instance'), instanceId: IdentifierSchema }).strict(),
]);

const ContextEvidenceScopeShape = {
  conversationId: IdentifierSchema,
  owner: ContextEvidenceOwnerSchema,
};

const ContextEvidenceRangeSchema = z.object({
  evidenceId: IdentifierSchema,
  startByte: NonNegativeIntegerSchema,
  endByte: PositiveIntegerSchema,
}).strict().refine((range) => range.endByte > range.startByte, {
  message: 'The end byte must be greater than the start byte.',
  path: ['endByte'],
});

export const ContextEvidenceListRequestSchema: z.ZodType<ContextEvidenceListRequest> = z.object({
  ...ContextEvidenceScopeShape,
  limit: PositiveIntegerSchema.max(100).optional(),
}).strict();

export const ContextEvidenceGetCardRequestSchema: z.ZodType<ContextEvidenceGetCardRequest> = z.object({
  ...ContextEvidenceScopeShape,
  cardId: IdentifierSchema,
  tokenLimit: PositiveIntegerSchema.max(4_096),
}).strict();

export const ContextEvidenceSearchRequestSchema: z.ZodType<ContextEvidenceSearchRequest> = z.object({
  ...ContextEvidenceScopeShape,
  query: z.string().trim().min(1).max(200),
  tokenLimit: PositiveIntegerSchema.max(4_096),
}).strict();

export const ContextEvidenceReadRequestSchema: z.ZodType<ContextEvidenceReadRequest> = z.object({
  ...ContextEvidenceScopeShape,
  ...RetrievalRangeShape,
}).strict().superRefine((request, context) => {
  if (request.endByte <= request.startByte) {
    context.addIssue({ code: 'custom', path: ['endByte'], message: 'The end byte must be greater than the start byte.' });
  }
});

export const ContextEvidenceCompareRequestSchema: z.ZodType<ContextEvidenceCompareRequest> = z.object({
  ...ContextEvidenceScopeShape,
  left: ContextEvidenceRangeSchema,
  right: ContextEvidenceRangeSchema,
}).strict();

export const ContextEvidenceVerifyRequestSchema: z.ZodType<ContextEvidenceVerifyRequest> = z.object({
  ...ContextEvidenceScopeShape,
  evidenceId: IdentifierSchema,
  startByte: NonNegativeIntegerSchema,
  endByte: PositiveIntegerSchema,
  contentDigest: KeyedDigestSchema,
}).strict().superRefine((request, context) => {
  if (request.endByte <= request.startByte) {
    context.addIssue({ code: 'custom', path: ['endByte'], message: 'The end byte must be greater than the start byte.' });
  }
});

export const ContextEvidenceGetMetricsRequestSchema: z.ZodType<ContextEvidenceGetMetricsRequest> = z.object({
  ...ContextEvidenceScopeShape,
}).strict();

export const EvidenceRetrievalRequestSchema: z.ZodType<EvidenceRetrievalRequest> = z.object({
  conversationId: IdentifierSchema,
  ...RetrievalRangeShape,
}).strict().superRefine((request, context) => {
  if (request.endByte <= request.startByte) {
    context.addIssue({
      code: 'custom',
      path: ['endByte'],
      message: 'The end byte must be greater than the start byte.',
    });
  }
});

export const EvidenceRetrievalResponseSchema: z.ZodType<EvidenceRetrievalResponse> = z.object({
  ...RetrievalRangeShape,
  content: z.string(),
  tokenCount: NonNegativeIntegerSchema,
  truncated: z.boolean(),
  citation: EvidenceCitationSchema,
  captureCompleteness: EvidenceCaptureCompletenessSchema,
  disclosure: DisclosureSchema.optional(),
}).strict().superRefine((response, context) => {
  if (response.endByte <= response.startByte) {
    context.addIssue({ code: 'custom', path: ['endByte'], message: 'The end byte must exceed the start byte.' });
  }
  if (response.tokenCount > response.tokenLimit) {
    context.addIssue({ code: 'custom', path: ['tokenCount'], message: 'The response exceeds its token limit.' });
  }
  if (
    response.citation.evidenceId !== response.evidenceId
    || response.citation.startByte !== response.startByte
    || response.citation.endByte !== response.endByte
  ) {
    context.addIssue({ code: 'custom', path: ['citation'], message: 'The citation must cover the returned range.' });
  }
  if ((response.truncated || response.captureCompleteness !== 'complete') && !response.disclosure?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['disclosure'],
      message: 'A disclosure is required for truncated or incomplete retrieval.',
    });
  }
});

export const AccuracyGateIssueCodeSchema = z.enum([
  'missing-evidence',
  'wrong-conversation',
  'invalid-citation',
  'stale-evidence',
  'unresolved-contradiction',
  'model-assisted-only',
  'missing-execution-receipt',
  'corrupt-evidence',
  'incomplete-capture-undisclosed',
  'legacy-unverified-only',
]);

export const AccuracyGateResultSchema: z.ZodType<AccuracyGateResult> = z.object({
  mode: z.enum(['casual', 'evidence-backed', 'completion-claim', 'high-stakes']),
  verdict: z.enum(['pass', 'warn', 'block']),
  checkedCitationCount: NonNegativeIntegerSchema,
  issues: z.array(z.object({
    code: AccuracyGateIssueCodeSchema,
    evidenceId: IdentifierSchema.optional(),
  }).strict()).max(1_000),
  disclosures: z.array(DisclosureSchema).max(1_000),
}).strict();

export const WorkingSetAllocationSchema: z.ZodType<WorkingSetAllocation> = z.object({
  capacityTokens: PositiveIntegerSchema.optional(),
  instructionsTokens: NonNegativeIntegerSchema,
  recentDialogueTokens: NonNegativeIntegerSchema,
  evidenceCardTokens: NonNegativeIntegerSchema,
  exactExcerptTokens: NonNegativeIntegerSchema,
  reasoningAndAnswerTokens: NonNegativeIntegerSchema,
  emergencyReserveTokens: NonNegativeIntegerSchema,
  normalWorkingSetTokens: NonNegativeIntegerSchema,
  totalAllocatedTokens: NonNegativeIntegerSchema,
  estimateKind: z.enum(['provider-tokenizer', 'conservative-fallback']),
}).strict().superRefine((allocation, context) => {
  const normalWorkingSetTokens = allocation.instructionsTokens
    + allocation.recentDialogueTokens
    + allocation.evidenceCardTokens
    + allocation.exactExcerptTokens;
  const totalAllocatedTokens = normalWorkingSetTokens
    + allocation.reasoningAndAnswerTokens
    + allocation.emergencyReserveTokens;

  if (allocation.normalWorkingSetTokens !== normalWorkingSetTokens) {
    context.addIssue({ code: 'custom', path: ['normalWorkingSetTokens'], message: 'Working-set total is inconsistent.' });
  }
  if (allocation.totalAllocatedTokens !== totalAllocatedTokens) {
    context.addIssue({ code: 'custom', path: ['totalAllocatedTokens'], message: 'Allocation total is inconsistent.' });
  }
  if (allocation.capacityTokens !== undefined && totalAllocatedTokens > allocation.capacityTokens) {
    context.addIssue({ code: 'custom', path: ['totalAllocatedTokens'], message: 'Allocation exceeds provider capacity.' });
  }
  if (
    allocation.capacityTokens !== undefined
    && normalWorkingSetTokens > allocation.capacityTokens * 0.6
  ) {
    context.addIssue({
      code: 'custom',
      path: ['normalWorkingSetTokens'],
      message: 'The ordinary working set cannot exceed 60% of known provider capacity.',
    });
  }
});

export const EnforcementActionKindSchema = z.enum([
  'none',
  'externalize-result',
  'rebuild-working-set',
  'native-compaction',
  'stop-broad-research',
  'controlled-interrupt',
  'controlled-recovery',
  'same-thread-continuation',
  'convergence-review',
  'pause',
]);

export const EnforcementActionSchema: z.ZodType<EnforcementAction> = z.object({
  kind: EnforcementActionKindSchema,
  trigger: z.enum([
    'oversized-result',
    'known-occupancy-60',
    'known-occupancy-75',
    'known-occupancy-85',
    'known-occupancy-92',
    'cumulative-2x',
    'cumulative-4x',
    'no-evidence-progress',
    'unknown-occupancy-budget',
    'manual',
  ]),
  recoveryEpoch: NonNegativeIntegerSchema,
  proofRequired: z.enum(['none', 'acknowledged', 'observed']),
  createdAt: NonNegativeIntegerSchema,
}).strict();

export const ContextEvidenceRendererMetricsSchema: z.ZodType<ContextEvidenceRendererMetrics> = z.object({
  occupancy: ContextOccupancySchema,
  cumulativeTokens: NonNegativeIntegerSchema.optional(),
  workingSet: WorkingSetAllocationSchema,
  evidenceRecordCount: NonNegativeIntegerSchema,
  evidenceCardCount: NonNegativeIntegerSchema,
  exactExcerptCount: NonNegativeIntegerSchema,
  externallyStoredBytes: NonNegativeIntegerSchema,
  modelRequestCount: NonNegativeIntegerSchema,
  toolCallCount: NonNegativeIntegerSchema,
  toolResultBytes: NonNegativeIntegerSchema,
  enforcementMode: z.enum(['off', 'shadow', 'enforce']),
  lastAction: EnforcementActionKindSchema.optional(),
  recoveryCount: NonNegativeIntegerSchema,
  updatedAt: NonNegativeIntegerSchema,
}).strict();

export const ContextEvidenceStateChangedSchema: z.ZodType<ContextEvidenceStateChanged> = z.object({
  conversationId: IdentifierSchema,
  metrics: ContextEvidenceRendererMetricsSchema,
}).strict();
