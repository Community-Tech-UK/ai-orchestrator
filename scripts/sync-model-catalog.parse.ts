/**
 * models.dev registry parsing for `sync-model-catalog.ts`.
 *
 * Split out of the script so it can be unit-tested: the script calls `main()`
 * at module scope (fetching models.dev and rewriting the generated snapshot),
 * so it cannot be imported from a spec.
 *
 * Mirrors `ModelsDevService.parseModel` in the app runtime, kept self-contained
 * so this build-time path has no app-runtime import chain.
 */

/**
 * Provider namespaces (as keyed by models.dev) for the CLIs this app supports.
 * Cursor and Ollama have no models.dev pricing namespace we consume here
 * (Cursor is discovered live; Ollama is local/free). `xai` backs the Grok CLI —
 * see `normalizeModelsDevProviderNamespace`, which maps it onto `grok`.
 *
 * ORDER IS SIGNIFICANT: primary vendors first, resellers (`github-copilot`)
 * last. See the duplicate-id note on {@link parseSnapshot}.
 */
export const SUPPORTED_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'github-copilot',
] as const;

export interface SnapshotEntry {
  provider: string;
  input: number;
  output: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Compare two generated snapshots by their persisted fields. */
export function diffSnapshots(
  current: Readonly<Record<string, SnapshotEntry>>,
  next: Readonly<Record<string, SnapshotEntry>>,
): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const ids = new Set([...Object.keys(current), ...Object.keys(next)]);

  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const hasBefore = Object.prototype.hasOwnProperty.call(current, id);
    const hasAfter = Object.prototype.hasOwnProperty.call(next, id);
    const before = hasBefore ? current[id] : undefined;
    const after = hasAfter ? next[id] : undefined;
    if (!hasBefore && hasAfter) {
      added.push(id);
    } else if (hasBefore && !hasAfter) {
      removed.push(id);
    } else if (before && after && !snapshotEntriesEqual(before, after)) {
      changed.push(id);
    }
  }

  return { added, removed, changed };
}

/** Human-readable drift details suitable for CI logs and issue summaries. */
export function formatSnapshotDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  if (diff.added.length > 0) lines.push(`Added (${diff.added.length}): ${diff.added.join(', ')}`);
  if (diff.removed.length > 0) lines.push(`Removed (${diff.removed.length}): ${diff.removed.join(', ')}`);
  if (diff.changed.length > 0) lines.push(`Changed (${diff.changed.length}): ${diff.changed.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : 'No model changes.';
}

function snapshotEntriesEqual(left: SnapshotEntry, right: SnapshotEntry): boolean {
  return left.provider === right.provider
    && left.input === right.input
    && left.output === right.output
    && left.contextWindow === right.contextWindow
    && left.maxOutputTokens === right.maxOutputTokens;
}

/**
 * Parse models.dev `api.json` into a snapshot map keyed by bare model id. Only
 * priced models in SUPPORTED_PROVIDERS are kept; anything missing a finite
 * input/output cost is skipped.
 *
 * Duplicate ids: resellers republish primary-vendor ids verbatim
 * (`github-copilot` carries `gpt-5.2-codex`, and has carried `claude-opus-5`,
 * `grok-4.6`, ...). Because the map is keyed by bare id, exactly one provider
 * can own each id. Walking models.dev's own key order made that winner depend
 * on however the upstream JSON happened to be ordered on the day — which
 * silently reattributed 23 primary-vendor models to `github-copilot` between
 * two regenerations, taking their context/output limits with them. So iterate
 * SUPPORTED_PROVIDERS in order, first claim wins, resellers last.
 */
export function parseSnapshot(raw: string): Record<string, SnapshotEntry> | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;

  const out = new Map<string, SnapshotEntry>();

  for (const providerKey of SUPPORTED_PROVIDERS) {
    const provider = (root as Record<string, unknown>)[providerKey];
    if (!provider || typeof provider !== 'object') continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== 'object') continue;

    const modelValues = Array.isArray(models)
      ? (models as unknown[])
      : Object.values(models as Record<string, unknown>);

    for (const model of modelValues) {
      const entry = parseModel(model, providerKey);
      if (entry && !out.has(entry.id)) out.set(entry.id, entry.snapshot);
    }
  }
  return Object.fromEntries(out);
}

export function parseModel(
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
