/**
 * Cursor CLI Adapter — model catalog and helper utilities.
 *
 * Extracted from cursor-cli-adapter.ts (which is already near its size ceiling)
 * to keep the parser, classifiers, and fallback list as pure functions with no
 * class dependency. Mirrors the structure of copilot-cli-adapter.models.ts.
 *
 * `cursor-agent --list-models` prints a plain-text block (one model per line as
 * `<id> - <Display Name>`, e.g. `gpt-5.3-codex - Codex 5.3 (current)`), wrapped
 * by an `Available models` header and a trailing `Tip: …` line. Note that
 * `--output-format json` is IGNORED for this subcommand, so the output must be
 * line-parsed rather than JSON-parsed.
 */

import type { ChildProcess } from 'child_process';
import {
  PROVIDER_MODEL_LIST,
  type ModelDisplayInfo,
} from '../../../shared/types/provider.types';

/** How long a discovered Cursor model list is cached before re-querying the CLI. */
export const CURSOR_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

/** The `auto` sentinel id that lets Cursor pick a model from the subscription. */
export const CURSOR_AUTO_MODEL_ID = 'auto';

/**
 * Curated static fallback list, used when the CLI isn't reachable / parseable.
 * Single source of truth lives in `PROVIDER_MODEL_LIST.cursor` so the renderer's
 * static picker and the main-process fallback never drift apart.
 */
export const CURSOR_DEFAULT_MODELS: ModelDisplayInfo[] = PROVIDER_MODEL_LIST['cursor'] ?? [];

/** A raw `<id> - <name>` pair parsed from the CLI output. */
export interface CursorModelListEntry {
  id: string;
  name: string;
}

/**
 * Classify a Cursor model id into a coarse tier for display / `resolveModelForTier`.
 * Heuristic and approximate — Cursor encodes reasoning effort and speed variants
 * directly into the id (e.g. `gpt-5.3-codex-high-fast`), so we key off substrings.
 */
export function classifyCursorModelTier(modelId: string): 'fast' | 'balanced' | 'powerful' {
  const id = modelId.toLowerCase();
  // Hyphenated forms for mini/nano/lite/spark so we don't match substrings of
  // unrelated ids (e.g. "geMINI" contains "mini"). flash/haiku are collision-free.
  if (
    id.includes('flash') ||
    id.includes('haiku') ||
    id.includes('-mini') ||
    id.includes('-nano') ||
    id.includes('-lite') ||
    id.includes('-spark')
  ) {
    return 'fast';
  }
  if (
    id.includes('opus') ||
    id.includes('grok') ||
    id.includes('-pro') ||
    id.includes('max') ||
    id.includes('xhigh')
  ) {
    return 'powerful';
  }
  return 'balanced';
}

/**
 * Group a Cursor model under a family for the picker's "Other versions" submenu.
 * Order matters: Codex ids start with `gpt-` too, so the codex check must run
 * before the generic GPT check.
 */
export function classifyCursorModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id === CURSOR_AUTO_MODEL_ID) return 'Auto';
  if (id.startsWith('composer')) return 'Composer';
  if (id.includes('codex')) return 'Codex';
  if (id.startsWith('claude') || id.includes('opus') || id.includes('sonnet')) return 'Claude';
  if (id.startsWith('gpt')) return 'GPT';
  if (id.startsWith('gemini')) return 'Gemini';
  if (id.startsWith('grok')) return 'Grok';
  if (id.startsWith('kimi')) return 'Kimi';
  return 'Other';
}

/**
 * Parse the plain-text output of `cursor-agent --list-models`.
 *
 * Accepts lines shaped like `id - Display Name`, skips the `Available models`
 * header, blank lines, and the trailing `Tip: …` hint, and strips the
 * `(current)` / `(default)` status suffix from display names. De-duplicates by id.
 */
export function parseCursorModelList(output: string): CursorModelListEntry[] {
  const entries: CursorModelListEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // `id` is a single whitespace-free token; then ` - `; then the display name.
    const match = line.match(/^([A-Za-z0-9][\w.-]*)\s+-\s+(.+)$/);
    if (!match) continue;

    const id = match[1];
    const name = match[2].replace(/\s*\((?:current|default)\)\s*$/i, '').trim();
    if (!name || seen.has(id)) continue;

    seen.add(id);
    entries.push({ id, name });
  }

  return entries;
}

/** Convert a parsed entry into the picker's `ModelDisplayInfo` shape. */
export function toCursorModelDisplayInfo(entry: CursorModelListEntry): ModelDisplayInfo {
  return {
    id: entry.id,
    name: entry.name,
    tier: classifyCursorModelTier(entry.id),
    family: classifyCursorModelFamily(entry.id),
    pinned: entry.id === CURSOR_AUTO_MODEL_ID ? true : undefined,
  };
}

/**
 * Guarantee an `auto` entry exists and sits first (Cursor's CLI does list it
 * first, but a future CLI build might drop it from the listing while still
 * accepting `--model auto`).
 */
export function ensureCursorAutoModel(models: ModelDisplayInfo[]): ModelDisplayInfo[] {
  if (models.some((model) => model.id === CURSOR_AUTO_MODEL_ID)) {
    return models;
  }
  return [
    {
      id: CURSOR_AUTO_MODEL_ID,
      name: 'Auto (let Cursor pick)',
      tier: 'balanced',
      family: 'Auto',
      pinned: true,
    },
    ...models,
  ];
}

// ============ Discovery orchestration ============

// Process-wide cache so repeated picker opens don't re-spawn the CLI.
let cachedCursorModels: ModelDisplayInfo[] | null = null;
let cachedCursorModelsAt = 0;
let cursorModelDiscoveryPromise: Promise<ModelDisplayInfo[]> | null = null;

/**
 * Run `cursor-agent --list-models` (via the injected `spawn` thunk), parse the
 * output, and cache it. Pure with respect to logging/fallback — REJECTS on
 * failure so the caller can decide how to degrade (the adapter logs + returns
 * the static list). `spawn` is injected so this stays unit-testable without the
 * BaseCliAdapter machinery.
 */
export function discoverCursorModels(spawn: () => ChildProcess): Promise<ModelDisplayInfo[]> {
  const now = Date.now();
  if (cachedCursorModels && now - cachedCursorModelsAt < CURSOR_MODEL_DISCOVERY_CACHE_TTL_MS) {
    return Promise.resolve(cachedCursorModels);
  }
  if (cursorModelDiscoveryPromise) {
    return cursorModelDiscoveryPromise;
  }

  cursorModelDiscoveryPromise = new Promise<ModelDisplayInfo[]>((resolve, reject) => {
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
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignored */
      }
      reject(new Error('Timeout fetching Cursor model list'));
    }, 5000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseCursorModelList(output);
      if (parsed.length > 0) {
        const models = ensureCursorAutoModel(parsed.map(toCursorModelDisplayInfo));
        cachedCursorModels = models;
        cachedCursorModelsAt = Date.now();
        resolve(models);
        return;
      }
      reject(
        new Error(
          `Failed to parse Cursor model list (exit ${code}): ${errorOutput.trim() || 'no output'}`,
        ),
      );
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).finally(() => {
    cursorModelDiscoveryPromise = null;
  });

  return cursorModelDiscoveryPromise;
}

/** Test-only reset of the process-wide discovery cache. */
export function _resetCursorModelCacheForTesting(): void {
  cachedCursorModels = null;
  cachedCursorModelsAt = 0;
  cursorModelDiscoveryPromise = null;
}
