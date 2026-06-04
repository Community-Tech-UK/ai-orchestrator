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
 *   2. require a non-null cost cap for operator-reviewed loops, which sit
 *      paused awaiting a human Accept and get resumed repeatedly.
 */

import { getLogger } from '../logging/logger';
import {
  defaultCrossModelReviewConfig,
  defaultLoopConfig,
  type LoopConfig,
} from '../../shared/types/loop.types';
import type { LoopConfigInput } from '@contracts/schemas/loop';

const logger = getLogger('LoopStartConfig');

export async function prepareLoopStartConfig(
  config: LoopConfigInput,
): Promise<Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string }> {
  const verifyCommand = config.completion?.verifyCommand?.trim() ?? '';
  // LF-3a: operator-reviewed loops sit paused waiting for a human Accept and get
  // resumed/re-attempted repeatedly, so they're the most likely to burn spend.
  // Require a non-null cost cap. (Omitted caps inherit the $10 default in
  // materializeConfig, so this only rejects an explicit "unbounded" choice.)
  if (
    config.completion?.allowOperatorReviewedCompletion &&
    config.caps?.maxCostCents === null
  ) {
    throw new Error(
      'Operator-reviewed completion requires a spend cap (Max spend $). ' +
      'These loops pause for manual sign-off and can be resumed repeatedly, so an ' +
      'unbounded run is unsafe. Set a Max spend, or configure a verify command.',
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
    return {
      ...config,
      completion: {
        ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
        ...(config.completion ?? {}),
        mode: 'review-driven',
      },
    };
  }

  // --- gated mode (explicit, or the operator-reviewed escape hatch) ---
  if (verifyCommand || config.completion?.allowOperatorReviewedCompletion) {
    return { ...config, completion: { ...(config.completion ?? {}), mode: 'gated' } as LoopConfig['completion'] };
  }

  // Gated, no verify command, not operator-reviewed. We deliberately do NOT
  // infer/force a machine verify command (heavy, environment-fragile). The
  // gated completion authority defaults to the fresh-eyes cross-model review;
  // an explicit `crossModelReview: { enabled: false }` from the caller is
  // honoured.
  if (config.completion?.crossModelReview !== undefined) {
    return { ...config, completion: { ...config.completion, mode: 'gated' } };
  }

  logger.info('No verify command configured (gated mode) — defaulting completion gate to fresh-eyes cross-model review', {
    workspaceCwd: config.workspaceCwd,
  });
  return {
    ...config,
    completion: {
      ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
      ...(config.completion ?? {}),
      mode: 'gated',
      crossModelReview: defaultCrossModelReviewConfig(),
    },
  };
}
