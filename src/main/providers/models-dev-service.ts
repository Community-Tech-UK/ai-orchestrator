/**
 * models.dev registry sync.
 *
 * Fetches the cross-provider model registry published at
 * https://models.dev/api.json and feeds its pricing into the shared pricing
 * overlay ({@link registerModelRates}), so cost accounting tracks new models
 * and price changes without code edits. The committed `MODEL_PRICING` snapshot
 * remains the offline fallback: every fetch is fail-soft, so a network error,
 * timeout, non-2xx, oversized body, or schema mismatch simply leaves the
 * snapshot in place — never a startup delay and never a thrown error.
 *
 * This is the runtime half of backlog item #9. The build-time catalog sync
 * (regenerating the committed snapshot from models.dev) is a separate follow-up.
 */

import * as https from 'https';
import { getLogger } from '../logging/logger';
import { registerModelRates, modelRateOverlaySize, type ModelRate } from '../../shared/data/model-pricing';

const logger = getLogger('ModelsDev');

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
/** Refresh at most this often; the registry changes on the order of days. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
/** Fail-soft network timeout — never block startup on a slow registry. */
const REQUEST_TIMEOUT_MS = 6000;
/** Reject absurd payloads defensively (api.json is well under 1 MB today). */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Per-model metadata distilled from the registry. */
export interface ModelsDevEntry {
  id: string;
  rate: ModelRate;
  /** Total context window in tokens, when published. */
  contextWindow?: number;
  /** Max output tokens in one response, when published. */
  maxOutputTokens?: number;
}

interface ParsedRegistry {
  rates: Record<string, ModelRate>;
  contextWindows: Map<string, number>;
}

export class ModelsDevService {
  private ttlMs: number;
  private lastFetchedAt = 0;
  private inflight: Promise<boolean> | null = null;
  private contextWindows = new Map<string, number>();

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Fetch the registry (unless within TTL) and merge its pricing into the
   * shared overlay. Returns true when the overlay was populated this call.
   * Never throws.
   */
  async refresh(force = false): Promise<boolean> {
    if (!force && this.lastFetchedAt > 0 && Date.now() - this.lastFetchedAt < this.ttlMs) {
      return false;
    }
    // Coalesce concurrent callers onto a single in-flight request.
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    let raw: string | null = null;
    try {
      raw = await this.fetchApiJson();
    } catch (error) {
      logger.debug('models.dev fetch failed (using offline snapshot)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (!raw) return false;

    const parsed = this.parseRegistry(raw);
    if (!parsed) return false;

    const count = Object.keys(parsed.rates).length;
    if (count === 0) {
      logger.debug('models.dev returned no priced models; keeping snapshot');
      return false;
    }

    registerModelRates(parsed.rates);
    this.contextWindows = parsed.contextWindows;
    this.lastFetchedAt = Date.now();
    logger.info('models.dev pricing synced', {
      models: count,
      overlaySize: modelRateOverlaySize(),
    });
    return true;
  }

  /** Context window (tokens) for a model from the last successful sync, if any. */
  getContextWindow(modelId: string): number | undefined {
    return this.contextWindows.get(modelId);
  }

  /**
   * Parse models.dev `api.json`. The published shape is
   * `{ [providerId]: { models: { [modelId]: { cost?, limit? } } } }`, where
   * `cost.input`/`cost.output` are USD per 1M tokens and `limit.context`/
   * `limit.output` are token counts. Tolerates a models *array* form and
   * missing fields; anything unparseable is skipped, never thrown.
   */
  parseRegistry(raw: string): ParsedRegistry | null {
    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!root || typeof root !== 'object') return null;

    const rates: Record<string, ModelRate> = {};
    const contextWindows = new Map<string, number>();

    for (const provider of Object.values(root as Record<string, unknown>)) {
      if (!provider || typeof provider !== 'object') continue;
      const models = (provider as { models?: unknown }).models;
      if (!models || typeof models !== 'object') continue;

      const entries = Array.isArray(models)
        ? (models as unknown[])
        : Object.values(models as Record<string, unknown>);

      for (const model of entries) {
        const entry = this.parseModel(model);
        if (!entry) continue;
        rates[entry.id] = entry.rate;
        if (entry.contextWindow !== undefined) {
          contextWindows.set(entry.id, entry.contextWindow);
        }
      }
    }

    return { rates, contextWindows };
  }

  private parseModel(model: unknown): ModelsDevEntry | null {
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
      rate: { input, output },
      contextWindow,
      maxOutputTokens,
    };
  }

  private fetchApiJson(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const req = https.get(MODELS_DEV_API_URL, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume(); // drain
          reject(new Error(`HTTP ${status}`));
          return;
        }

        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('models.dev response exceeded size cap'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('models.dev request timed out'));
      });
      req.on('error', reject);
    });
  }
}

let modelsDevService: ModelsDevService | null = null;

export function getModelsDevService(): ModelsDevService {
  if (!modelsDevService) {
    modelsDevService = new ModelsDevService();
  }
  return modelsDevService;
}

/** Test helper — reset the singleton between specs. */
export function _resetModelsDevServiceForTesting(): void {
  modelsDevService = null;
}
