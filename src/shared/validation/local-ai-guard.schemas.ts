import { z } from 'zod';
import {
  AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  AUXILIARY_DISCOVERY_MAX_MODELS,
} from '../types/auxiliary-llm.types';
import {
  LOCAL_AI_REVISION_CURSOR_MAX_DIGITS,
  LOCAL_AI_TARGET_NUMERIC_LIMITS,
} from '../types/local-ai-guard.types';
import {
  LocalAiExpectedModelSchema,
  LocalAiRoutingRoleSchema as AuxiliaryLlmSlotSchema,
  requireValidTargetModelRelationships,
} from './local-ai-target-model.schemas';

const IdSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.number().int().nonnegative();
const CountSchema = z.number().int().nonnegative();
const CostSchema = z.number().finite().nonnegative();
const MAX_ENDPOINT_URL_LENGTH = 2_048;
const MAX_EVIDENCE_TEXT_LENGTH = 512;
const MAX_EVIDENCE_ARRAY_LENGTH = 20;
const MAX_EVIDENCE_SERIALIZED_BYTES = 4 * 1024;
const MAX_HEALTH_STATE_TRANSITIONS = 8;
const MAX_SUMMARY_BREAKDOWN_ENTRIES = 1_000;

function isPrivateOrTailscaleIpv4(hostname: string): boolean {
  if (!hostname.split('.').every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) {
    return false;
  }
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return first === 10
    || (first === 127)
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 100 && second >= 64 && second <= 127);
}

function getRawUrlAuthority(raw: string): string | null {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(raw);
  if (!scheme) return null;

  const afterScheme = raw.slice(scheme[0].length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  return authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
}

function getRawUrlHostname(authority: string): string | null {
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket === -1 || !/^(:\d+)?$/.test(authority.slice(closingBracket + 1))) return null;
    return authority.slice(1, closingBracket).toLowerCase();
  }

  const portSeparator = authority.lastIndexOf(':');
  return (portSeparator === -1 ? authority : authority.slice(0, portSeparator)).toLowerCase();
}

function isLocalAiEndpointHostAllowed(rawHostname: string): boolean {
  return rawHostname === 'localhost'
    || rawHostname === '::1'
    || isPrivateOrTailscaleIpv4(rawHostname);
}

/**
 * Validates the same local/LAN/Tailscale endpoint policy used by auxiliary
 * local-model routing, while producing the one stable spelling persisted as a
 * Local AI Guard endpoint identity. Query strings and userinfo are disallowed
 * because this is a durable configuration DTO, never a credential transport.
 */
export function canonicalizeLocalAiEndpointUrl(raw: string): string {
  const value = raw.trim();
  const authority = getRawUrlAuthority(value);
  if (!authority) {
    throw new Error('Local AI endpoint URLs must include an HTTP(S) authority');
  }
  if (authority.includes('@')) {
    throw new Error('Local AI endpoint URLs must not include userinfo');
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error('Local AI endpoint URLs must not include query parameters or fragments');
  }

  const rawHostname = getRawUrlHostname(authority);
  if (!rawHostname || !isLocalAiEndpointHostAllowed(rawHostname)) {
    throw new Error('Local AI endpoint URLs must use a literal loopback, private, or Tailscale IPv4 host');
  }

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Local AI endpoint URLs must use HTTP(S)');
  }
  if (url.username || url.password) {
    throw new Error('Local AI endpoint URLs must not include userinfo');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

export const LocalAiEndpointUrlSchema = z.string().trim().min(1).max(MAX_ENDPOINT_URL_LENGTH)
  .transform((value, context) => {
    try {
      return canonicalizeLocalAiEndpointUrl(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid Local AI endpoint URL',
      });
      return z.NEVER;
    }
  });

export const LocalAiTargetLifecycleSchema = z.enum(['unmanaged', 'enrolled', 'paused', 'retired']);
export const LocalAiHealthStateSchema = z.enum(['checking', 'healthy', 'degraded', 'unavailable', 'paused']);
export const LocalAiHealthLayerSchema = z.enum(['worker', 'endpoint', 'model', 'inference', 'effectiveness']);
export const LocalAiFallbackPolicySchema = z.enum([
  'allow-silently',
  'notify-and-allow',
  'require-confirmation',
  'defer-locally',
  'block-paid-fallback',
]);
export const LocalAiFailureCodeSchema = z.enum([
  'worker-offline',
  'worker-degraded',
  'rpc-unavailable',
  'endpoint-not-advertised',
  'configuration-drift',
  'connection-refused',
  'endpoint-timeout',
  'protocol-error',
  'authentication-error',
  'missing-required-model',
  'insufficient-context',
  'inference-timeout',
  'malformed-inference-output',
  'latency-exceeded',
  'flapping',
  'monitor-error',
]);
export const LocalAiRepairActionSchema = z.enum([
  'recheck-layer',
  'deep-check',
  'validate-models',
  'reconnect-worker',
  'restart-ollama',
]);
export const LocalAiFallbackDispositionSchema = z.enum([
  'not-needed',
  'allowed',
  'pending-confirmation',
  'deferred',
  'blocked',
]);
export const LocalAiRoutingDecisionReasonSchema = z.enum([
  'health',
  'policy',
  'daily-budget',
  'incident-budget',
  'confirmation',
]);

const LocalAiLocationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('coordinator') }).strict(),
  z.object({ type: z.literal('worker'), nodeId: IdSchema }).strict(),
]);
function boundedInteger(limit: { readonly min: number; readonly max: number }) {
  return z.number().finite().int().min(limit.min).max(limit.max);
}

function boundedNumber(limit: { readonly min: number; readonly max: number }) {
  return z.number().finite().min(limit.min).max(limit.max);
}

const LocalAiCanarySchema = z.object({
  model: IdSchema,
  timeoutMs: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.canaryTimeoutMs),
  intervalMs: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.canaryIntervalMs),
}).strict();
const LocalAiRecoverySchema = z.object({
  automatic: z.boolean(),
  maxAttempts: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.recoveryMaxAttempts),
  cooldownMs: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.recoveryCooldownMs),
}).strict();

const LocalAiTargetConfigObjectSchema = z.object({
  lifecycle: LocalAiTargetLifecycleSchema,
  location: LocalAiLocationSchema,
  provider: z.enum(['ollama', 'openai-compatible']),
  endpointId: IdSchema,
  baseUrl: LocalAiEndpointUrlSchema,
  expectedModels: z.array(LocalAiExpectedModelSchema).min(1).max(100),
  canary: LocalAiCanarySchema,
  endpointCheckIntervalMs: boundedInteger(
    LOCAL_AI_TARGET_NUMERIC_LIMITS.endpointCheckIntervalMs,
  ),
  freshnessLimitMs: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.freshnessLimitMs),
  warningLatencyMs: boundedInteger(LOCAL_AI_TARGET_NUMERIC_LIMITS.warningLatencyMs),
  routingRoles: z.array(AuxiliaryLlmSlotSchema).max(50),
  fallbackPolicy: LocalAiFallbackPolicySchema,
  slotFallbackPolicies: z.partialRecord(AuxiliaryLlmSlotSchema, LocalAiFallbackPolicySchema),
  confirmAboveInputTokens: boundedInteger(
    LOCAL_AI_TARGET_NUMERIC_LIMITS.confirmAboveInputTokens,
  ).optional(),
  dailyFallbackBudgetUsd: boundedNumber(
    LOCAL_AI_TARGET_NUMERIC_LIMITS.fallbackBudgetUsd,
  ).optional(),
  incidentFallbackBudgetUsd: boundedNumber(
    LOCAL_AI_TARGET_NUMERIC_LIMITS.fallbackBudgetUsd,
  ).optional(),
  recovery: LocalAiRecoverySchema,
}).strict();

function requireEnrolledRoutingRole(
  target: { lifecycle?: string; routingRoles?: unknown[] },
  context: z.core.$RefinementCtx,
): void {
  if (target.lifecycle === 'enrolled' && target.routingRoles?.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['routingRoles'],
      message: 'Enrolled Local AI targets require at least one routing role',
    });
  }
}

export const LocalAiTargetConfigSchema = LocalAiTargetConfigObjectSchema
  .superRefine(requireEnrolledRoutingRole)
  .superRefine(requireValidTargetModelRelationships);

export const LocalAiTargetPatchSchema = LocalAiTargetConfigObjectSchema
  .omit({ location: true, provider: true, endpointId: true })
  .partial()
  .strict()
  .superRefine(requireValidTargetModelRelationships);

export const LocalAiTargetSchema = LocalAiTargetConfigObjectSchema.extend({
  id: IdSchema,
  label: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  pausedUntil: TimestampSchema.optional(),
  retiredAt: TimestampSchema.optional(),
}).strict()
  .superRefine(requireEnrolledRoutingRole)
  .superRefine(requireValidTargetModelRelationships);

export const LocalAiEndpointIdentitySchema = z.object({
  location: LocalAiLocationSchema,
  provider: z.enum(['ollama', 'openai-compatible']),
  endpointId: IdSchema,
  baseUrl: LocalAiEndpointUrlSchema,
}).strict();

export const LocalAiDiscoveredEndpointSchema = z.object({
  identity: LocalAiEndpointIdentitySchema,
  label: IdSchema,
  models: z.array(IdSchema).max(AUXILIARY_DISCOVERY_MAX_MODELS),
  healthy: z.boolean(),
  enrolledTargetId: IdSchema.optional(),
}).strict();

export const LocalAiDiscoveredEndpointsSchema = z.array(LocalAiDiscoveredEndpointSchema)
  .max(AUXILIARY_DISCOVERY_MAX_CANDIDATES);

const LocalAiEvidenceTextSchema = z.string().trim().min(1).max(MAX_EVIDENCE_TEXT_LENGTH);
const LocalAiEvidenceValueSchema = z.union([
  LocalAiEvidenceTextSchema,
  z.number().finite(),
  z.boolean(),
  z.array(LocalAiEvidenceTextSchema).max(MAX_EVIDENCE_ARRAY_LENGTH),
]);

export const LocalAiProbeEvidenceSchema = z.object({
  workerConnected: LocalAiEvidenceValueSchema.optional(),
  workerLatencyMs: LocalAiEvidenceValueSchema.optional(),
  workerLastSeenAt: LocalAiEvidenceValueSchema.optional(),
  rpcReachable: LocalAiEvidenceValueSchema.optional(),
  endpointReachable: LocalAiEvidenceValueSchema.optional(),
  endpointVersion: LocalAiEvidenceValueSchema.optional(),
  endpointProtocol: LocalAiEvidenceValueSchema.optional(),
  httpStatus: LocalAiEvidenceValueSchema.optional(),
  advertisedModels: LocalAiEvidenceValueSchema.optional(),
  loadedModels: LocalAiEvidenceValueSchema.optional(),
  missingModels: LocalAiEvidenceValueSchema.optional(),
  insufficientContextModels: LocalAiEvidenceValueSchema.optional(),
  requiredModelCount: LocalAiEvidenceValueSchema.optional(),
  availableContextLength: LocalAiEvidenceValueSchema.optional(),
  canaryOutputValid: LocalAiEvidenceValueSchema.optional(),
  canaryLatencyMs: LocalAiEvidenceValueSchema.optional(),
  checkDeferred: LocalAiEvidenceValueSchema.optional(),
  deferredReason: LocalAiEvidenceValueSchema.optional(),
  errorKind: LocalAiEvidenceValueSchema.optional(),
  retryAfterMs: LocalAiEvidenceValueSchema.optional(),
}).strict().superRefine((evidence, context) => {
  const byteLength = new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
  if (byteLength > MAX_EVIDENCE_SERIALIZED_BYTES) {
    context.addIssue({
      code: 'custom',
      message: `Local AI probe evidence must not exceed ${MAX_EVIDENCE_SERIALIZED_BYTES} serialized bytes`,
    });
  }
});

export const LocalAiProbeResultSchema = z.object({
  targetId: IdSchema,
  layer: LocalAiHealthLayerSchema,
  checkType: z.enum(['lightweight', 'functional']),
  ok: z.boolean(),
  required: z.boolean(),
  affectedRoles: z.array(AuxiliaryLlmSlotSchema).max(50),
  checkedAt: TimestampSchema,
  durationMs: CountSchema,
  failureCode: LocalAiFailureCodeSchema.optional(),
  message: z.string().trim().min(1).max(4_000).optional(),
  evidence: LocalAiProbeEvidenceSchema,
}).strict();

export const LocalAiProbeResultsSchema = z.array(LocalAiProbeResultSchema).max(10);

export const LocalAiHealthSampleSchema = LocalAiProbeResultSchema.extend({
  id: IdSchema,
  origin: z.enum(['scheduler', 'pre-route', 'manual', 'recovery']),
}).strict();

const LocalAiLayerResultsSchema = z.object({
  worker: LocalAiProbeResultSchema.optional(),
  endpoint: LocalAiProbeResultSchema.optional(),
  model: LocalAiProbeResultSchema.optional(),
  inference: LocalAiProbeResultSchema.optional(),
  effectiveness: LocalAiProbeResultSchema.optional(),
}).strict();

export const LocalAiTargetStatusSchema = z.object({
  targetId: IdSchema,
  lifecycle: LocalAiTargetLifecycleSchema.optional(),
  state: LocalAiHealthStateSchema,
  routableRoles: z.array(AuxiliaryLlmSlotSchema).max(50),
  layers: LocalAiLayerResultsSchema,
  consecutiveFailures: CountSchema,
  consecutiveSuccesses: CountSchema,
  flapping: z.boolean(),
  checkedAt: TimestampSchema,
  recoveryState: z.enum(['healthy', 'degraded', 'unavailable']).optional(),
  incidentOpen: z.boolean().optional(),
  stateTransitions: z.array(z.object({
    state: LocalAiHealthStateSchema,
    at: TimestampSchema,
  }).strict()).max(MAX_HEALTH_STATE_TRANSITIONS).optional(),
}).strict();

export const LocalAiHealthTransitionSchema = z.object({
  previous: LocalAiTargetStatusSchema.optional(),
  current: LocalAiTargetStatusSchema,
  incidentAction: z.enum(['none', 'open', 'update', 'resolve']),
}).strict();

export const LocalAiAggregateStatusSchema = z.object({
  state: z.union([LocalAiHealthStateSchema, z.literal('not-configured')]),
  enrolled: CountSchema,
  healthy: CountSchema,
  degraded: CountSchema,
  unavailable: CountSchema,
  paused: CountSchema,
}).strict();

export const LocalAiIncidentSchema = z.object({
  id: IdSchema,
  targetId: IdSchema,
  state: z.enum(['open', 'acknowledged', 'resolved']),
  severity: z.enum(['warning', 'critical']),
  failureCode: LocalAiFailureCodeSchema,
  affectedLayers: z.array(LocalAiHealthLayerSchema).max(10),
  affectedRoles: z.array(AuxiliaryLlmSlotSchema).max(50),
  openedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.optional(),
  resolvedAt: TimestampSchema.optional(),
  fallbackCount: CountSchema,
  knownCostUsd: CostSchema,
  estimatedCostUsd: CostSchema,
  unpricedDispatchCount: CountSchema,
}).strict();

export const LocalAiIncidentMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open-or-update'), incident: LocalAiIncidentSchema }).strict(),
  z.object({ kind: z.literal('acknowledge'), incidentId: IdSchema, at: TimestampSchema }).strict(),
  z.object({ kind: z.literal('resolve'), incidentId: IdSchema, at: TimestampSchema }).strict(),
]);

export const LocalAiIncidentQuerySchema = z.object({
  targetId: IdSchema.optional(),
  state: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  since: TimestampSchema.optional(),
  limit: z.number().int().min(1).max(1_000),
}).strict();

export const LocalAiRoutingEventSchema = z.object({
  id: IdSchema,
  targetId: IdSchema.optional(),
  incidentId: IdSchema.optional(),
  slot: AuxiliaryLlmSlotSchema,
  intendedRoute: z.literal('local'),
  actualRoute: z.enum(['local', 'frontier', 'deferred', 'blocked']),
  policy: LocalAiFallbackPolicySchema,
  disposition: LocalAiFallbackDispositionSchema,
  decisionReason: LocalAiRoutingDecisionReasonSchema,
  provider: IdSchema.optional(),
  model: IdSchema.optional(),
  inputTokens: CountSchema,
  outputTokens: CountSchema,
  knownCostUsd: CostSchema.optional(),
  estimatedCostUsd: CostSchema.optional(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
}).strict();

export const LocalAiRoutingEventPatchSchema = LocalAiRoutingEventSchema.pick({
  actualRoute: true,
  disposition: true,
  provider: true,
  model: true,
  inputTokens: true,
  outputTokens: true,
  knownCostUsd: true,
  estimatedCostUsd: true,
  completedAt: true,
}).partial().strict();

export const LocalAiFallbackRequestSchema = z.object({
  id: IdSchema,
  routingEventId: IdSchema,
  incidentId: IdSchema.optional(),
  slot: AuxiliaryLlmSlotSchema,
  status: z.enum(['pending', 'allowed', 'deferred', 'blocked', 'expired']),
  estimatedInputTokens: CountSchema,
  estimatedCostUsd: CostSchema.optional(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
  resolution: z.enum(['allow-once', 'allow-incident', 'defer', 'block']).optional(),
}).strict();

export const LocalAiFallbackRequestInputSchema = LocalAiFallbackRequestSchema
  .omit({ id: true, status: true, createdAt: true, resolvedAt: true, resolution: true })
  .strict();
export const LocalAiFallbackResolutionSchema = z.enum(['allow-once', 'allow-incident', 'defer', 'block']);
export const LocalAiPendingFallbackRequestsSchema = z.array(LocalAiFallbackRequestSchema)
  .max(1_000);

export const LocalAiDiagnosticReportSchema = z.object({
  targetId: IdSchema,
  checkedAt: TimestampSchema,
  samples: z.array(LocalAiProbeResultSchema),
  recommendedActions: z.array(LocalAiRepairActionSchema),
}).strict();

export const LocalAiPublicDiagnosticReportSchema = LocalAiDiagnosticReportSchema.extend({
  samples: LocalAiProbeResultsSchema,
  recommendedActions: z.array(LocalAiRepairActionSchema).max(10),
}).strict();

export const LocalAiRepairOutcomeSchema = z.enum([
  'guided',
  'unsupported',
  'not-attempted',
  'execution-failed',
  'completed-not-recovered',
  'recovered',
]);

export const LocalAiRepairResultSchema = z.object({
  targetId: IdSchema,
  action: LocalAiRepairActionSchema,
  outcome: LocalAiRepairOutcomeSchema,
  supported: z.boolean(),
  attempted: z.boolean(),
  recovered: z.boolean(),
  message: z.string().trim().min(1).max(4_000),
  completedAt: TimestampSchema,
}).strict().superRefine((result, context) => {
  const coherent =
    (result.outcome === 'guided' && result.supported && !result.attempted && !result.recovered)
    || (
      result.outcome === 'unsupported'
      && !result.supported
      && !result.attempted
      && !result.recovered
    )
    || (
      result.outcome === 'not-attempted'
      && result.supported
      && !result.attempted
      && !result.recovered
    )
    || (
      result.outcome === 'execution-failed'
      && result.supported
      && result.attempted
      && !result.recovered
    )
    || (
      result.outcome === 'completed-not-recovered'
      && result.supported
      && result.attempted
      && !result.recovered
    )
    || (
      result.outcome === 'recovered'
      && result.supported
      && result.attempted
      && result.recovered
    );
  if (!coherent) {
    context.addIssue({
      code: 'custom',
      path: ['outcome'],
      message: 'Local AI repair outcome is inconsistent with execution flags',
    });
  }
});

export const LocalAiEffectivenessSummarySchema = z.object({
  window: z.enum(['24h', '7d', '30d']),
  localTasks: CountSchema,
  localTokens: CountSchema,
  proposedFallbacks: CountSchema,
  allowedFallbacks: CountSchema,
  deferredFallbacks: CountSchema,
  blockedFallbacks: CountSchema,
  knownCostUsd: CostSchema,
  estimatedCostUsd: CostSchema,
  // LT-193: backward-compat default for daily-aggregate JSON blobs persisted
  // before this field existed.
  unpricedDispatchCount: CountSchema.default(0),
  avoidedEstimatedTokens: CountSchema,
  avoidedEstimatedCostUsd: CostSchema,
  byTarget: z.record(z.string(), CountSchema),
  byModel: z.record(z.string(), CountSchema),
  bySlot: z.partialRecord(AuxiliaryLlmSlotSchema, CountSchema),
  byIncident: z.record(z.string(), CountSchema),
}).strict();

const LocalAiPublicSummaryBreakdownSchema = z.record(IdSchema, CountSchema)
  .superRefine((breakdown, context) => {
    if (Object.keys(breakdown).length > MAX_SUMMARY_BREAKDOWN_ENTRIES) {
      context.addIssue({
        code: 'custom',
        message: `Local AI summary breakdowns must not exceed ${MAX_SUMMARY_BREAKDOWN_ENTRIES} entries`,
      });
    }
  });

export const LocalAiPublicEffectivenessSummarySchema = LocalAiEffectivenessSummarySchema.extend({
  byTarget: LocalAiPublicSummaryBreakdownSchema,
  byModel: LocalAiPublicSummaryBreakdownSchema,
  byIncident: LocalAiPublicSummaryBreakdownSchema,
}).strict();

export const LocalAiRetentionReportSchema = z.object({
  samplesDeleted: CountSchema,
  routingEventsDeleted: CountSchema,
  daysAggregated: CountSchema,
}).strict();

export const LocalAiLocalRouteVerdictSchema = z.object({
  eligible: z.boolean(),
  targetId: IdSchema.optional(),
  status: LocalAiTargetStatusSchema.optional(),
  reason: z.string().trim().min(1).max(4_000),
}).strict();

export const LocalAiFallbackVerdictSchema = z.object({
  allowed: z.boolean(),
  disposition: LocalAiFallbackDispositionSchema,
  policy: LocalAiFallbackPolicySchema,
  routingEventId: IdSchema,
  fallbackRequestId: IdSchema.optional(),
}).strict();

export const LocalAiRevisionCursorSchema = z.string()
  .max(LOCAL_AI_REVISION_CURSOR_MAX_DIGITS)
  .regex(/^(?:0|[1-9]\d*)$/);

export const LocalAiPublicRecoveryAttemptSchema = z.object({
  id: IdSchema,
  targetId: IdSchema,
  action: LocalAiRepairActionSchema,
  attemptNumber: CountSchema,
  claimedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  outcome: z.enum(['claimed', 'unsupported', 'failed', 'not-recovered', 'recovered']),
  supported: z.boolean().optional(),
  attempted: z.boolean().optional(),
  recovered: z.boolean().optional(),
}).strict();

export const LocalAiGuardSnapshotSchema = z.object({
  revision: LocalAiRevisionCursorSchema,
  aggregate: LocalAiAggregateStatusSchema,
  targets: z.array(LocalAiTargetStatusSchema).max(1_000),
  targetConfigs: z.array(LocalAiTargetSchema).max(1_000),
  incidents: z.array(LocalAiIncidentSchema).max(100),
  recoveryAttempts: z.array(LocalAiPublicRecoveryAttemptSchema).max(1_000),
  pendingFallbacks: z.array(LocalAiFallbackRequestSchema).max(1_000),
}).strict();

export const LocalAiEmptyRequestSchema = z.undefined();

export const LocalAiTargetCreateRequestSchema = z.object({
  config: LocalAiTargetConfigSchema,
}).strict();

export const LocalAiTargetUpdateRequestSchema = z.object({
  targetId: IdSchema,
  patch: LocalAiTargetPatchSchema,
}).strict();

export const LocalAiTargetLifecycleRequestSchema = z.object({
  targetId: IdSchema,
  lifecycle: z.enum(['enrolled', 'paused', 'retired']),
  pausedUntil: TimestampSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.lifecycle !== 'paused' && request.pausedUntil !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['pausedUntil'],
      message: 'A pause deadline is valid only for a paused Local AI target',
    });
  }
});

export const LocalAiValidateRequestSchema = z.object({
  config: LocalAiTargetConfigSchema,
}).strict();

export const LocalAiRecheckRequestSchema = z.object({
  targetId: IdSchema,
  kind: z.enum(['lightweight', 'functional']),
}).strict();

export const LocalAiIncidentAcknowledgeRequestSchema = z.object({
  incidentId: IdSchema,
}).strict();

export const LocalAiTargetRequestSchema = z.object({
  targetId: IdSchema,
}).strict();

export const LocalAiRepairRequestSchema = LocalAiTargetRequestSchema.extend({
  action: LocalAiRepairActionSchema,
  mode: z.enum(['guided', 'automatic']),
}).strict();

export const LocalAiSummaryRequestSchema = z.object({
  window: z.enum(['24h', '7d', '30d']),
}).strict();

export const LocalAiFallbackResolveRequestSchema = z.object({
  requestId: IdSchema,
  resolution: LocalAiFallbackResolutionSchema,
}).strict();
