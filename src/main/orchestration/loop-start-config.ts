/**
 * Loop start-config preparation (LF-3a).
 *
 * Extracted from `loop-handlers.ts` so it can be unit-tested without importing
 * `electron` (the handler module pulls in `ipcMain` at the top level). Owns the
 * two start-time safety rules:
 *   1. infer a verify command from the workspace when none was supplied, and
 *      throw if none can be inferred and the loop isn't operator-reviewed;
 *   2. require a non-null cost cap for operator-reviewed loops, which sit
 *      paused awaiting a human Accept and get resumed repeatedly.
 */

import { getLogger } from '../logging/logger';
import { inferLoopVerifyCommand } from './loop-verify-command';
import { defaultLoopConfig, type LoopConfig } from '../../shared/types/loop.types';
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

  const inferred = await inferLoopVerifyCommand(config.workspaceCwd);
  if (inferred) {
    logger.info('Inferred Loop Mode verify command at start', {
      workspaceCwd: config.workspaceCwd,
      command: inferred.command,
      source: inferred.source,
    });
    return {
      ...config,
      completion: {
        ...defaultLoopConfig(config.workspaceCwd, config.initialPrompt).completion,
        ...(config.completion ?? {}),
        verifyCommand: inferred.command,
      },
    };
  }

  throw new Error(
    `Loop Mode could not infer a verify command for workspace "${config.workspaceCwd}". ` +
    'Add one in Verify command, add a package.json "verify" script, ' +
    'or enable operator-reviewed completion so the loop pauses when it thinks it is done.',
  );
}
