/**
 * Live per-provider authentication probe.
 *
 * Used to confirm (or refute) a suspected auth failure before the app tells the
 * user their session is signed out, and to watch for the moment they sign back
 * in. Only providers with a real status command can be probed; everything else
 * answers `unknown`, and callers must treat that as "no opinion" rather than
 * "signed out".
 */

import type { InstanceProvider } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { checkClaudeCliAuthentication } from './claude-cli-auth';
import { checkCodexCliAuthentication } from './codex-cli-auth';
import { checkGeminiCliAuthentication } from './gemini-cli-auth';

const logger = getLogger('ProviderAuthStatus');

export type ProviderAuthState = 'authenticated' | 'unauthenticated' | 'unknown';

type AuthCheck = () => Promise<{ authenticated: boolean }>;

const AUTH_CHECKS: Partial<Record<InstanceProvider, AuthCheck>> = {
  claude: checkClaudeCliAuthentication,
  codex: checkCodexCliAuthentication,
  gemini: checkGeminiCliAuthentication,
};

/** Whether this provider can be probed at all. */
export function canProbeProviderAuth(provider: InstanceProvider): boolean {
  return AUTH_CHECKS[provider] !== undefined;
}

/**
 * Probes the provider's current auth state. Never throws — a probe that fails
 * to run is `unknown`, which callers must not treat as a sign-out.
 */
export async function probeProviderAuth(provider: InstanceProvider): Promise<ProviderAuthState> {
  const check = AUTH_CHECKS[provider];
  if (!check) return 'unknown';

  try {
    const result = await check();
    return result.authenticated ? 'authenticated' : 'unauthenticated';
  } catch (error) {
    logger.debug('Provider auth probe failed', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}
