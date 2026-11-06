/**
 * Native model-catalog limit reader for OpenCode spawns.
 *
 * The private configuration probe (`debug config` / `api GET /api/config`)
 * returns configuration *overrides* only: a built-in model with no explicit
 * `limit` override projects no window even though the native model catalog
 * knows its context window and output cap. The catalog is the source of truth
 * on the machine that spawns — version 1 `models <provider> --verbose`, or
 * version 2 standalone `GET /api/model` (the same reads
 * `opencode-region-model-metadata` uses). The CLI merges
 * `OPENCODE_CONFIG_CONTENT` model `limit` overrides into that listing, so
 * reads run with those overrides stripped (`configContentWithoutModelLimits`):
 * a session ceiling is never read — or cached — as a native window. Limits are
 * numeric model metadata only; nothing here retains credentials or native
 * configuration values.
 *
 * Caller holds the OpenCode startup gate. Never acquire it again here.
 */

import { createHash } from 'node:crypto';
import { runOpenCodeCapture } from './opencode-effective-budget-config';
import {
  parseOpenCodeModelMetadataBlocks,
  type OpenCodeModelMetadataBlock,
} from './opencode-account-provider-config';
import { parseOpenCodeV2ModelMetadata } from '../../providers/opencode-v2-model-metadata';

/** Positive catalog limits only; a missing or non-positive field is left out. */
export interface OpenCodeNativeModelLimits {
  context?: number;
  output?: number;
}

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Rewrite an `OPENCODE_CONFIG_CONTENT` overlay without any model-level `limit`
 * override (both the OpenCode 1 `provider` tree and the OpenCode 2 `providers`
 * tree). The CLI merges those overrides into `models --verbose` /
 * `GET /api/model`, so a session whose overlay carries a ceiling would report
 * the ceiling as the model's native window (and it would then be cached as
 * one). Providers and models stay present — the CLI refuses to list a provider
 * that is not enabled — and every other field is kept. Unparseable or
 * non-object content is returned unchanged.
 */
export function configContentWithoutModelLimits(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return content;
    const config = { ...parsed };
    for (const key of ['provider', 'providers'] as const) {
      const raw = config[key];
      if (!isRecord(raw)) continue;
      const root: Record<string, unknown> = {};
      for (const [providerId, providerRaw] of Object.entries(raw)) {
        const provider = isRecord(providerRaw) ? providerRaw : undefined;
        const models = provider?.['models'];
        if (!provider || !isRecord(models)) { root[providerId] = providerRaw; continue; }
        const stripped: Record<string, unknown> = {};
        for (const [modelId, entryRaw] of Object.entries(models)) {
          if (!isRecord(entryRaw)) { stripped[modelId] = entryRaw; continue; }
          const entry = { ...entryRaw };
          delete entry['limit'];
          stripped[modelId] = entry;
        }
        root[providerId] = { ...provider, models: stripped };
      }
      config[key] = root;
    }
    return JSON.stringify(config);
  } catch {
    return content;
  }
}

/**
 * Pure extraction over parsed catalog blocks: the model's positive `context`
 * and `output` limits, or undefined when the catalog does not list the model.
 * A listed model with no positive limits resolves to an empty object (a real
 * answer of "no usable limits"), which callers must treat as unexpressable.
 */
export function limitsFromModelMetadata(
  blocks: readonly OpenCodeModelMetadataBlock[],
  model: string,
): OpenCodeNativeModelLimits | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;
  const providerId = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const block = blocks.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
  if (!block) return undefined;
  const raw = block.metadata['limit'];
  const limit = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { context: positive(limit['context']), output: positive(limit['output']) };
}

// Model windows are catalog facts that do not change mid-run; cache successful
// resolutions (including "listed without usable limits") per install, folder,
// model and limit-stripped overlay. The overlay is part of the key because it
// enables providers and models the CLI will or will not list, and the folder
// because on-disk project configuration varies per working directory; the
// session's own `limit` overrides are stripped before every read (see
// `configContentWithoutModelLimits`), so a ceiling can never enter the cache as
// a native window. A failed or empty read is not cached, so a transient failure
// retries on the next spawn instead of silencing the ceiling for the rest of
// the run.
const cache = new Map<string, OpenCodeNativeModelLimits>();

/**
 * Resolve one `provider/model`'s native catalog limits. Fail-soft: returns
 * undefined when the catalog cannot be read or does not list the model, and
 * never throws or leaks native output into diagnostics. The read runs without
 * the session overlay's model `limit` overrides — the CLI merges them into the
 * listing, so reading through them would report (and cache) a session ceiling
 * as the model's native window. Caller holds the OpenCode startup gate (reads
 * go out like the configuration probes).
 */
export async function readOpenCodeNativeModelLimits(params: {
  command: string;
  cliMajor: number;
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  writableRoots?: readonly string[];
  model: string;
}): Promise<OpenCodeNativeModelLimits | undefined> {
  const slash = params.model.indexOf('/');
  if (slash <= 0) return undefined;
  const providerId = params.model.slice(0, slash);
  const overlay = configContentWithoutModelLimits(params.env['OPENCODE_CONFIG_CONTENT']);
  const readEnv: NodeJS.ProcessEnv = overlay === params.env['OPENCODE_CONFIG_CONTENT']
    ? params.env
    : { ...params.env, OPENCODE_CONFIG_CONTENT: overlay };
  const cacheKey = `${params.cliMajor}|${params.command}|${params.workingDirectory}|${params.model}|${createHash('sha256').update(overlay ?? '').digest('hex').slice(0, 16)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const args = params.cliMajor >= 2
    ? ['api', '--standalone', 'GET', '/api/model']
    : ['models', providerId, '--verbose'];
  let blocks: OpenCodeModelMetadataBlock[];
  try {
    const captured = await runOpenCodeCapture({
      command: params.command,
      args,
      workingDirectory: params.workingDirectory,
      env: readEnv,
      writableRoots: params.writableRoots,
    });
    if (captured.code !== 0) return undefined;
    blocks = params.cliMajor >= 2
      ? parseOpenCodeV2ModelMetadata(captured.stdout)
      : parseOpenCodeModelMetadataBlocks(captured.stdout);
  } catch {
    return undefined;
  }
  const limits = limitsFromModelMetadata(blocks, params.model);
  if (limits) cache.set(cacheKey, limits);
  return limits;
}

export function _resetOpenCodeNativeModelLimitsForTesting(): void {
  cache.clear();
}
