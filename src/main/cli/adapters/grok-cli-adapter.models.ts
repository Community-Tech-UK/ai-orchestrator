/**
 * Grok CLI — model catalog discovery.
 *
 * Mirrors `cursor-cli-adapter.models.ts`: pure parser + classifier functions
 * plus a spawn-injected discovery helper, with no dependency on the adapter
 * class (Grok rides the generic `AcpCliAdapter`, which has no model-list RPC).
 *
 * `grok models` prints a short plain-text block on stdout and exits 0:
 *
 *     You are logged in with grok.com.
 *
 *     Default model: grok-4.6
 *
 *     Available models:
 *       * grok-4.6 (default)
 *
 * There is no JSON mode for this subcommand, so it must be line-parsed. Only
 * the bulleted rows under `Available models:` are entries — `Default model:`
 * has no bullet and is deliberately not matched.
 */

import type { ChildProcess } from 'child_process';
import {
  MAX_MODEL_ID_LENGTH,
  type ModelDisplayInfo,
} from '../../../shared/types/provider.types';
import { killProcessGroup } from './base-cli-process-utils';

/** How long a discovered Grok model list is cached before re-querying the CLI. */
export const GROK_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

/** Hard cap on a single `grok models` run before it is killed. */
const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/** A raw model row parsed from `grok models`. */
export interface GrokModelListEntry {
  id: string;
  /** True when the CLI marked this row `(default)`. */
  isDefault: boolean;
}

/**
 * Bulleted row: a bullet, the id, then any parenthesised annotations
 * (`(default)`), then optionally a dash-separated description. xAI ids are word
 * chars, dots and dashes only, so the id is a single whitespace-free token.
 *
 * The trailing forms are tolerated because a future CLI build that appends a
 * description would otherwise make every row unparseable at once — discovery
 * would fall silently back to the static list, which is the exact staleness
 * this module exists to prevent. They are still not open-ended: a bulleted
 * prose line (`* Note this is fine`) has neither shape and is rejected, so it
 * cannot become a bogus model id that fails on spawn.
 */
const GROK_MODEL_ROW =
  /^[*\-•]\s+([A-Za-z0-9][\w.-]*)((?:\s*\([^)]*\))*)(?:\s*[-–—]\s+.*)?$/;

/** Classify a Grok model id into a coarse tier for display / `resolveModelForTier`. */
export function classifyGrokModelTier(modelId: string): 'fast' | 'balanced' | 'powerful' {
  const id = modelId.toLowerCase();
  if (id.includes('-mini') || id.includes('-fast') || id.includes('non-reasoning')) {
    return 'fast';
  }
  if (id.includes('-build') || id.includes('build-')) {
    return 'balanced';
  }
  return 'powerful';
}

/** `grok-4.6` → `Grok 4.6`. Falls back to the raw id for unfamiliar shapes. */
export function formatGrokModelName(modelId: string): string {
  const match = modelId.match(/^grok-(.+)$/i);
  if (!match) return modelId;
  return `Grok ${match[1].replace(/-/g, ' ')}`;
}

/** Parse `grok models` stdout into raw entries. Unknown lines are ignored. */
export function parseGrokModelList(output: string): GrokModelListEntry[] {
  const entries = new Map<string, GrokModelListEntry>();

  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.trim().match(GROK_MODEL_ROW);
    if (!match) continue;

    const id = match[1];
    if (id.length > MAX_MODEL_ID_LENGTH) continue;

    const isDefault = /\(\s*default\s*\)/i.test(match[2] ?? '');
    const existing = entries.get(id);
    if (existing) {
      // Keep first-seen order, but never lose a `(default)` marker to a
      // duplicate row — that marker is what decides the pinned entry.
      existing.isDefault ||= isDefault;
      continue;
    }
    entries.set(id, { id, isDefault });
  }

  return [...entries.values()];
}

/**
 * Convert parsed entries into picker rows. The CLI's own default is pinned so
 * it surfaces in the compact picker's "Latest" section; when the CLI marks no
 * default, the first row is pinned so the section is never empty.
 */
export function toGrokModelDisplayInfos(entries: GrokModelListEntry[]): ModelDisplayInfo[] {
  const pinnedIndex = entries.findIndex((entry) => entry.isDefault);
  const effectivePinned = pinnedIndex >= 0 ? pinnedIndex : 0;

  return entries.map((entry, index) => ({
    id: entry.id,
    name: formatGrokModelName(entry.id),
    tier: classifyGrokModelTier(entry.id),
    family: 'Grok',
    ...(index === effectivePinned ? { pinned: true } : {}),
  }));
}

// ============ Discovery orchestration ============

let cachedGrokModels: ModelDisplayInfo[] | null = null;
let cachedGrokModelsAt = 0;
let grokModelDiscoveryPromise: Promise<ModelDisplayInfo[]> | null = null;

/**
 * Run `grok models` (via the injected `spawn` thunk), parse it, and cache the
 * result. REJECTS on failure so the caller decides how to degrade — the
 * discovery service logs and keeps whatever the catalog already had.
 */
export function discoverGrokModels(spawn: () => ChildProcess): Promise<ModelDisplayInfo[]> {
  const now = Date.now();
  if (cachedGrokModels && now - cachedGrokModelsAt < GROK_MODEL_DISCOVERY_CACHE_TTL_MS) {
    return Promise.resolve(cachedGrokModels);
  }
  if (grokModelDiscoveryPromise) {
    return grokModelDiscoveryPromise;
  }

  grokModelDiscoveryPromise = new Promise<ModelDisplayInfo[]>((resolve, reject) => {
    const proc = spawn();
    let output = '';
    let errorOutput = '';

    proc.stdout?.on('data', (data) => {
      output += (data as Buffer).toString();
    });
    proc.stderr?.on('data', (data) => {
      errorOutput += (data as Buffer).toString();
    });

    const timer = setTimeout(() => {
      if (!killProcessGroup(proc.pid, 'SIGTERM')) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
      }
      reject(new Error('Timeout fetching Grok model list'));
    }, GROK_MODEL_DISCOVERY_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // The CLI writes its banner to stdout too, so parse both streams rather
      // than trusting which one carried the list.
      const parsed = parseGrokModelList(`${output}\n${errorOutput}`);
      if (parsed.length > 0) {
        const models = toGrokModelDisplayInfos(parsed);
        cachedGrokModels = models;
        cachedGrokModelsAt = Date.now();
        resolve(models);
        return;
      }
      reject(
        new Error(
          `Failed to parse Grok model list (exit ${code}): ${errorOutput.trim() || output.trim() || 'no output'}`,
        ),
      );
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).finally(() => {
    grokModelDiscoveryPromise = null;
  });

  return grokModelDiscoveryPromise;
}

/** Test-only reset of the process-wide discovery cache. */
export function _resetGrokModelCacheForTesting(): void {
  cachedGrokModels = null;
  cachedGrokModelsAt = 0;
  grokModelDiscoveryPromise = null;
}
