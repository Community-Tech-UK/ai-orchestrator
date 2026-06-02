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
  if (verifyCommand || config.completion?.allowOperatorReviewedCompletion) {
    return config;
  }

  // No verify command and not operator-reviewed. We deliberately do NOT infer
  // and force a machine verify command (e.g. `npm run verify`) anymore — that
  // gate is heavy, environment-fragile (it needs node/npm on the launched
  // process's PATH), and ran BEFORE the fresh-eyes review so a broken verify
  // environment starved the review gate entirely. Instead the default
  // completion authority is the fresh-eyes cross-model review: the loop
  // auto-completes when an independent model review comes back clean, keeps
  // iterating on blocking findings, and only pauses for an operator when no
  // review verdict is available. A machine verify command is still fully
  // supported — it's now opt-in (set it in the Verify field / loop config).
  //
  // An explicit `crossModelReview: { enabled: false }` from the caller is
  // honoured; we only fill in the default when it was left unset.
  if (config.completion?.crossModelReview !== undefined) {
    return config;
  }

  logger.info('No verify command configured — defaulting completion gate to fresh-eyes cross-model review', {
    workspaceCwd: config.workspaceCwd,
  });
  return {
    ...config,
    completion: {
      ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
      ...(config.completion ?? {}),
      crossModelReview: defaultCrossModelReviewConfig(),
    },
  };
}
