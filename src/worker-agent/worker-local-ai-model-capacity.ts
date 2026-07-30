import type { AuxiliaryLlmSlot } from '../shared/types/auxiliary-llm.types';
import type { LocalAiExpectedModel } from '../shared/types/local-ai-guard.types';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../shared/types/local-ai-guard.types';

const MAX_CONTEXT_ROWS = 512;
const MAX_MODEL_ID_LENGTH = 256;

export interface LocalAiModelCapacityMetadata {
  loadedModels: string[];
  contextLengths: ReadonlyMap<string, number>;
}

export interface LocalAiModelCapacityFailure {
  insufficientModels: LocalAiExpectedModel[];
  affectedRoles: AuxiliaryLlmSlot[];
  required: boolean;
  availableContextLength?: number;
}

export function parseLocalAiModelCapacity(
  provider: 'ollama' | 'openai-compatible',
  data: unknown,
  relevantModelIds: ReadonlySet<string>,
): LocalAiModelCapacityMetadata {
  const rows = provider === 'ollama'
    ? (data as { models?: unknown } | null)?.models
    : (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || rows.length > MAX_CONTEXT_ROWS) {
    throw new Error('Local AI context metadata was malformed');
  }

  const loadedModels: string[] = [];
  const contextLengths = new Map<string, number>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (provider === 'openai-compatible' && row['state'] !== 'loaded') continue;
    const modelId = provider === 'ollama'
      ? readModelId(row['name']) ?? readModelId(row['model'])
      : readModelId(row['id']);
    if (!modelId) continue;
    loadedModels.push(modelId);
    if (!relevantModelIds.has(modelId)) continue;
    const contextLength = provider === 'ollama'
      ? readOptionalContextLength(row, ['context_length'])
      : readOptionalContextLength(row, ['loaded_context_length', 'context_length']);
    if (contextLength !== undefined) {
      const existing = contextLengths.get(modelId);
      contextLengths.set(modelId, existing === undefined
        ? contextLength
        : Math.min(existing, contextLength));
    }
  }

  return {
    loadedModels: [...new Set(loadedModels)],
    contextLengths,
  };
}

export function evaluateLocalAiModelCapacity(
  expectedModels: readonly LocalAiExpectedModel[],
  metadata: LocalAiModelCapacityMetadata,
  canaryModel: string,
): LocalAiModelCapacityFailure {
  const insufficientModels = expectedModels.filter((expected) => {
    if (expected.minContextLength === undefined) return false;
    const actual = metadata.contextLengths.get(expected.modelId);
    return actual !== undefined && actual < expected.minContextLength;
  });
  const affectedRoles = [...new Set(insufficientModels.flatMap((model) =>
    model.routingRoles ?? []))];
  const observed = expectedModels.flatMap((expected) => {
    if (expected.minContextLength === undefined) return [];
    const actual = metadata.contextLengths.get(expected.modelId);
    return actual === undefined ? [] : [actual];
  });

  return {
    insufficientModels,
    affectedRoles,
    required: insufficientModels.some((model) =>
      model.required || model.modelId === canaryModel),
    ...(observed.length > 0 ? { availableContextLength: Math.min(...observed) } : {}),
  };
}

export function affectedRolesForExpectedModels(
  models: readonly LocalAiExpectedModel[],
): AuxiliaryLlmSlot[] {
  return [...new Set(models.flatMap((model) => model.routingRoles ?? []))];
}

function readModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL_ID_LENGTH
    ? value
    : undefined;
}

function readContextLength(value: unknown): number | undefined {
  const { min, max } = LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength;
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? value as number
    : undefined;
}

function readOptionalContextLength(
  row: Record<string, unknown>,
  fieldNames: readonly string[],
): number | undefined {
  for (const fieldName of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(row, fieldName)) continue;
    const contextLength = readContextLength(row[fieldName]);
    if (contextLength === undefined) {
      throw new Error('Local AI context metadata was malformed');
    }
    return contextLength;
  }
  return undefined;
}
