import type { AuxiliaryLlmSlot } from './auxiliary-llm.types';

export const LOCAL_AI_TARGET_NUMERIC_LIMITS = {
  endpointCheckIntervalMs: { min: 30_000, max: 900_000 },
  canaryIntervalMs: { min: 120_000, max: 3_600_000 },
  canaryTimeoutMs: { min: 5_000, max: 120_000 },
  freshnessLimitMs: { min: 30_000, max: 900_000 },
  warningLatencyMs: { min: 100, max: 60_000 },
  recoveryMaxAttempts: { min: 1, max: 5 },
  recoveryCooldownMs: { min: 60_000, max: 3_600_000 },
  minContextLength: { min: 1, max: 100_000_000 },
  confirmAboveInputTokens: { min: 0, max: 100_000_000 },
  fallbackBudgetUsd: { min: 0, max: 1_000_000 },
} as const;

export type LocalAiTargetLifecycle = 'unmanaged' | 'enrolled' | 'paused' | 'retired';
export type LocalAiHealthState = 'checking' | 'healthy' | 'degraded' | 'unavailable' | 'paused';
export type LocalAiHealthLayer = 'worker' | 'endpoint' | 'model' | 'inference' | 'effectiveness';
export type LocalAiFallbackPolicy =
  | 'allow-silently'
  | 'notify-and-allow'
  | 'require-confirmation'
  | 'defer-locally'
  | 'block-paid-fallback';
export type LocalAiFailureCode =
  | 'worker-offline'
  | 'worker-degraded'
  | 'rpc-unavailable'
  | 'endpoint-not-advertised'
  | 'configuration-drift'
  | 'connection-refused'
  | 'endpoint-timeout'
  | 'protocol-error'
  | 'authentication-error'
  | 'missing-required-model'
  | 'insufficient-context'
  | 'inference-timeout'
  | 'malformed-inference-output'
  | 'latency-exceeded'
  | 'flapping'
  | 'monitor-error';
export type LocalAiRepairAction =
  | 'recheck-layer'
  | 'deep-check'
  | 'validate-models'
  | 'reconnect-worker'
  | 'restart-ollama';
export type LocalAiFallbackDisposition =
  | 'not-needed'
  | 'allowed'
  | 'pending-confirmation'
  | 'deferred'
  | 'blocked';
export type LocalAiRoutingDecisionReason =
  | 'health'
  | 'policy'
  | 'daily-budget'
  | 'incident-budget'
  | 'confirmation';

export type LocalAiProbeEvidenceKey =
  | 'workerConnected'
  | 'workerLatencyMs'
  | 'workerLastSeenAt'
  | 'rpcReachable'
  | 'endpointReachable'
  | 'endpointVersion'
  | 'endpointProtocol'
  | 'httpStatus'
  | 'advertisedModels'
  | 'loadedModels'
  | 'missingModels'
  | 'requiredModelCount'
  | 'availableContextLength'
  | 'canaryOutputValid'
  | 'canaryLatencyMs'
  | 'checkDeferred'
  | 'deferredReason'
  | 'errorKind'
  | 'retryAfterMs';
export type LocalAiProbeEvidenceValue = string | number | boolean | string[];
export type LocalAiProbeEvidence = Partial<Record<LocalAiProbeEvidenceKey, LocalAiProbeEvidenceValue>>;

export interface LocalAiTargetConfig {
  lifecycle: LocalAiTargetLifecycle;
  location: { type: 'coordinator' } | { type: 'worker'; nodeId: string };
  provider: 'ollama' | 'openai-compatible';
  endpointId: string;
  baseUrl: string;
  expectedModels: { modelId: string; required: boolean; minContextLength?: number }[];
  canary: { model: string; timeoutMs: number; intervalMs: number };
  endpointCheckIntervalMs: number;
  freshnessLimitMs: number;
  warningLatencyMs: number;
  routingRoles: AuxiliaryLlmSlot[];
  fallbackPolicy: LocalAiFallbackPolicy;
  slotFallbackPolicies: Partial<Record<AuxiliaryLlmSlot, LocalAiFallbackPolicy>>;
  confirmAboveInputTokens?: number;
  dailyFallbackBudgetUsd?: number;
  incidentFallbackBudgetUsd?: number;
  recovery: { automatic: boolean; maxAttempts: number; cooldownMs: number };
}

export function localAiWorkerEndpointId(
  provider: LocalAiTargetConfig['provider'],
): LocalAiTargetConfig['provider'] {
  switch (provider) {
    case 'ollama':
      return 'ollama';
    case 'openai-compatible':
      return 'openai-compatible';
    default:
      throw new Error(`Unsupported Local AI provider: ${String(provider)}`);
  }
}

export type LocalAiTargetPatch = Partial<Omit<LocalAiTargetConfig, 'location' | 'provider' | 'endpointId'>>;

export interface LocalAiTarget extends LocalAiTargetConfig {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  pausedUntil?: number;
  retiredAt?: number;
}

export interface LocalAiEndpointIdentity {
  location: LocalAiTargetConfig['location'];
  provider: LocalAiTargetConfig['provider'];
  endpointId: string;
  baseUrl: string;
}

export interface LocalAiProbeResult {
  targetId: string;
  layer: LocalAiHealthLayer;
  checkType: 'lightweight' | 'functional';
  ok: boolean;
  required: boolean;
  affectedRoles: AuxiliaryLlmSlot[];
  checkedAt: number;
  durationMs: number;
  failureCode?: LocalAiFailureCode;
  message?: string;
  evidence: LocalAiProbeEvidence;
}

export type LocalAiHealthSample = LocalAiProbeResult & {
  id: string;
  origin: 'scheduler' | 'pre-route' | 'manual' | 'recovery';
};

export interface LocalAiStateTransitionEvidence {
  state: LocalAiHealthState;
  at: number;
}

export type LocalAiRecoveryState = 'healthy' | 'degraded' | 'unavailable';

export interface LocalAiTargetStatus {
  targetId: string;
  /** Optional for persisted compatibility; the health engine always emits it. */
  lifecycle?: LocalAiTargetLifecycle;
  state: LocalAiHealthState;
  routableRoles: AuxiliaryLlmSlot[];
  layers: Partial<Record<LocalAiHealthLayer, LocalAiProbeResult>>;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  flapping: boolean;
  checkedAt: number;
  /** Recovery/incident context survives neutral checking and paused states. */
  recoveryState?: LocalAiRecoveryState;
  incidentOpen?: boolean;
  /** Bounded evidence used by the pure health reducer to detect recent flapping. */
  stateTransitions?: LocalAiStateTransitionEvidence[];
}

export interface LocalAiHealthTransition {
  previous?: LocalAiTargetStatus;
  current: LocalAiTargetStatus;
  incidentAction: 'none' | 'open' | 'update' | 'resolve';
}

export interface LocalAiAggregateStatus {
  state: LocalAiHealthState | 'not-configured';
  enrolled: number;
  healthy: number;
  degraded: number;
  unavailable: number;
  paused: number;
}

export interface LocalAiIncident {
  id: string;
  targetId: string;
  state: 'open' | 'acknowledged' | 'resolved';
  severity: 'warning' | 'critical';
  failureCode: LocalAiFailureCode;
  affectedLayers: LocalAiHealthLayer[];
  affectedRoles: AuxiliaryLlmSlot[];
  openedAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  fallbackCount: number;
  knownCostUsd: number;
  estimatedCostUsd: number;
}

export type LocalAiIncidentMutation =
  | { kind: 'open-or-update'; incident: LocalAiIncident }
  | { kind: 'acknowledge'; incidentId: string; at: number }
  | { kind: 'resolve'; incidentId: string; at: number };

export interface LocalAiIncidentQuery {
  targetId?: string;
  state?: LocalAiIncident['state'];
  since?: number;
  limit: number;
}

export interface LocalAiRoutingEvent {
  id: string;
  targetId?: string;
  incidentId?: string;
  slot: AuxiliaryLlmSlot;
  intendedRoute: 'local';
  actualRoute: 'local' | 'frontier' | 'deferred' | 'blocked';
  policy: LocalAiFallbackPolicy;
  disposition: LocalAiFallbackDisposition;
  decisionReason: LocalAiRoutingDecisionReason;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd?: number;
  estimatedCostUsd?: number;
  createdAt: number;
  completedAt?: number;
}

export type LocalAiRoutingEventPatch = Partial<
  Pick<LocalAiRoutingEvent, 'actualRoute' | 'disposition' | 'provider' | 'model' | 'inputTokens' | 'outputTokens' | 'knownCostUsd' | 'estimatedCostUsd' | 'completedAt'>
>;

export interface LocalAiFallbackRequest {
  id: string;
  routingEventId: string;
  incidentId?: string;
  slot: AuxiliaryLlmSlot;
  status: 'pending' | 'allowed' | 'deferred' | 'blocked' | 'expired';
  estimatedInputTokens: number;
  estimatedCostUsd?: number;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolution?: 'allow-once' | 'allow-incident' | 'defer' | 'block';
}

export type LocalAiFallbackRequestInput = Omit<
  LocalAiFallbackRequest,
  'id' | 'status' | 'createdAt' | 'resolvedAt' | 'resolution'
>;
export type LocalAiFallbackResolution = NonNullable<LocalAiFallbackRequest['resolution']>;

export interface LocalAiDiagnosticReport {
  targetId: string;
  checkedAt: number;
  samples: LocalAiProbeResult[];
  recommendedActions: LocalAiRepairAction[];
}

export interface LocalAiRepairResult {
  targetId: string;
  action: LocalAiRepairAction;
  outcome: LocalAiRepairOutcome;
  supported: boolean;
  attempted: boolean;
  recovered: boolean;
  message: string;
  completedAt: number;
}

export type LocalAiRepairOutcome =
  | 'guided'
  | 'unsupported'
  | 'not-attempted'
  | 'execution-failed'
  | 'completed-not-recovered'
  | 'recovered';

export interface LocalAiEffectivenessSummary {
  window: '24h' | '7d' | '30d';
  localTasks: number;
  localTokens: number;
  proposedFallbacks: number;
  allowedFallbacks: number;
  deferredFallbacks: number;
  blockedFallbacks: number;
  knownCostUsd: number;
  estimatedCostUsd: number;
  avoidedEstimatedTokens: number;
  avoidedEstimatedCostUsd: number;
  byTarget: Record<string, number>;
  byModel: Record<string, number>;
  bySlot: Partial<Record<AuxiliaryLlmSlot, number>>;
  byIncident: Record<string, number>;
}

export interface LocalAiRetentionReport {
  samplesDeleted: number;
  routingEventsDeleted: number;
  daysAggregated: number;
}

export interface LocalAiLocalRouteVerdict {
  eligible: boolean;
  targetId?: string;
  status?: LocalAiTargetStatus;
  reason: string;
}

export interface LocalAiFallbackVerdict {
  allowed: boolean;
  disposition: LocalAiFallbackDisposition;
  policy: LocalAiFallbackPolicy;
  routingEventId: string;
  fallbackRequestId?: string;
}

/**
 * Canonical base-10 cursor serialized across IPC. The wire schema applies a
 * 512-digit payload bound; the runtime counter itself remains an unbounded
 * bigint, making transport exhaustion unreachable in practical operation.
 */
export type LocalAiRevisionCursor = string;
export const LOCAL_AI_REVISION_CURSOR_MAX_DIGITS = 512;

const LOCAL_AI_REVISION_CURSOR_PATTERN = /^(?:0|[1-9]\d*)$/;

export function parseLocalAiRevisionCursor(cursor: LocalAiRevisionCursor): bigint {
  if (!LOCAL_AI_REVISION_CURSOR_PATTERN.test(cursor)) {
    throw new Error('Invalid Local AI revision cursor');
  }
  return BigInt(cursor);
}

export function incrementLocalAiRevisionCursor(
  cursor: LocalAiRevisionCursor,
): LocalAiRevisionCursor {
  return (parseLocalAiRevisionCursor(cursor) + 1n).toString();
}

export function compareLocalAiRevisionCursors(
  left: LocalAiRevisionCursor,
  right: LocalAiRevisionCursor,
): number {
  parseLocalAiRevisionCursor(left);
  parseLocalAiRevisionCursor(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export interface LocalAiGuardSnapshot {
  /** Main-process monotonic cursor used to order snapshots and status deltas. */
  revision: LocalAiRevisionCursor;
  aggregate: LocalAiAggregateStatus;
  targets: LocalAiTargetStatus[];
  /** Strict public target records required to edit safely after a renderer restart. */
  targetConfigs: LocalAiTarget[];
  incidents: LocalAiIncident[];
  /** Durable, bounded recovery history projected without raw messages or errors. */
  recoveryAttempts: LocalAiPublicRecoveryAttempt[];
  pendingFallbacks: LocalAiFallbackRequest[];
}

export interface LocalAiPublicRecoveryAttempt {
  id: string;
  targetId: string;
  action: LocalAiRepairAction;
  attemptNumber: number;
  claimedAt: number;
  completedAt?: number;
  outcome: 'claimed' | 'unsupported' | 'failed' | 'not-recovered' | 'recovered';
  supported?: boolean;
  attempted?: boolean;
  recovered?: boolean;
}

/** Non-secret endpoint metadata surfaced by setup discovery. */
export interface LocalAiDiscoveredEndpoint {
  identity: LocalAiEndpointIdentity;
  label: string;
  models: string[];
  healthy: boolean;
  enrolledTargetId?: string;
}

export interface LocalAiTargetCreateRequest {
  config: LocalAiTargetConfig;
}

export interface LocalAiTargetUpdateRequest {
  targetId: string;
  patch: LocalAiTargetPatch;
}

export interface LocalAiTargetLifecycleRequest {
  targetId: string;
  lifecycle: 'enrolled' | 'paused' | 'retired';
  pausedUntil?: number;
}

export type LocalAiTargetLifecycleOptions = Pick<
  LocalAiTargetLifecycleRequest,
  'pausedUntil'
>;

export interface LocalAiValidateRequest {
  config: LocalAiTargetConfig;
}

export interface LocalAiRecheckRequest {
  targetId: string;
  kind: 'lightweight' | 'functional';
}

export interface LocalAiIncidentAcknowledgeRequest {
  incidentId: string;
}

export interface LocalAiTargetRequest {
  targetId: string;
}

export interface LocalAiRepairRequest extends LocalAiTargetRequest {
  action: LocalAiRepairAction;
  mode: 'guided' | 'automatic';
}

export interface LocalAiSummaryRequest {
  window: LocalAiEffectivenessSummary['window'];
}

export interface LocalAiFallbackResolveRequest {
  requestId: string;
  resolution: LocalAiFallbackResolution;
}
