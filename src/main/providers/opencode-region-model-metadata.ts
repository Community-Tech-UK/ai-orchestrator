/**
 * Per-region MiMo model metadata cache for account-pool spawns.
 *
 * Source of truth: `opencode models xiaomi-token-plan-<region> --verbose` on
 * the machine that spawns (plan 2026-10-10 Phase 2). The cache is filled with
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
import { PosixSpawnCommandResolver } from '../cli/adapters/posix-spawn-command-resolver';
import { captureOpenCodeModelList } from './opencode-model-lister-process';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import {
  parseOpenCodeModelMetadataBlocks,
  type OpenCodeModelMetadataBlock,
} from '../cli/adapters/opencode-account-provider-config';
import { OPENCODE_ACCOUNT_REGIONS, type OpenCodeAccountRegion } from '../../shared/types/provider-account.types';

const logger = getLogger('OpenCodeRegionModelMetadata');


const cache = new Map<OpenCodeAccountRegion, OpenCodeModelMetadataBlock[]>();
const inFlight = new Map<OpenCodeAccountRegion, Promise<readonly OpenCodeModelMetadataBlock[]>>();

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

/** Packaged apps start with a stripped PATH; resolve `opencode` against the CLI PATH first. */
const commandResolver = new PosixSpawnCommandResolver();

async function runRegionModelLister(region: OpenCodeAccountRegion): Promise<OpenCodeModelMetadataBlock[]> {
  const { output, code } = await captureOpenCodeModelList(() => spawn(
    commandResolver.resolve('opencode'),
    ['models', `xiaomi-token-plan-${region}`, '--verbose'],
    { stdio: ['ignore', 'pipe', 'pipe'], ...buildCliSpawnOptions(), detached: process.platform !== 'win32' },
  ), {
    timeout: `Timeout reading xiaomi-token-plan-${region} model metadata`,
    process: `Failed reading xiaomi-token-plan-${region} model metadata`,
  });
  const blocks = parseOpenCodeModelMetadataBlocks(output).filter(
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
): Promise<readonly OpenCodeModelMetadataBlock[]> {
  if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) {
    throw new Error('Invalid OpenCode Token Plan region.');
  }
  const pending = inFlight.get(region);
  if (pending) return pending;
  const run = withOpenCodeProcessGate(() => runRegionModelLister(region))
    .then((blocks) => {
      cache.set(region, blocks);
      return blocks;
    })
    .finally(() => {
      inFlight.delete(region);
    });
  inFlight.set(region, run);
  return run;
}

/**
 * Ensure the given regions have cached metadata, reading any that do not.
 * Never rejects for a region: callers consult `getCached…` afterwards and fail
 * closed per account.
 */
export async function ensureOpenCodeRegionModelMetadata(
  regions: Iterable<OpenCodeAccountRegion>,
): Promise<void> {
  for (const region of new Set(regions)) {
    if (!OPENCODE_ACCOUNT_REGIONS.includes(region)) {
      logger.warn('Ignoring invalid OpenCode Token Plan region');
      continue;
    }
    if (cache.has(region)) continue;
    try {
      await readOpenCodeRegionModelMetadata(region);
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
