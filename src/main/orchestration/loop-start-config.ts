/**
 * Loop start-config preparation (LF-3a).
 *
 * Extracted from `loop-handlers.ts` so it can be unit-tested without importing
 * `electron` (the handler module pulls in `ipcMain` at the top level). Owns the
 * start-time safety rules (WS6 verification-authority policy):
 *   1. goal intent is classified here (shared resolver, explicit intent wins)
 *      BEFORE validation, because the policy depends on it;
 *   2. an IMPLEMENTATION loop must carry a real verification authority — a
 *      verify command (supplied by the caller, or the one this workspace
 *      already exposes, resolved here via `resolveLoopVerification`), or
 *      explicitly enabled operator-reviewed completion with a finite estimated
 *      cost cap. Investigation loops may use review/report authority.
 *      Cross-model review is corroboration, not the substitute authority for
 *      autonomous completion;
 *   3. operator-reviewed loops require a non-null estimated usage cap — they
 *      sit paused awaiting a human Accept and get resumed repeatedly.
 * Validation happens in this main-process seam so IPC/programmatic callers
 * cannot bypass the renderer's submit gating.
 */

import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import {
  defaultCrossModelReviewConfig,
  defaultLoopConfig,
  type LoopConfig,
} from '../../shared/types/loop.types';
import {
  normalizeLoopPhase4Config,
  resolvePhase4ContextStrategy,
} from '../../shared/types/loop-phase4.types';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import { resolveLoopGoalIntent } from '../../shared/utils/loop-intent';
import { createAuxiliaryNextObjectivePlanner } from './loop-next-objective-planner';
import { resolveLoopVerification } from './loop-verify-command';

const logger = getLogger('LoopStartConfig');

type LoopStartConfigLike =
  Omit<LoopConfigInput, 'completion'> & {
    completion?: Partial<LoopConfig['completion']>;
  };

/**
 * Re-attach the runtime next-objective planner function when the config opts
 * into `nextObjectivePlanning` but has no live `nextObjectivePlanner` (e.g. a
 * config rehydrated from persisted JSON, where functions don't survive
 * serialization). Idempotent: a config that already has a planner, or doesn't
 * want one, is returned unchanged. Exported for direct tests and any caller
 * that intentionally prepares a fully materialized config without going through
 * `prepareLoopStartConfig`.
 */
export function attachNextObjectivePlanner<
  T extends Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
>(config: T): T {
  if (!config.nextObjectivePlanning?.enabled || config.nextObjectivePlanner) {
    return config;
  }
  return {
    ...config,
    nextObjectivePlanner: createAuxiliaryNextObjectivePlanner(),
  };
}

function finalizeStartConfig<
  T extends Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string },
>(config: T): T {
  const phase4 = normalizeLoopPhase4Config(config.phase4);
  const defaultContextStrategy = defaultLoopConfig(config.workspaceCwd, config.initialPrompt).contextStrategy;
  return attachNextObjectivePlanner({
    ...config,
    phase4,
    contextStrategy: resolvePhase4ContextStrategy(
      config.contextStrategy ?? defaultContextStrategy,
      phase4,
    ),
  }) as T;
}

export async function prepareLoopStartConfig(
  config: LoopStartConfigLike,
): Promise<Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }> {
  config = await normalizeManagedIsolation(config);
  const audit = prepareUserStartedAuditConfig(config);
  // WS6: classify goal intent BEFORE validation — the verification policy
  // depends on it, and this seam runs before `startLoop` derives intent.
  // The shared resolver keeps both seams (and the renderer's submit gate)
  // consistent; an explicit caller-supplied intent is preserved.
  const goalIntent = resolveLoopGoalIntent(config.goalIntent, config.initialPrompt);
  // LF-3a: operator-reviewed loops sit paused waiting for a human Accept and get
  // resumed/re-attempted repeatedly, so require an explicit local usage cap.
  if (
    config.completion?.allowOperatorReviewedCompletion &&
    config.caps?.maxCostCents === null
  ) {
    throw new Error(
      'Operator-reviewed completion requires an estimated usage cap. ' +
      'These loops pause for manual sign-off and can be resumed repeatedly, so an ' +
      'unbounded run is unsafe. Set Estimated usage cap, or configure a verify command.',
    );
  }
  // WS6 verification-authority policy: an IMPLEMENTATION loop cannot imply
  // autonomous completion without a real verification authority — it needs a
  // verify command, or the explicitly operator-reviewed mode (whose finite-cap
  // requirement is enforced above plus the finite default). Investigation loops
  // may use review/report authority (their deliverable is a cited REPORT.md
  // gated by the completion detector, not a build). Cross-model review remains
  // corroboration, never the substitute authority.
  //
  // When the caller supplied no command, the workspace's OWN verifier counts:
  // refusing to start a repo that exposes `npm run verify` — while the start
  // panel displays that very command as "auto-detected" — was the policy
  // demanding an answer the app already had.
  const verification = await resolveLoopVerification({
    workspaceCwd: config.workspaceCwd,
    verifyCommand: config.completion?.verifyCommand,
    allowOperatorReviewedCompletion: config.completion?.allowOperatorReviewedCompletion,
    requireAuthority: goalIntent.intent === 'implementation',
  });
  if (goalIntent.intent === 'implementation' && verification.authority === 'none') {
    throw new Error(
      'Implementation loops need a verification authority, and none was detected in '
      + `${config.workspaceCwd}. Set a verify command (tests/build/typecheck), add a `
      + '"verify"/"test"/"lint"/"typecheck" script to package.json, or explicitly enable '
      + 'operator-reviewed completion (pauses for your sign-off; requires a finite '
      + 'estimated cost cap). Cross-model review alone cannot confirm autonomous completion.',
    );
  }
  if (verification.authority === 'inferred') {
    logger.info('Adopted the workspace verifier as this loop\'s verification authority', {
      workspaceCwd: config.workspaceCwd,
      verifyCommand: verification.verifyCommand,
      source: verification.inferredSource,
    });
  }
  const verifyCommand = verification.verifyCommand;
  const resolvedGoalIntent = goalIntent.intent;
  // Every return path writes the RESOLVED command back, so the engine runs it,
  // the persisted run config records what actually gated the run, and
  // `manualReviewOnly` is derived from the real value rather than the blank one
  // the caller happened to send.
  const completionFor = (
    mode: 'review-driven' | 'gated',
    extra?: Partial<LoopConfig['completion']>,
  ): LoopConfig['completion'] => ({
    ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
    ...(config.completion ?? {}),
    ...(extra ?? {}),
    verifyCommand,
    mode,
  });
  // Completion mode. The default for user-started loops is 'review-driven':
  // the loop's engine is a fresh-eyes self-review that keeps fixing what it
  // finds until N consecutive clean passes — the proven manual workflow,
  // automated. The operator-reviewed escape hatch is a deliberately gated
  // flavour, so it stays in 'gated' mode. An explicit `mode` from the caller
  // always wins.
  const explicitMode = config.completion?.mode;
  const mode =
    explicitMode ?? (config.completion?.allowOperatorReviewedCompletion ? 'gated' : 'review-driven');

  if (mode === 'review-driven') {
    // Self-review is the default authority — we do NOT auto-enable cross-model
    // review here (that's the opt-in "ask another model" option, set by the
    // caller via `crossModelReview.enabled`). A verify command, if supplied, is
    // still honoured and folded in as an extra check during review-driven runs.
    logger.info('Defaulting loop completion to review-driven (fresh-eyes self-review)', {
      workspaceCwd: config.workspaceCwd,
      verifyCommand: verifyCommand || '(none)',
      verificationAuthority: verification.authority,
    });
    return finalizeStartConfig({
      ...config,
      audit,
      goalIntent: resolvedGoalIntent,
      completion: completionFor('review-driven'),
    });
  }

  // --- gated mode (explicit, or the operator-reviewed escape hatch) ---
  if (verifyCommand || config.completion?.allowOperatorReviewedCompletion) {
    return finalizeStartConfig({
      ...config,
      audit,
      goalIntent: resolvedGoalIntent,
      completion: completionFor('gated'),
    });
  }

  // Gated, with no verification command available at all — reachable only for
  // investigation goals (implementation goals were resolved or refused above).
  // The gated completion authority defaults to the fresh-eyes cross-model
  // review; an explicit `crossModelReview: { enabled: false }` is honoured.
  if (config.completion?.crossModelReview !== undefined) {
    return finalizeStartConfig({
      ...config,
      audit,
      goalIntent: resolvedGoalIntent,
      completion: completionFor('gated'),
    });
  }

  logger.info('No verify command available (gated mode) — defaulting completion gate to fresh-eyes cross-model review', {
    workspaceCwd: config.workspaceCwd,
  });
  return finalizeStartConfig({
    ...config,
    audit,
    goalIntent: resolvedGoalIntent,
    completion: completionFor('gated', { crossModelReview: defaultCrossModelReviewConfig() }),
  });
}

async function normalizeManagedIsolation<T extends LoopStartConfigLike>(config: T): Promise<T> {
  if (!config.isolateLoopWorkspaces || config.executionCwd) return config;

  try {
    const workspace = await stat(config.workspaceCwd);
    if (!workspace.isDirectory()) return config;
  } catch {
    // An unavailable workspace is not evidence that it is non-Git. Preserve
    // fail-closed isolation so the coordinator surfaces the underlying error.
    return config;
  }

  try {
    await stat(path.join(config.workspaceCwd, '.git'));
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return config;
  }

  logger.info('Managed loop isolation disabled for non-Git workspace', {
    workspaceCwd: config.workspaceCwd,
  });
  return {
    ...config,
    isolateLoopWorkspaces: false,
    autoIntegrateWorktree: false,
  };
}

function prepareUserStartedAuditConfig(config: LoopStartConfigLike): LoopConfig['audit'] {
  const audit = config.audit;
  return {
    finalAuditMode: audit?.finalAuditMode ?? 'gate',
    preflightMode: audit?.preflightMode ?? 'record',
    planPacketMode: audit?.planPacketMode ?? defaultPlanPacketMode(config),
    cleanlinessScan: audit?.cleanlinessScan ?? true,
  };
}

function defaultPlanPacketMode(config: LoopStartConfigLike): LoopConfig['audit']['planPacketMode'] {
  if (config.planFile?.trim()) return 'prompted';
  if (config.initialPrompt.length >= 800) return 'prompted';
  const maxIterations = config.caps?.maxIterations;
  if (maxIterations === null) return 'prompted';
  const configuredOrDefault = maxIterations ?? defaultLoopConfig(config.workspaceCwd, config.initialPrompt).caps.maxIterations;
  const effectiveMaxIterations = configuredOrDefault ?? Number.POSITIVE_INFINITY;
  return effectiveMaxIterations >= 5 ? 'prompted' : 'off';
}
