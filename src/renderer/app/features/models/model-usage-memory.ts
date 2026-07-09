import type { ModelUsageEntry } from '../../../../shared/types/settings.types';

/** Max keys retained in `AppSettings.modelUsageByKey`. */
export const MODEL_USAGE_MAX_ENTRIES = 50;

/** Recency boost decays from this value to 0 over ~this many days. */
export const MODEL_USAGE_RECENCY_WINDOW_DAYS = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function modelUsageKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Hybrid score: selection count plus a decaying recency boost
 * (`max(0, windowDays - daysSinceLastUse)`).
 */
export function modelUsageScore(
  entry: ModelUsageEntry | undefined,
  nowMs: number = Date.now(),
): number {
  if (!entry || entry.count <= 0) return 0;
  const daysSince = Math.max(0, (nowMs - entry.lastUsedAt) / MS_PER_DAY);
  const recencyBoost = Math.max(0, MODEL_USAGE_RECENCY_WINDOW_DAYS - daysSince);
  return entry.count + recencyBoost;
}

/**
 * Compare two usage keys for descending hybrid rank. Ties break on
 * `lastUsedAt`, then stable catalog index (caller supplies).
 */
export function compareModelUsageKeys(
  aKey: string,
  bKey: string,
  usageByKey: Record<string, ModelUsageEntry>,
  catalogIndex: (key: string) => number,
  nowMs: number = Date.now(),
): number {
  const aEntry = usageByKey[aKey];
  const bEntry = usageByKey[bKey];
  const scoreDiff = modelUsageScore(bEntry, nowMs) - modelUsageScore(aEntry, nowMs);
  if (scoreDiff !== 0) return scoreDiff;

  const aLast = aEntry?.lastUsedAt ?? 0;
  const bLast = bEntry?.lastUsedAt ?? 0;
  if (bLast !== aLast) return bLast - aLast;

  return catalogIndex(aKey) - catalogIndex(bKey);
}

/**
 * Increment usage for a key and trim to `MODEL_USAGE_MAX_ENTRIES` by lowest score.
 */
export function recordModelUsage(
  usageByKey: Record<string, ModelUsageEntry>,
  key: string,
  nowMs: number = Date.now(),
): Record<string, ModelUsageEntry> {
  if (!key.includes(':')) return usageByKey;

  const previous = usageByKey[key];
  const next: Record<string, ModelUsageEntry> = {
    ...usageByKey,
    [key]: {
      count: (previous?.count ?? 0) + 1,
      lastUsedAt: nowMs,
    },
  };

  return trimModelUsage(next, nowMs);
}

function trimModelUsage(
  usageByKey: Record<string, ModelUsageEntry>,
  nowMs: number,
): Record<string, ModelUsageEntry> {
  const entries = Object.entries(usageByKey);
  if (entries.length <= MODEL_USAGE_MAX_ENTRIES) return usageByKey;

  entries.sort((a, b) => {
    const scoreDiff = modelUsageScore(b[1], nowMs) - modelUsageScore(a[1], nowMs);
    if (scoreDiff !== 0) return scoreDiff;
    return b[1].lastUsedAt - a[1].lastUsedAt;
  });

  return Object.fromEntries(entries.slice(0, MODEL_USAGE_MAX_ENTRIES));
}

export function isModelUsageByKey(value: unknown): value is Record<string, ModelUsageEntry> {
  if (!value || typeof value !== 'object') return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate['count'] !== 'number' || !Number.isFinite(candidate['count'])) {
      return false;
    }
    if (typeof candidate['lastUsedAt'] !== 'number' || !Number.isFinite(candidate['lastUsedAt'])) {
      return false;
    }
  }
  return true;
}

/**
 * Order picker rows for a provider tab: used models (score > 0) first by
 * hybrid rank, then unused models in catalog order.
 */
export function orderProviderRowsByUsage<T extends { key: string }>(
  rows: T[],
  usageByKey: Record<string, ModelUsageEntry>,
  nowMs: number = Date.now(),
): T[] {
  const catalogIndex = new Map(rows.map((row, index) => [row.key, index]));
  return [...rows].sort((a, b) =>
    compareModelUsageKeys(
      a.key,
      b.key,
      usageByKey,
      (key) => catalogIndex.get(key) ?? Number.MAX_SAFE_INTEGER,
      nowMs,
    ),
  );
}

/**
 * Order Favorites: explicit favorite keys first (caller order), then
 * non-favorite rows with usage score > 0 ranked by hybrid score.
 */
export function orderFavoriteRowsByUsage<T extends { key: string }>(
  allRows: T[],
  favoriteKeys: string[],
  usageByKey: Record<string, ModelUsageEntry>,
  nowMs: number = Date.now(),
): T[] {
  const byKey = new Map(allRows.map((row) => [row.key, row]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  for (const key of favoriteKeys) {
    const row = byKey.get(key);
    if (!row || seen.has(key)) continue;
    ordered.push(row);
    seen.add(key);
  }

  const usedExtras = allRows
    .filter((row) => !seen.has(row.key) && modelUsageScore(usageByKey[row.key], nowMs) > 0)
    .sort((a, b) =>
      compareModelUsageKeys(
        a.key,
        b.key,
        usageByKey,
        (key) => allRows.findIndex((row) => row.key === key),
        nowMs,
      ),
    );

  for (const row of usedExtras) {
    ordered.push(row);
    seen.add(row.key);
  }

  return ordered;
}
