/**
 * Loop start-config preparation (LF-3a).
 *
 * Extracted from `loop-handlers.ts` so it can be unit-tested without importing
 * `electron` (the handler module pulls in `ipcMain` at the top level). Owns the
 * two start-time safety rules:
 *   1. when no verify command is supplied (and the loop isn't operator-reviewed),
 *      default the completion authority to the fresh-eyes cross-model review
 *      instead of forcing a heavy machine verify command; an explicit
 *      `crossModelReview` choice from the caller is preserved;
 *   2. require a non-null estimated usage cap for operator-reviewed loops, which sit
 *      paused awaiting a human Accept and get resumed repeatedly.
 */

import { getLogger } from '../logging/logger';
import {
  defaultCrossModelReviewConfig,
  defaultLoopConfig,
  type LoopConfig,
} from '../../shared/types/loop.types';
import type { LoopConfigInput } from '@contracts/schemas/loop';
import { createAuxiliaryNextObjectivePlanner } from './loop-next-objective-planner';

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

export async function prepareLoopStartConfig(
  config: LoopStartConfigLike,
): Promise<Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }> {
  const verifyCommand = config.completion?.verifyCommand?.trim() ?? '';
  const audit = prepareUserStartedAuditConfig(config);
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
    });
    return attachNextObjectivePlanner({
      ...config,
      audit,
      completion: {
        ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
        ...(config.completion ?? {}),
        mode: 'review-driven',
      },
    });
  }

  // --- gated mode (explicit, or the operator-reviewed escape hatch) ---
  if (verifyCommand || config.completion?.allowOperatorReviewedCompletion) {
    return attachNextObjectivePlanner({
      ...config,
      audit,
      completion: {
        ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
        ...(config.completion ?? {}),
        mode: 'gated',
      },
    });
  }

  // Gated, no verify command, not operator-reviewed. We deliberately do NOT
  // infer/force a machine verify command (heavy, environment-fragile). The
  // gated completion authority defaults to the fresh-eyes cross-model review;
  // an explicit `crossModelReview: { enabled: false }` from the caller is
  // honoured.
  if (config.completion?.crossModelReview !== undefined) {
    return attachNextObjectivePlanner({
      ...config,
      audit,
      completion: {
        ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
        ...config.completion,
        mode: 'gated',
      },
    });
  }

  logger.info('No verify command configured (gated mode) — defaulting completion gate to fresh-eyes cross-model review', {
    workspaceCwd: config.workspaceCwd,
  });
  return attachNextObjectivePlanner({
    ...config,
    audit,
    completion: {
      ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
      ...(config.completion ?? {}),
      mode: 'gated',
      crossModelReview: defaultCrossModelReviewConfig(),
    },
  });
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
