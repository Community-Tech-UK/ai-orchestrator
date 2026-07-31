import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiHealthLayer,
  LocalAiProbeResult,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiProbeResultSchema,
  LocalAiTargetStatusSchema,
} from '../../shared/validation/local-ai-guard.schemas';

const ROLE_ORDER: readonly AuxiliaryLlmSlot[] = [
  'compression',
  'memoryDistillation',
  'webExtract',
  'titleGeneration',
  'routingClassification',
  'approvalScoring',
  'approvalAdjudication',
  'loopScoring',
  'retrievalHypothesis',
  'branchScoring',
  'subQueryExecution',
  'verifyOutputSummary',
];
const ROLE_INDEX = new Map<AuxiliaryLlmSlot, number>(
  ROLE_ORDER.map((role, index) => [role, index]),
);
const LAYER_ORDER: readonly LocalAiHealthLayer[] = [
  'worker',
  'endpoint',
  'model',
  'inference',
  'effectiveness',
];
const MAX_FAILURES = 3;
const MAX_SUCCESSES = 2;

export function selectLayerSamples(
  targetId: string,
  samples: LocalAiProbeResult[],
): LocalAiProbeResult[] {
  const byLayer = new Map<LocalAiHealthLayer, LocalAiProbeResult>();
  for (const raw of samples) {
    const item = parseProbeResult(raw);
    if (!item || item.targetId !== targetId) continue;
    const existing = byLayer.get(item.layer);
    if (!existing || compareProbe(item, existing) > 0) byLayer.set(item.layer, item);
  }
  return LAYER_ORDER.flatMap((layer) => {
    const item = byLayer.get(layer);
    return item ? [item] : [];
  });
}

export function mergeLayers(
  previous: LocalAiTargetStatus['layers'],
  samples: LocalAiProbeResult[],
): LocalAiTargetStatus['layers'] {
  const merged = new Map<LocalAiHealthLayer, LocalAiProbeResult>();
  for (const layer of LAYER_ORDER) {
    const existing = previous[layer];
    if (existing) merged.set(layer, cloneProbe(existing));
  }
  for (const sample of samples) {
    const existing = merged.get(sample.layer);
    if (isMateriallyNewLayerWinner(sample, existing)) {
      merged.set(sample.layer, cloneProbe(sample));
    }
  }
  return Object.fromEntries(LAYER_ORDER.flatMap((layer) => {
    const item = merged.get(layer);
    return item ? [[layer, item]] : [];
  })) as LocalAiTargetStatus['layers'];
}

export function isMateriallyNewLayerWinner(
  incoming: LocalAiProbeResult,
  retained: LocalAiProbeResult | undefined,
): boolean {
  if (!retained) return true;
  if (incoming.checkedAt !== retained.checkedAt) {
    return incoming.checkedAt > retained.checkedAt;
  }
  return stableProbeKey(incoming) !== stableProbeKey(retained);
}

export function probesEqual(
  left: LocalAiProbeResult | undefined,
  right: LocalAiProbeResult,
): boolean {
  return left !== undefined
    && left.checkedAt === right.checkedAt
    && stableProbeKey(left) === stableProbeKey(right);
}

export function parseProbeResult(raw: unknown): LocalAiProbeResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<LocalAiProbeResult>;
  const parsed = LocalAiProbeResultSchema.safeParse({
    targetId: value.targetId,
    layer: value.layer,
    checkType: value.checkType,
    ok: value.ok,
    required: value.required,
    affectedRoles: value.affectedRoles,
    checkedAt: value.checkedAt,
    durationMs: value.durationMs,
    failureCode: value.failureCode,
    message: value.message,
    evidence: value.evidence,
  });
  return parsed.success ? cloneProbe(parsed.data) : undefined;
}

export function validatePreviousStatus(
  targetId: string,
  status: LocalAiTargetStatus | undefined,
): LocalAiTargetStatus | undefined {
  if (!status) return undefined;
  const rawTransitions = Array.isArray(status.stateTransitions)
    ? status.stateTransitions
    : [];
  const parsed = LocalAiTargetStatusSchema.safeParse({
    ...status,
    layers: {},
    stateTransitions: [],
  });
  if (!parsed.success || parsed.data.targetId !== targetId) return undefined;
  const layers = normalizePersistedLayers(targetId, parsed.data.checkedAt, status.layers);
  return {
    ...cloneStatus({ ...parsed.data, layers }),
    stateTransitions: rawTransitions.map((item) => ({ ...item })),
  };
}

export function normalizeRoles(roles: AuxiliaryLlmSlot[]): AuxiliaryLlmSlot[] {
  return [...new Set(roles)].sort((left, right) =>
    (ROLE_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (ROLE_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right));
}

export function newestCheckedAt(samples: LocalAiProbeResult[]): number | undefined {
  const timestamps = samples
    .map((sample) => validTimestamp(sample.checkedAt))
    .filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

export function layerValues(
  layers: LocalAiTargetStatus['layers'],
): LocalAiProbeResult[] {
  return LAYER_ORDER.flatMap((layer) => {
    const item = layers[layer];
    return item ? [item] : [];
  });
}

function compareProbe(left: LocalAiProbeResult, right: LocalAiProbeResult): number {
  if (left.checkedAt !== right.checkedAt) return left.checkedAt - right.checkedAt;
  if (left.ok !== right.ok) return left.ok ? -1 : 1;
  if (left.required !== right.required) return left.required ? 1 : -1;
  if (left.checkType !== right.checkType) return left.checkType === 'functional' ? 1 : -1;
  return stableProbeKey(left).localeCompare(stableProbeKey(right));
}

function stableProbeKey(sample: LocalAiProbeResult): string {
  const evidence = Object.entries(sample.evidence)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]);
  return JSON.stringify([
    sample.targetId,
    sample.layer,
    sample.checkType,
    sample.ok,
    sample.required,
    sample.failureCode ?? '',
    sample.message ?? '',
    sample.durationMs,
    normalizeRoles(sample.affectedRoles),
    evidence,
  ]);
}

function cloneProbe(sample: LocalAiProbeResult): LocalAiProbeResult {
  const evidence = Object.fromEntries(Object.entries(sample.evidence).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value,
  ]));
  return {
    targetId: sample.targetId,
    layer: sample.layer,
    checkType: sample.checkType,
    ok: sample.ok,
    required: sample.required,
    affectedRoles: normalizeRoles(sample.affectedRoles),
    checkedAt: sample.checkedAt,
    durationMs: sample.durationMs,
    ...(sample.failureCode ? { failureCode: sample.failureCode } : {}),
    ...(sample.message ? { message: sample.message } : {}),
    evidence,
  };
}

function cloneStatus(status: LocalAiTargetStatus): LocalAiTargetStatus {
  return {
    targetId: status.targetId,
    ...(status.lifecycle ? { lifecycle: status.lifecycle } : {}),
    state: status.state,
    routableRoles: normalizeRoles(status.routableRoles),
    layers: mergeLayers({}, layerValues(status.layers)),
    consecutiveFailures: Math.min(status.consecutiveFailures, MAX_FAILURES),
    consecutiveSuccesses: Math.min(status.consecutiveSuccesses, MAX_SUCCESSES),
    flapping: status.flapping,
    checkedAt: status.checkedAt,
    ...(status.recoveryState ? { recoveryState: status.recoveryState } : {}),
    ...(status.incidentOpen !== undefined ? { incidentOpen: status.incidentOpen } : {}),
    ...(status.stateTransitions
      ? { stateTransitions: status.stateTransitions.map((item) => ({ ...item })) }
      : {}),
  };
}

function normalizePersistedLayers(
  targetId: string,
  checkedAt: number,
  rawLayers: unknown,
): LocalAiTargetStatus['layers'] {
  if (!rawLayers || typeof rawLayers !== 'object') return {};
  const record = rawLayers as Record<string, unknown>;
  return Object.fromEntries(LAYER_ORDER.flatMap((layer) => {
    const item = parseProbeResult(record[layer]);
    return item
      && item.layer === layer
      && item.targetId === targetId
      && item.checkedAt <= checkedAt
      ? [[layer, item]]
      : [];
  })) as LocalAiTargetStatus['layers'];
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
