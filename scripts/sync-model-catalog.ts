/**
 * sync-model-catalog.ts  (backlog A2 / Phase 3-B)
 *
 * Regenerates the committed offline model-catalog snapshot
 * `src/main/providers/models-dev-snapshot.generated.ts` from the live
 * models.dev registry (https://models.dev/api.json).
 *
 * Why this exists
 * ---------------
 * At runtime `ModelsDevService` fetches models.dev and overlays fresh pricing +
 * context windows onto the committed `MODEL_PRICING` snapshot. But that live
 * overlay is empty until the first successful fetch each launch — and entirely
 * empty when the app runs offline. This script captures a build-time snapshot
 * that `ModelsDevService.loadOfflineSnapshot()` seeds at startup, so pricing and
 * context windows for the providers we support are correct immediately and
 * fully offline. The live fetch then overwrites individual entries when it lands.
 *
 * Scope: only the provider namespaces this app actually drives (Claude/Codex/
 * Gemini/Copilot → anthropic/openai/google/github-copilot). Mirrors the curated
 * "just the useful models" philosophy of generate-cursor-models.ts and keeps the
 * generated file small enough to read in a diff. Extend SUPPORTED_PROVIDERS to
 * widen the offline coverage.
 *
 * Usage:
 *   npm run sync:model-catalog            # regenerate the snapshot in place
 *   tsx scripts/sync-model-catalog.ts --check   # CI: fail if the snapshot drifted
 *
 * `--check` is fail-soft when models.dev is unreachable (exit 0 + notice), so it
 * is safe on offline hosts. It is deliberately NOT wired into `prebuild`:
 * models.dev pricing changes on the order of days, so a hard drift gate would
 * be noisy. Run it manually to refresh the committed snapshot.
 */

import { get as httpsGet } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_FILE = resolve(SCRIPT_DIR, '../src/main/providers/models-dev-snapshot.generated.ts');
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Provider namespaces (as keyed by models.dev) for the CLIs this app supports.
 * Cursor and Ollama have no models.dev pricing namespace we consume here
 * (Cursor is discovered live; Ollama is local/free).
 */
const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'github-copilot'] as const;

interface SnapshotEntry {
  provider: string;
  input: number;
  output: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

function fetchApiJson(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet(MODELS_DEV_API_URL, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        resolve(null);
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Parse models.dev `api.json` into a sorted snapshot map. Mirrors
 * `ModelsDevService.parseModel` (kept self-contained so this build script has
 * no app-runtime import chain). Only priced models in SUPPORTED_PROVIDERS are
 * kept; anything missing finite input/output cost is skipped.
 */
function parseSnapshot(raw: string): Record<string, SnapshotEntry> | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;

  const supported = new Set<string>(SUPPORTED_PROVIDERS);
  const out: Record<string, SnapshotEntry> = {};

  for (const [providerKey, provider] of Object.entries(root as Record<string, unknown>)) {
    if (!supported.has(providerKey)) continue;
    if (!provider || typeof provider !== 'object') continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== 'object') continue;

    const modelValues = Array.isArray(models)
      ? (models as unknown[])
      : Object.values(models as Record<string, unknown>);

    for (const model of modelValues) {
      const entry = parseModel(model, providerKey);
      if (entry) out[entry.id] = entry.snapshot;
    }
  }
  return out;
}

function parseModel(
  model: unknown,
  providerKey: string,
): { id: string; snapshot: SnapshotEntry } | null {
  if (!model || typeof model !== 'object') return null;
  const record = model as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : undefined;
  if (!id) return null;

  const cost = record['cost'];
  if (!cost || typeof cost !== 'object') return null;
  const costRecord = cost as Record<string, unknown>;
  const input = costRecord['input'];
  const output = costRecord['output'];
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;

  const limit = record['limit'];
  const limitRecord = limit && typeof limit === 'object' ? (limit as Record<string, unknown>) : undefined;
  const contextWindow = typeof limitRecord?.['context'] === 'number' ? limitRecord['context'] : undefined;
  const maxOutputTokens = typeof limitRecord?.['output'] === 'number' ? limitRecord['output'] : undefined;

  return {
    id,
    snapshot: { provider: providerKey, input, output, contextWindow, maxOutputTokens },
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderEntry(id: string, e: SnapshotEntry): string {
  const parts = [`provider: '${e.provider}'`, `input: ${e.input}`, `output: ${e.output}`];
  if (e.contextWindow !== undefined) parts.push(`contextWindow: ${e.contextWindow}`);
  if (e.maxOutputTokens !== undefined) parts.push(`maxOutputTokens: ${e.maxOutputTokens}`);
  // Model ids never contain a single quote, so single-quoting is safe and
  // matches the value style / repo lint config (avoids a double-quote warning).
  return `  '${id}': { ${parts.join(', ')} },`;
}

function render(snapshot: Record<string, SnapshotEntry>): string {
  // Deterministic order: provider, then model id, so diffs are stable.
  const ids = Object.keys(snapshot).sort((a, b) => {
    const pa = snapshot[a]!.provider;
    const pb = snapshot[b]!.provider;
    return pa === pb ? a.localeCompare(b) : pa.localeCompare(pb);
  });

  const body = ids.map((id) => renderEntry(id, snapshot[id]!)).join('\n');

  return `/**
 * AUTO-GENERATED by scripts/sync-model-catalog.ts — DO NOT EDIT BY HAND.
 *
 * Offline model-catalog snapshot captured from https://models.dev/api.json for
 * the provider namespaces this app supports (${SUPPORTED_PROVIDERS.join(', ')}).
 * Seeded into ModelsDevService at startup via \`loadOfflineSnapshot()\`; the live
 * fetch overwrites individual entries when it lands. Pricing is USD per 1M
 * tokens; context/output limits are token counts.
 *
 * Regenerate: \`npm run sync:model-catalog\`.
 */

export interface ModelsDevSnapshotEntry {
  /** models.dev provider namespace (e.g. 'anthropic'). */
  provider: string;
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Total context window in tokens, when published. */
  contextWindow?: number;
  /** Max output tokens in one response, when published. */
  maxOutputTokens?: number;
}

export const MODELS_DEV_SNAPSHOT: Record<string, ModelsDevSnapshotEntry> = {
${body}
};

export const MODELS_DEV_SNAPSHOT_META = {
  source: '${MODELS_DEV_API_URL}',
  providerScope: [${SUPPORTED_PROVIDERS.map((p) => `'${p}'`).join(', ')}],
  modelCount: ${ids.length},
} as const;
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  const raw = await fetchApiJson();
  if (!raw) {
    const message = 'models.dev unreachable (offline, timed out, or non-2xx).';
    if (check) {
      console.log(`sync:model-catalog — skipped: ${message}`);
      process.exit(0);
    }
    console.error(`sync:model-catalog — ${message}`);
    process.exit(1);
  }

  const snapshot = parseSnapshot(raw);
  if (!snapshot || Object.keys(snapshot).length === 0) {
    const message = 'models.dev returned no priced models for the supported providers.';
    if (check) {
      console.log(`sync:model-catalog — skipped: ${message}`);
      process.exit(0);
    }
    console.error(`sync:model-catalog — ${message}`);
    process.exit(1);
  }

  const rendered = render(snapshot);

  let current: string | null = null;
  try {
    current = readFileSync(TARGET_FILE, 'utf8');
  } catch {
    current = null;
  }

  if (current === rendered) {
    console.log(`sync:model-catalog — up to date (${Object.keys(snapshot).length} models).`);
    process.exit(0);
  }

  if (check) {
    console.error(
      'sync:model-catalog — DRIFT: the committed offline snapshot is out of date.\n' +
        'Run `npm run sync:model-catalog` to refresh.',
    );
    process.exit(1);
  }

  writeFileSync(TARGET_FILE, rendered);
  console.log(`sync:model-catalog — wrote ${Object.keys(snapshot).length} models to ${TARGET_FILE}`);
}

void main();
