/**
 * Copilot CLI Adapter — model catalog and helper utilities.
 * Extracted from copilot-cli-adapter.ts to keep the main file under the
 * size ceiling. Pure functions + constants; no class dependency.
 */

import {
  COPILOT_MODELS,
  PROVIDER_MODEL_LIST,
  type ModelDisplayInfo,
} from '../../../shared/types/provider.types';
import { COPILOT_AUTO_MODEL_ID, type CopilotModelInfo } from './copilot-cli-adapter.types';

/** Default context window when we don't know the model. Matches the old SDK adapter. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export const COPILOT_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatCopilotModelDisplayName(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return modelId;
  }

  if (normalized === COPILOT_AUTO_MODEL_ID) {
    return 'Auto';
  }

  if (normalized === 'o3') {
    return 'OpenAI o3';
  }

  const parts = normalized.split('-');
  if (parts.length === 0) {
    return modelId;
  }

  if (parts[0] === 'gpt' && parts[1]) {
    const [, version, ...rest] = parts;
    return [`GPT-${version}`, ...rest.map(toTitleCase)].join(' ');
  }

  return parts
    .map((part, index) => {
      if (index > 0 && /^\d/.test(part)) {
        return part;
      }
      return toTitleCase(part);
    })
    .join(' ');
}

export function estimateCopilotModelContextWindow(modelId: string): number {
  const normalized = modelId.trim().toLowerCase();
  if (
    normalized.includes(COPILOT_MODELS.CLAUDE_SONNET_46)
    || normalized.includes(COPILOT_MODELS.CLAUDE_OPUS_46)
    || normalized.includes(COPILOT_MODELS.CLAUDE_OPUS_47)
  ) {
    return 1_000_000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

export function normalizedCopilotVisionModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === COPILOT_AUTO_MODEL_ID
    || normalized.startsWith('claude-')
    || normalized.startsWith('gpt-')
    || normalized.startsWith('gemini-')
    || normalized === 'o3'
    || normalized.startsWith('grok-')
    || normalized.startsWith('goldeneye')
    || normalized.startsWith('raptor');
}

/** Classify a Copilot model id into a tier for picker display. */
export function classifyCopilotModelTier(modelId: string): 'fast' | 'balanced' | 'powerful' {
  const id = modelId.toLowerCase();
  if (
    id.includes('mini')
    || id.includes('lite')
    || id.includes('haiku')
    || id.includes('flash')
    || id.includes('luna')
  ) {
    return 'fast';
  }
  if (
    id.includes('opus')
    || id.includes('astra')
    || id.includes('-sol')
    || id.includes('fable')
    || id.includes('grok')
    || id === 'o3'
    || id === 'o1'
    || id.includes('-pro')
  ) {
    return 'powerful';
  }
  return 'balanced';
}

/** Group a Copilot model under a family for the picker's Other versions submenu. */
export function classifyCopilotModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id === COPILOT_AUTO_MODEL_ID) return 'Auto';
  if (id.startsWith('claude') || id.includes('opus') || id.includes('sonnet') || id.includes('fable')) {
    return 'Claude';
  }
  if (id.includes('codex')) return 'Codex';
  if (id.startsWith('gpt')) return 'GPT';
  if (id.startsWith('gemini')) return 'Gemini';
  if (id.startsWith('grok')) return 'Grok';
  if (id.startsWith('kimi')) return 'Kimi';
  if (id.startsWith('mai') || id.startsWith('raptor')) return 'GitHub';
  return 'Other';
}

export function copilotModelInfosToDisplayInfo(models: CopilotModelInfo[]): ModelDisplayInfo[] {
  return models
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      id: model.id,
      name: model.name,
      tier: classifyCopilotModelTier(model.id),
      family: classifyCopilotModelFamily(model.id),
    }));
}

export function toCopilotModelInfo(modelId: string): CopilotModelInfo {
  return {
    id: modelId,
    name: formatCopilotModelDisplayName(modelId),
    supportsVision: normalizedCopilotVisionModel(modelId),
    contextWindow: estimateCopilotModelContextWindow(modelId),
    enabled: true,
  };
}

export function ensureCopilotAutoModel(models: CopilotModelInfo[]): CopilotModelInfo[] {
  if (models.some(model => model.id === COPILOT_AUTO_MODEL_ID)) {
    return models;
  }

  return [toCopilotModelInfo(COPILOT_AUTO_MODEL_ID), ...models];
}

export function parseCopilotModelIdsFromHelpConfig(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const modelIds: string[] = [];
  let inModelSection = false;

  for (const line of lines) {
    if (!inModelSection) {
      if (/^\s*`model`:\s+AI model to use for Copilot CLI/i.test(line)) {
        inModelSection = true;
      }
      continue;
    }

    if (/^\s*`[^`]+`:/i.test(line)) {
      break;
    }

    const match = line.match(/^\s*-\s+"([^"]+)"\s*$/);
    if (match?.[1]) {
      modelIds.push(match[1]);
    }
  }

  return [...new Set(modelIds)];
}

/**
 * Preserve CLI order, then append static-only ids (e.g. `gpt-6-astra`) that
 * Copilot serves but `help config` omits. Dedupes by normalised id.
 */
export function unionCopilotModelIds(
  discoveredIds: readonly string[],
  extraIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...discoveredIds, ...extraIds]) {
    const id = raw.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

export function staticCopilotModelIds(): string[] {
  return (PROVIDER_MODEL_LIST['copilot'] ?? []).map((model) => model.id);
}

/** Live help-config ids plus static omissions, with `auto` guaranteed present. */
export function completeCopilotDiscoveredModels(discoveredIds: readonly string[]): CopilotModelInfo[] {
  return ensureCopilotAutoModel(
    unionCopilotModelIds(discoveredIds, staticCopilotModelIds()).map(toCopilotModelInfo),
  );
}

export function withCopilotModelListFallback(
  discovery: Promise<CopilotModelInfo[]>,
  fallbackToStatic: boolean,
  onFallback?: (error: unknown) => void,
): Promise<CopilotModelInfo[]> {
  return discovery.catch((error: unknown) => {
    if (!fallbackToStatic) {
      throw error;
    }
    onFallback?.(error);
    return COPILOT_DEFAULT_MODELS;
  });
}

/**
 * Default Copilot models (used as fallback when CLI runtime model listing
 * isn't reachable). Mirrors `PROVIDER_MODEL_LIST.copilot`, including `auto`
 * and ids the CLI serves but does not list in `help config`.
 */
export const COPILOT_DEFAULT_MODELS: CopilotModelInfo[] = completeCopilotDiscoveredModels([]);
