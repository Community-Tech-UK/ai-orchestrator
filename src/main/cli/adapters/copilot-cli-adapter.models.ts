/**
 * Copilot CLI Adapter — model catalog and helper utilities.
 * Extracted from copilot-cli-adapter.ts to keep the main file under the
 * size ceiling. Pure functions + constants; no class dependency.
 */

import { COPILOT_MODELS } from '../../../shared/types/provider.types';
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
 * Default Copilot models (used as fallback when CLI runtime model listing
 * isn't reachable). This list mirrors the current stable `copilot help config`
 * output, with an explicit `auto` entry added because Copilot CLI accepts
 * `--model auto` even though `help config` does not list it.
 */
export const COPILOT_DEFAULT_MODELS: CopilotModelInfo[] = [
  COPILOT_MODELS.GEMINI_3_1_PRO,
  COPILOT_MODELS.CLAUDE_SONNET_46,
  COPILOT_MODELS.CLAUDE_SONNET_45,
  COPILOT_MODELS.CLAUDE_HAIKU_45,
  COPILOT_MODELS.CLAUDE_OPUS_47,
  COPILOT_MODELS.CLAUDE_SONNET_4,
  COPILOT_MODELS.GPT55,
  COPILOT_MODELS.GPT53_CODEX,
  COPILOT_MODELS.GPT52_CODEX,
  COPILOT_MODELS.GPT52,
  COPILOT_MODELS.GPT55_MINI,
  COPILOT_MODELS.GPT5_MINI,
  COPILOT_MODELS.GPT41,
  COPILOT_MODELS.GEMINI_3_PRO,
  COPILOT_MODELS.GEMINI_3_FLASH,
  COPILOT_MODELS.GEMINI_25_PRO,
  COPILOT_MODELS.GEMINI_25_FLASH,
  COPILOT_MODELS.AUTO,
].map(toCopilotModelInfo);
