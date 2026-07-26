import type { AuxiliaryLlmSlot } from './auxiliary-llm.types';

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
  supported: boolean;
  attempted: boolean;
  recovered: boolean;
  message: string;
  completedAt: number;
}

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

export interface LocalAiGuardSnapshot {
  aggregate: LocalAiAggregateStatus;
  targets: LocalAiTargetStatus[];
  incidents: LocalAiIncident[];
  pendingFallbacks: LocalAiFallbackRequest[];
}
