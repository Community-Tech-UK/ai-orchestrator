/**
 * Model defaults for NON-INTERACTIVE work (loop iterations, orchestration
 * invokers, and anything else that runs without a human choosing a model).
 *
 * Why this module exists
 * ----------------------
 * Automation used to call `getDefaultModelForCli()` directly, which returns the
 * *interactive* new-session default. That coupling is invisible and dangerous:
 * on 2026-07-10 the codex interactive default moved from `gpt-5.5` to
 * `gpt-5.6-sol` and every loop iteration moved with it, taking the highest
 * volume path in the app onto flagship rates with no user-facing control.
 *
 * `resolveAutomationDefaultModel` puts a user-owned setting
 * (`loopModelByProvider`) in front of that fallback, so the interactive default
 * and the automation default can move independently. Providers with no entry
 * behave exactly as before.
 *
 * An explicitly requested model (a routed model, a user's per-run pick) always
 * wins — callers pass it and never reach this function.
 */
import { getDefaultModelForCli } from '../../shared/types/provider.types';
import type { CliType } from '../cli/cli-detection';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('AutomationModelDefaults');

/**
 * The model automation should use for `cliType` when the caller has not chosen
 * one. Prefers the operator's `loopModelByProvider` entry; falls back to the
 * provider's interactive default.
 *
 * Reads settings defensively: a settings-manager failure must not take down a
 * loop, so we fall back rather than throw.
 *
 * Returns `undefined` only when the provider itself has no default model — the
 * same contract `getDefaultModelForCli` has, so callers are unchanged.
 */
export function resolveAutomationDefaultModel(cliType: CliType): string | undefined {
  const fallback = getDefaultModelForCli(cliType);

  let configured = '';
  try {
    configured = (getSettingsManager().getAll().loopModelByProvider?.[cliType] ?? '').trim();
  } catch (error) {
    logger.warn('Failed to read loopModelByProvider; using interactive default', {
      cliType,
      model: fallback,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }

  // '' and 'auto' both mean "no opinion — use the provider's own default",
  // matching the convention already used by crossModelReviewModelByProvider.
  if (!configured || configured.toLowerCase() === 'auto') {
    return fallback;
  }

  return configured;
}
