/**
 * The user's configured reviewer model for a provider.
 *
 * Extracted from `review-execution-host.ts` as a leaf module so the checker
 * planner and the execution host can both read it without an import cycle
 * (the host imports the planner).
 */

import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('ReviewerModelOverride');

/**
 * Resolve the model a given reviewer CLI should run with for cross-model review.
 *
 * Returns a concrete model id only when the user has configured an explicit
 * override for that reviewer in `crossModelReviewModelByProvider`. A missing
 * entry, an empty string, or 'auto' yields `undefined`, meaning "pass no model"
 * so the reviewer CLI uses its own default/auto routing. We deliberately do NOT
 * fall back to a primary model — that would silently pin providers (e.g.
 * Copilot's primary is Gemini), defeating each CLI's native routing.
 *
 * Shared by the in-session review path (CrossModelReviewService.executeOneReview)
 * and the headless review path (ProviderReviewExecutionHost) so both honour the
 * same setting.
 *
 * Never throws. A settings read can genuinely fail — the settings lock times out
 * after 5s under concurrent writes — and this is consulted on the hot path of
 * every review, consensus query and ping-pong round. Treating an unreadable
 * setting as "no override configured" degrades to the CLI's own model routing,
 * whereas propagating would take down checking entirely.
 */
export function resolveReviewerModelOverride(provider: string): string | undefined {
  let overrides: Record<string, string> = {};
  try {
    overrides = getSettingsManager().getAll().crossModelReviewModelByProvider ?? {};
  } catch (error) {
    logger.warn('Could not read crossModelReviewModelByProvider; using CLI default routing', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const configured = (overrides[provider] ?? '').trim();
  if (!configured || configured.toLowerCase() === 'auto') {
    return undefined;
  }
  return configured;
}
