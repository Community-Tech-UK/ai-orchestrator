/**
 * L7 — artifact freshness, fail-open.
 *
 * A green suite proves nothing if it ran against a stale build. LT-012 was
 * three days of exactly that: `tsc --noEmit` stayed green while `dist/main`
 * held code from the previous week, because the build step died before the
 * copy and nothing compared the two.
 *
 * The check is deliberately one-directional. Only POSITIVELY ESTABLISHED
 * staleness blocks: newest source mtime is strictly newer than newest build
 * output mtime, both readable, both non-empty. Everything else — no build dir,
 * no sources, an unreadable path, a filesystem with coarse timestamps — is
 * `unknown`, and unknown never blocks. A freshness check that can hard-block on
 * "I couldn't tell" is a check that eventually wedges a healthy loop at 3am.
 *
 * The retry bound is storybloq's `MAX_FRESHNESS_RETRIES`: after that many
 * blocked attempts the loop stops asking and proceeds, because a build that
 * will not refresh is a problem for a human, not a reason to spin.
 */

import { promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { applyVerifyOutcomeToIteration } from './loop-coordinator-utils';
import { createLoopPendingInput, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

const logger = getLogger('LoopArtifactFreshness');

/** Blocked attempts before the check gives up and lets the loop proceed. */
export const MAX_FRESHNESS_RETRIES = 2;

/**
 * Filesystems and archives can report timestamps a second or two apart for
 * files written in the same operation. Only a difference beyond this counts.
 */
export const FRESHNESS_TOLERANCE_MS = 2_000;

export type FreshnessVerdict = 'fresh' | 'stale' | 'unknown';

export interface FreshnessResult {
  verdict: FreshnessVerdict;
  reason: string;
  newestSourceMs?: number;
  newestOutputMs?: number;
  /** The source file that is newer than the build. Only set when `stale`. */
  staleAgainst?: string;
}

interface NewestFile {
  path: string;
  mtimeMs: number;
}

async function newestMtime(
  root: string,
  matches: (relPath: string) => boolean,
  maxEntries = 5_000,
): Promise<NewestFile | null> {
  let newest: NewestFile | null = null;
  let seen = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (seen >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(abs, relPath);
        continue;
      }
      if (!entry.isFile() || !matches(relPath)) continue;
      seen += 1;
      try {
        const stat = await fsp.stat(abs);
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: relPath, mtimeMs: stat.mtimeMs };
      } catch {
        // An unreadable file cannot make anything stale — skip it.
      }
    }
  };
  await walk(root, '');
  return newest;
}

/**
 * Compare newest source mtime against newest build-output mtime.
 *
 * Returns `unknown` (never `stale`) whenever either side cannot be established.
 */
export async function checkArtifactFreshness(args: {
  workspaceCwd: string;
  /** Directory holding compiled output, relative to the workspace. */
  outputDir: string;
  /** Predicate for "this is a source file", relative to the workspace. */
  isSource?: (relPath: string) => boolean;
}): Promise<FreshnessResult> {
  const isSource = args.isSource
    ?? ((relPath) => /\.(ts|tsx|js|mjs|cjs|json|html|scss|css)$/.test(relPath)
      && !relPath.startsWith(args.outputDir));

  const outputRoot = path.join(args.workspaceCwd, args.outputDir);
  const [newestSource, newestOutput] = await Promise.all([
    newestMtime(args.workspaceCwd, isSource),
    newestMtime(outputRoot, () => true),
  ]);

  if (!newestOutput) {
    return { verdict: 'unknown', reason: `no build output found under ${args.outputDir}` };
  }
  if (!newestSource) {
    return { verdict: 'unknown', reason: 'no source files matched the freshness predicate' };
  }

  const deltaMs = newestSource.mtimeMs - newestOutput.mtimeMs;
  if (deltaMs > FRESHNESS_TOLERANCE_MS) {
    return {
      verdict: 'stale',
      reason:
        `${newestSource.path} is ${Math.round(deltaMs / 1000)}s newer than the newest file in `
        + `${args.outputDir} — the build output does not include the current source`,
      newestSourceMs: newestSource.mtimeMs,
      newestOutputMs: newestOutput.mtimeMs,
      staleAgainst: newestSource.path,
    };
  }

  return {
    verdict: 'fresh',
    reason: `${args.outputDir} is at least as new as the newest source file`,
    newestSourceMs: newestSource.mtimeMs,
    newestOutputMs: newestOutput.mtimeMs,
  };
}

/**
 * Should this completion attempt be blocked on stale build output?
 *
 * Only a `stale` verdict blocks, and only while retries remain. `unknown` never
 * blocks — that is the fail-open contract, and it is the difference between a
 * check that catches LT-012 and a check that wedges a loop overnight.
 */
export function shouldBlockOnStaleArtifacts(
  result: FreshnessResult,
  attemptsSoFar: number,
  maxRetries = MAX_FRESHNESS_RETRIES,
): boolean {
  if (result.verdict !== 'stale') return false;
  return attemptsSoFar < maxRetries;
}

/** Conventional build-output directory names, most specific first. */
const BUILD_OUTPUT_CANDIDATES = ['dist', 'build', 'out', 'lib'] as const;

/**
 * Find the workspace's build-output directory, or `null` when it has none.
 *
 * `null` is the common case — most loop workspaces are not compiled projects —
 * and it is what keeps the check fail-open: no output directory means no
 * freshness claim, not a stale one.
 */
export async function resolveBuildOutputDir(workspaceCwd: string): Promise<string | null> {
  for (const candidate of BUILD_OUTPUT_CANDIDATES) {
    try {
      const stat = await fsp.stat(path.join(workspaceCwd, candidate));
      if (stat.isDirectory()) return candidate;
    } catch {
      // Not present — try the next.
    }
  }
  return null;
}

/**
 * The intervention text for a completion attempt rejected on stale artifacts.
 * Names the offending file so the child can act rather than guess.
 */
export function staleArtifactIntervention(result: FreshnessResult, outputDir: string): string {
  return 'Your completion was rejected because the build output is stale: '
    + `${result.reason}. A green check against ${outputDir}/ from before your last edit is not `
    + 'evidence the change works. Rebuild, re-run the verify command, then declare completion again.';
}

/**
 * The whole L7 decision for one completion attempt, in one call: find the
 * output dir, compare mtimes, and decide whether this attempt is blocked.
 *
 * Returns `null` for "carry on" — which covers every case the check could not
 * establish, so the caller's happy path stays one `if`.
 */
export async function evaluateLoopArtifactFreshness(state: {
  config: { workspaceCwd: string; executionCwd?: string };
  staleArtifactRejections?: number;
}): Promise<{ reason: string; intervention: string } | null> {
  const workspaceCwd = state.config.executionCwd ?? state.config.workspaceCwd;
  const outputDir = await resolveBuildOutputDir(workspaceCwd);
  if (!outputDir) return null;
  const result = await checkArtifactFreshness({ workspaceCwd, outputDir });
  if (!shouldBlockOnStaleArtifacts(result, state.staleArtifactRejections ?? 0)) return null;
  return { reason: result.reason, intervention: staleArtifactIntervention(result, outputDir) };
}

/**
 * Reject a completion attempt whose build output predates the change, and tell
 * the child what to do about it. Returns true when the attempt was rejected.
 *
 * Fail-open by construction: everything {@link evaluateLoopArtifactFreshness}
 * cannot establish returns `null` here, so the caller's happy path is one `if`.
 */
export async function rejectCompletionOnStaleArtifacts(args: {
  state: LoopState;
  iteration: LoopIteration;
  emit: (eventName: string, payload: unknown) => void;
  cloneForBroadcast: () => unknown;
}): Promise<boolean> {
  const { state, iteration } = args;
  const result = await evaluateLoopArtifactFreshness(state);
  if (!result) return false;

  state.staleArtifactRejections = (state.staleArtifactRejections ?? 0) + 1;
  applyVerifyOutcomeToIteration(iteration, {
    status: 'failed',
    output: result.intervention,
    // `environment`, not `command`: the code is not what failed, the build is.
    failureKind: 'environment',
  });
  state.pendingInterventions.push(createLoopPendingInput(result.intervention, { source: 'phase-recovery' }));
  args.emit('loop:stale-artifacts', { loopRunId: state.id, seq: iteration.seq, reason: result.reason });
  args.emit('loop:state-changed', { loopRunId: state.id, state: args.cloneForBroadcast() });
  logger.info('Completion rejected — build output is stale', { loopRunId: state.id, reason: result.reason });
  return true;
}
