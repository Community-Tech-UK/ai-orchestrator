/**
 * Derives the node-local CLI home for one Claude or Codex account profile.
 *
 * The only place a profile home path is produced. Renderers, agents and remote
 * callers supply a provider and a profile ID; every node derives its own home
 * beneath its own state root, exactly like `copilot-account-home-resolver.ts`:
 * the ID is re-validated here, containment is checked before `mkdir`, and again
 * after it against the realpath so a pre-existing symlink cannot redirect the
 * profile's sign-in somewhere else.
 *
 * Byte stability matters for Claude: Claude Code names the macOS Keychain item
 * after `sha256(NFC(CLAUDE_CONFIG_DIR))`, hashing the raw string. The returned
 * home is absolute, realpath'd and has no trailing separator, and it is the ONLY
 * string ever exported as `CLAUDE_CONFIG_DIR` (spec invariant 4).
 *
 * The legacy profile resolves to `{ kind: 'legacy' }`: no path at all, because
 * it keeps using `~/.claude` / `~/.codex` exactly as before pools existed.
 */

import { createHash } from 'crypto';
import { mkdirSync, realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import {
  LEGACY_ACCOUNT_PROFILE_ID,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  pooledProviderLabel,
  type PooledProvider,
} from '../../../../shared/types/provider-account.types';
import { getProviderStateRoot } from '../adapter-spawn-helpers';
import { isDirectChildOf } from '../copilot/copilot-account-home-resolver';

export const CLAUDE_PROFILES_ROOT_DIR = 'claude-cli-profiles';
export const CODEX_PROFILES_ROOT_DIR = 'codex-cli-profiles';

export type AccountProfileHome = { kind: 'legacy' } | { kind: 'derived'; home: string };

export interface ResolveAccountProfileHomeOptions {
  /** Skip directory creation, for read-only callers (Doctor, binding checks). */
  createIfMissing?: boolean;
}

function profilesRootDir(provider: PooledProvider): string {
  return provider === 'claude' ? CLAUDE_PROFILES_ROOT_DIR : CODEX_PROFILES_ROOT_DIR;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Root for a provider's derived profile homes. Realpath'd when it exists. */
export function getAccountProfilesRoot(provider: PooledProvider): string {
  return realpathOrSelf(join(getProviderStateRoot(), profilesRootDir(provider)));
}

export function assertSafeAccountProfileId(profileId: string): void {
  if (!PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid account profile ID: profile IDs must be lowercase safe slugs.');
  }
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -sep.length) : path;
}

/**
 * Resolve (and by default create) the node-local home for a profile.
 *
 * @throws when the ID is unsafe or the home escapes the provider's profiles
 *         root. Errors never embed the real path: they reach surfaces that do
 *         not scrub it (mobile gateway, channel messages).
 */
export function resolveAccountProfileHome(
  params: { provider: PooledProvider; profileId: string },
  options: ResolveAccountProfileHomeOptions = {},
): AccountProfileHome {
  const { provider, profileId } = params;
  assertSafeAccountProfileId(profileId);
  if (profileId === LEGACY_ACCOUNT_PROFILE_ID) {
    return { kind: 'legacy' };
  }

  const label = pooledProviderLabel(provider);
  const root = getAccountProfilesRoot(provider);
  const home = resolve(join(root, profileId));
  if (!isDirectChildOf(root, home)) {
    throw new Error(`Refusing to use a ${label} profile home outside the profiles root for profile ${profileId}.`);
  }

  if (options.createIfMissing === false) {
    return { kind: 'derived', home: stripTrailingSeparator(realpathOrSelf(home)) };
  }

  let realHome: string;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    realHome = realpathSync(home);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `Could not prepare the ${label} profile home for ${profileId}`
      + `${code ? ` (${code})` : ''}. Check the Harness data directory is writable.`,
    );
  }
  if (!isDirectChildOf(realpathOrSelf(root), realHome)) {
    throw new Error(`${label} profile home for ${profileId} resolves outside the profiles root; refusing to use it.`);
  }
  return { kind: 'derived', home: stripTrailingSeparator(realHome) };
}

/**
 * The macOS Keychain service name Claude Code uses for a config dir: the
 * default item without `CLAUDE_CONFIG_DIR`, else suffixed with the first eight
 * hex characters of `sha256(NFC(dir))` over the raw, unexpanded string.
 * Diagnostics and the D6 usage probe only; Harness never writes this item.
 */
export function claudeKeychainServiceName(configDir: string | undefined): string {
  if (configDir === undefined) {
    return 'Claude Code-credentials';
  }
  const digest = createHash('sha256').update(configDir.normalize('NFC'), 'utf8').digest('hex');
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}
