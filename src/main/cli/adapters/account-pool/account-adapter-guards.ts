/**
 * Fail-closed route enforcement and spawn-environment derivation for Claude and
 * Codex account pools.
 *
 * Routing reads settings, the ledger and node-local binding state, and the
 * adapter factory is synchronous, so the route is resolved earlier
 * (`attachAccountRoute()`) and the factory only enforces it here. Mirrors
 * `copilot-adapter-guards.ts`, with one deliberate difference: while a provider
 * has only its legacy profile, a spawn without a route is the pre-pools
 * behaviour and passes through untouched (spec §2: zero or one profile behaves
 * exactly as today).
 */

import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import {
  isLegacyAccountProfileId,
  type PooledProvider,
  type ResolvedAccountRoute,
} from '../../../../shared/types/provider-account.types';
import { getProviderAccountStore, isAccountPoolActive } from '../../../providers/account-pool/provider-account-store';
import { seedClaudeProfileHome } from '../../../providers/account-pool/claude-profile-seed';
import { seedCodexProfileHome } from '../../../providers/account-pool/codex-profile-seed';
import { resolveAccountProfileHome } from './provider-account-home-resolver';
import {
  CLAUDE_STRIPPED_AUTH_ENV_VARS,
  CODEX_STRIPPED_AUTH_ENV_VARS,
} from '../adapter-spawn-helpers';

/** `-c` override pinning file-based credentials on profile-routed Codex spawns. */
export const CODEX_FILE_CREDENTIAL_STORE_OVERRIDE = 'cli_auth_credentials_store=file';

// No settings manager (worker agent, isolated tests) reads as "no pool": a
// worker always receives a materialised route.
const poolIsActive = (provider: PooledProvider): boolean => isAccountPoolActive(provider);

/**
 * Returns the attached route, or null for a legacy pass-through spawn.
 *
 * @throws when the provider has non-legacy profiles and no route was attached
 *         (the spawn escaped the resolver), or when the route is for another
 *         provider.
 */
export function requireAccountRoute(
  options: UnifiedSpawnOptions,
  provider: PooledProvider,
  where: 'local' | 'remote',
): ResolvedAccountRoute | null {
  const route = options.accountRoute;
  if (route) {
    if (route.provider !== provider) {
      throw new Error(
        `A ${route.provider} account route was attached to a ${provider} spawn (${where}). This is an internal routing error.`,
      );
    }
    return route;
  }
  if (poolIsActive(provider)) {
    throw new Error(
      `${provider === 'claude' ? 'Claude' : 'Codex'} cannot start without a resolved account profile (${where} spawn). `
      + 'This is an internal routing error: every spawn path must call attachAccountRoute() first.',
    );
  }
  return null;
}

export interface ClaudeAccountSpawnEnv {
  /** Variables to set on the child (only `CLAUDE_CONFIG_DIR` for a derived profile). */
  env: Record<string, string>;
  /** Variables removed after the ambient-env merge. */
  envRemove: readonly string[];
}

/**
 * Environment for a Claude spawn under its resolved account route.
 *
 * - Derived profile: `CLAUDE_CONFIG_DIR=<realpath home>`, every other ambient
 *   auth variable removed. `--bare` is refused: it skips OAuth entirely.
 * - Legacy route (only attached while a pool is active): no `CLAUDE_CONFIG_DIR`,
 *   all ambient auth variables removed, so `~/.claude` subscription auth runs.
 * - No route (no pool): nothing changes.
 */
export function resolveClaudeAccountSpawnEnv(options: UnifiedSpawnOptions, where: 'local' | 'remote' = 'local'): ClaudeAccountSpawnEnv {
  const route = requireAccountRoute(options, 'claude', where);
  if (!route || isLegacyAccountProfileId(route.profileId)) {
    // A route is only attached while a pool is active, so a legacy route strips
    // ambient auth even where no pool settings exist (a worker node, D10).
    return route
      ? { env: {}, envRemove: CLAUDE_STRIPPED_AUTH_ENV_VARS }
      : { env: {}, envRemove: [] };
  }
  if (options.bare) {
    throw new Error('A profile-routed Claude spawn cannot use --bare: bare mode skips subscription sign-in.');
  }
  const resolved = resolveAccountProfileHome({ provider: 'claude', profileId: route.profileId });
  if (resolved.kind !== 'derived') {
    throw new Error(`Claude account profile ${route.profileId} did not resolve to a profile home.`);
  }
  seedClaudeProfileHome(resolved.home, { continuation: continuationFor('claude') });
  return {
    env: { CLAUDE_CONFIG_DIR: resolved.home },
    envRemove: CLAUDE_STRIPPED_AUTH_ENV_VARS.filter((key) => key !== 'CLAUDE_CONFIG_DIR'),
  };
}

export interface CodexAccountSpawnConfig {
  /** Profile home whose `auth.json` the per-instance temp `CODEX_HOME` links. */
  authSourceDir?: string;
  envRemove: readonly string[];
  /** `-c` overrides added to every app-server and exec invocation. */
  configOverrides: readonly string[];
}

/**
 * Spawn configuration for a Codex adapter under its resolved account route.
 * Codex keeps its temporary per-instance home; a derived profile only changes
 * where that home's `auth.json` comes from.
 */
export function resolveCodexAccountSpawnConfig(options: UnifiedSpawnOptions, where: 'local' | 'remote' = 'local'): CodexAccountSpawnConfig {
  const route = requireAccountRoute(options, 'codex', where);
  if (!route || isLegacyAccountProfileId(route.profileId)) {
    // A route is only attached while a pool is active, so a legacy route strips
    // ambient auth even where no pool settings exist (a worker node, D10).
    return route
      ? { envRemove: CODEX_STRIPPED_AUTH_ENV_VARS, configOverrides: [] }
      : { envRemove: [], configOverrides: [] };
  }
  const resolved = resolveAccountProfileHome({ provider: 'codex', profileId: route.profileId });
  if (resolved.kind !== 'derived') {
    throw new Error(`Codex account profile ${route.profileId} did not resolve to a profile home.`);
  }
  seedCodexProfileHome(resolved.home);
  return {
    authSourceDir: resolved.home,
    envRemove: CODEX_STRIPPED_AUTH_ENV_VARS,
    configOverrides: [CODEX_FILE_CREDENTIAL_STORE_OVERRIDE],
  };
}

function continuationFor(provider: PooledProvider): 'shared-store' | 'replay' {
  try {
    return getProviderAccountStore().getPoolPolicy(provider).continuation;
  } catch {
    return 'shared-store';
  }
}
