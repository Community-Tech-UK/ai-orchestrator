import { resolveWindowsSpawn } from '../cli/adapters/windows-cli-spawn';
import { openCodeLoginSpawnTarget } from '../../shared/utils/opencode-account-login-command';
/**
 * Per-region MiMo model metadata cache for account-pool spawns.
 *
 * Source of truth: the native model catalog on the machine that spawns:
 * version 1 verbose models, or version 2 standalone `/api/model`. The cache is filled with
 * the existing OpenCode model-discovery refresh and by `ensure…` on demand
 * (e.g. on the worker agent, which runs no discovery). Reads go through
 * `withOpenCodeProcessGate` like every other `opencode` invocation that opens
 * the shared database.
 *
 * Metadata is limits and capability flags only — never credential material.
 */

import { spawn } from 'node:child_process';
import { getLogger } from '../logging/logger';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { selectOpenCodeLaunch } from '../cli/adapters/opencode-cli-launch';
import { parseOpenCodeV2ModelMetadata } from './opencode-v2-model-metadata';
import { captureOpenCodeModelList } from './opencode-model-lister-process';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import {
  parseOpenCodeModelMetadataBlocks,
  type OpenCodeModelMetadataBlock,
} from '../cli/adapters/opencode-account-provider-config';
import { OPENCODE_ACCOUNT_REGIONS, type OpenCodeAccountRegion } from '../../shared/types/provider-account.types';

const logger = getLogger('OpenCodeRegionModelMetadata');


const cache = new Map<OpenCodeAccountRegion, OpenCodeModelMetadataBlock[]>();
const inFlight = new Map<string, Promise<readonly OpenCodeModelMetadataBlock[]>>();
export interface OpenCodeRegionMetadataOptions { requiredMajor?: 1 | 2 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Catalog activation needs no credential and applies only to this helper process. */
function enabledRegionCatalogEnv(env: NodeJS.ProcessEnv, region: OpenCodeAccountRegion): NodeJS.ProcessEnv {
  let config: unknown = {};
  try { config = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] || '{}'); }
  catch { throw new Error('Cannot read region metadata: OpenCode inline configuration is invalid.'); }
  if (!isRecord(config) || config['providers'] !== undefined && !isRecord(config['providers'])) {
    throw new Error('Cannot read region metadata: OpenCode inline configuration is invalid.');
  }
  const providers = config['providers'] ?? {};
  const providerId = `xiaomi-token-plan-${region}`;
  if (!isRecord(providers) || providers[providerId] !== undefined && !isRecord(providers[providerId])) {
    throw new Error('Cannot read region metadata: OpenCode inline configuration is invalid.');
  }
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config,
    providers: { ...providers, [providerId]: { ...providers[providerId], activation: 'enabled' } },
  }) };
}

/** Cached metadata for a region, or null when it has never been read here. */
export function getCachedOpenCodeRegionModelMetadata(
  region: OpenCodeAccountRegion,
): readonly OpenCodeModelMetadataBlock[] | null {
  if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) return null;
  return cache.get(region) ?? null;
}

/** Store metadata blocks (discovery refresh, tests). Only `xiaomi-token-plan-*` rows are kept. */
export function putOpenCodeRegionModelMetadata(
  region: OpenCodeAccountRegion,
  blocks: readonly OpenCodeModelMetadataBlock[],
): void {
  if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) {
    throw new Error('Invalid OpenCode Token Plan region.');
  }
  const kept = blocks.filter((block) => block.providerId === `xiaomi-token-plan-${region}`);
  if (kept.length === 0) return;
  cache.set(region, [...kept]);
}

async function runRegionModelLister(region: OpenCodeAccountRegion, requiredMajor?: 1 | 2): Promise<OpenCodeModelMetadataBlock[]> {
  const selected = await selectOpenCodeLaunch({ workingDirectory: process.cwd(), env: process.env, ...(requiredMajor ? { requiredMajor } : {}) });
  const args = selected.major >= 2 ? ['api', '--standalone', 'GET', '/api/model'] : ['models', `xiaomi-token-plan-${region}`, '--verbose'];
  const options = buildCliSpawnOptions();
  if (selected.major >= 2) options.env = enabledRegionCatalogEnv(options.env ?? process.env, region);
  const target = resolveWindowsSpawn(selected.command, args, Boolean(options.shell), options.env ?? {});
  const fallback = openCodeLoginSpawnTarget(target.command, target.shell ? process.platform : 'posix');
  const { output, code } = await captureOpenCodeModelList(() => spawn(
    fallback.command, target.args,
    { stdio: ['ignore', 'pipe', 'pipe'], ...options, shell: target.shell, detached: target.detached },
  ), {
    timeout: `Timeout reading xiaomi-token-plan-${region} model metadata`,
    process: `Failed reading xiaomi-token-plan-${region} model metadata`,
  });
  const blocks = (selected.major >= 2 ? parseOpenCodeV2ModelMetadata(output) : parseOpenCodeModelMetadataBlocks(output)).filter(
    (block) => block.providerId === `xiaomi-token-plan-${region}`,
  );
  if (blocks.length > 0) return blocks;
  throw new Error(
    `No xiaomi-token-plan-${region} model metadata from \`opencode models\` (exit ${code}). `
    + 'Sign in once with `opencode auth login` for that region on this machine, or use the existing account instead.',
  );
}

/**
 * Read one region's metadata through the process gate and cache it. Rejects
 * when the region provider cannot be listed (fail closed upstream). Concurrent
 * cold callers share one read (the gate serialises them anyway).
 */
export async function readOpenCodeRegionModelMetadata(
  region: OpenCodeAccountRegion,
  options: OpenCodeRegionMetadataOptions = {},
): Promise<readonly OpenCodeModelMetadataBlock[]> {
  if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) {
    throw new Error('Invalid OpenCode Token Plan region.');
  }
  const requiredMajor = options.requiredMajor;
  const key = `${region}:${requiredMajor ?? 'any'}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = withOpenCodeProcessGate(() => runRegionModelLister(region, requiredMajor))
    .then((blocks) => {
      cache.set(region, blocks);
      return blocks;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, run);
  return run;
}

/**
 * Ensure the given regions have cached metadata, reading any that do not.
 * Never rejects for a region: callers consult `getCached…` afterwards and fail
 * closed per account.
 */
export async function ensureOpenCodeRegionModelMetadata(
  regions: Iterable<OpenCodeAccountRegion>,
  options: OpenCodeRegionMetadataOptions = {},
): Promise<void> {
  const requiredMajor = options.requiredMajor;
  for (const region of new Set(regions)) {
    if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) {
      logger.warn('Ignoring invalid OpenCode Token Plan region');
      continue;
    }
    if (cache.has(region)) continue;
    try {
      await readOpenCodeRegionModelMetadata(region, { requiredMajor });
    } catch (error) {
      logger.warn('OpenCode region model metadata unavailable', {
        region,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function _resetOpenCodeRegionModelMetadataForTesting(): void {
  cache.clear();
  inFlight.clear();
}
