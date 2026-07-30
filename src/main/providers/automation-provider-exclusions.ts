/**
 * Operator-owned block-list for AUTOMATIC provider selection.
 *
 * Why this exists
 * ---------------
 * A provider's licence can be scoped to a context the app knows nothing about —
 * a work GitHub Copilot seat usable only on that employer's repositories, say.
 * The app has six independent places that pick a provider on the user's behalf
 * (`resolveCliType`'s fallback priority, scaffolding routing, magic prompts, the
 * consensus fan-out, the verification panel, and the ping-pong reviewer pool),
 * each with its own hardcoded preference array. Before this module there was no
 * single lever that could keep a provider out of all of them, so "I removed it
 * from the cross-model reviewer" covered one path out of six.
 *
 * The rule is deliberately narrow: EXCLUDED FROM AUTOMATIC SELECTION, NOT
 * DISABLED. A listed provider stays fully usable when the user explicitly picks
 * it for a session or names it as `defaultCli` — those are human choices made in
 * a known context. Only the machinery's own "pick whatever is installed" logic
 * is filtered.
 *
 * Matching
 * --------
 * Trim + lowercase on the plain CLI id. Aliases are NOT folded: `gemini` and
 * `antigravity` are distinct CLIs (`gemini` vs `agy`) even though the reviewer
 * vocabulary aliases one to the other, and folding them here would exclude a
 * provider the operator never listed. Reviewer call sites normalise their
 * candidates before calling in, and every id normalises to itself apart from
 * that one pair, so exact matching is what callers actually want.
 *
 * Read failures fail SAFE
 * -----------------------
 * The last successfully-read set is cached. If the settings manager throws we
 * return that cache rather than an empty set: a transient read error must never
 * silently re-admit an excluded provider, which is the exact failure this module
 * exists to prevent. Empty is returned only before any successful read.
 */

import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('AutomationProviderExclusions');

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Last set read successfully from settings; survives a later read failure. */
let cachedExclusions: ReadonlySet<string> | null = null;

/**
 * Providers the operator has barred from automatic selection, as lowercase CLI
 * ids. Never throws.
 */
export function getProvidersExcludedFromAutomation(): ReadonlySet<string> {
  try {
    const configured = getSettingsManager().getAll().providersExcludedFromAutomation;
    const normalized = new Set<string>(
      (Array.isArray(configured) ? configured : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );
    cachedExclusions = normalized;
    return normalized;
  } catch (error) {
    // Fail safe: keep enforcing the last known list rather than opening up.
    logger.warn('Failed to read providersExcludedFromAutomation; reusing last known list', {
      error: error instanceof Error ? error.message : String(error),
      usingCached: cachedExclusions !== null,
      excluded: cachedExclusions ? [...cachedExclusions] : [],
    });
    return cachedExclusions ?? EMPTY;
  }
}

/** Is this provider barred from being chosen automatically? */
export function isProviderExcludedFromAutomation(provider: string): boolean {
  const excluded = getProvidersExcludedFromAutomation();
  if (excluded.size === 0) return false;
  return excluded.has(provider.trim().toLowerCase());
}

/**
 * Drop every excluded provider from an automatic candidate list, preserving
 * order. `context` names the call site for the debug log.
 */
export function filterProvidersForAutomation<T extends string>(
  providers: readonly T[],
  context: string,
): T[] {
  const excluded = getProvidersExcludedFromAutomation();
  if (excluded.size === 0) return [...providers];

  const kept: T[] = [];
  const dropped: T[] = [];
  for (const provider of providers) {
    if (excluded.has(provider.trim().toLowerCase())) {
      dropped.push(provider);
    } else {
      kept.push(provider);
    }
  }

  if (dropped.length > 0) {
    logger.debug('Excluded providers from automatic selection', { context, dropped });
  }
  return kept;
}

export function _resetAutomationProviderExclusionsForTesting(): void {
  cachedExclusions = null;
}
