/**
 * Point a new Copilot profile at an account this machine is ALREADY signed in
 * to, so adding it does not force a second login for the same identity.
 *
 * Verified on the user's machine, 2026-08-31: the Copilot CLI keeps its tokens
 * in the OS keychain under service `copilot-cli`, keyed `<host>:<login>` — NOT
 * inside the home directory. A profile home holds only `config.json` and a log.
 * So a fresh per-profile `COPILOT_HOME` has no credentials of its own, but the
 * credential it needs already exists machine-wide; all the home has to do is
 * name the login. A profile signed in normally has a config of exactly
 * `{lastLoggedInUser, loggedInUsers}`, which is what this writes.
 *
 * What this does NOT do: write, read, copy or move a token. The keychain entry
 * is untouched. If the machine is not in fact signed in as that login, the
 * seeded config simply fails the usual binding check and the user is asked to
 * sign in — the same fail-closed path as before.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { getLogger } from '../../logging/logger';
import { resolveCopilotProfileHome } from '../../cli/adapters/copilot/copilot-account-home-resolver';
import { sharedCopilotConfigPath } from './copilot-account-discovery';
import { normalizeCopilotHost } from '../../../shared/types/copilot-account.types';

const logger = getLogger('CopilotAccountSeed');

/** Field-picked: nothing else from the shared config is read or copied. */
const sharedUserSchema = z.object({ host: z.string().optional(), login: z.string().optional() });
const sharedConfigSchema = z
  .object({
    lastLoggedInUser: sharedUserSchema.optional(),
    loggedInUsers: z.array(sharedUserSchema).optional(),
  })
  .passthrough();

function stripLineComments(input: string): string {
  return input.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The host string as the CLI itself records it, e.g. `https://github.com`.
 *
 * This matters: the keychain account is `<host>:<login>` using the CLI's own
 * scheme-bearing host, so writing our normalised bare hostname would point the
 * profile at a keychain entry that does not exist.
 */
async function cliHostFor(login: string, configPath: string): Promise<string | null> {
  try {
    const parsed = sharedConfigSchema.safeParse(
      JSON.parse(stripLineComments(await readFile(configPath, 'utf8'))) as unknown,
    );
    if (!parsed.success) return null;
    const candidates = [
      ...(parsed.data.loggedInUsers ?? []),
      ...(parsed.data.lastLoggedInUser ? [parsed.data.lastLoggedInUser] : []),
    ];
    const match = candidates.find(
      (entry) => entry.login && entry.login.toLowerCase() === login.toLowerCase() && entry.host,
    );
    return match?.host ?? null;
  } catch {
    return null;
  }
}

export interface SeedCopilotProfileIdentityOptions {
  configPath?: string;
  /** Injectable for tests; defaults to the real resolver. */
  resolveHome?: (profileId: string) => string;
}

/**
 * Returns true when the profile home was seeded.
 *
 * Never overwrites an existing `config.json` — a profile that has been signed
 * in has real state there, and clobbering it would log the user out.
 */
export async function seedCopilotProfileIdentity(
  profileId: string,
  login: string,
  options: SeedCopilotProfileIdentityOptions = {},
): Promise<boolean> {
  const sharedPath = options.configPath ?? sharedCopilotConfigPath();
  const host = await cliHostFor(login, sharedPath);
  if (!host) {
    // Not an account this machine is signed in to; nothing to inherit.
    return false;
  }

  const home = (options.resolveHome ?? ((id: string) => resolveCopilotProfileHome(id)))(profileId);
  const configPath = join(home, 'config.json');
  try {
    await readFile(configPath, 'utf8');
    return false; // Already has state — leave it alone.
  } catch {
    /* absent, which is the case we seed */
  }

  const body = `${JSON.stringify(
    { lastLoggedInUser: { host, login }, loggedInUsers: [{ host, login }] },
    null,
    2,
  )}\n`;
  const tmpPath = `${configPath}.tmp`;
  try {
    // Written 0600 and renamed into place: the file names an identity, and a
    // partially-written config would read as a corrupt profile.
    await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, configPath);
    logger.info('Seeded a Copilot profile with an identity this machine already holds', {
      profileId,
    });
    return true;
  } catch (error) {
    // Never fatal: the profile still works, it just needs its own sign-in.
    logger.warn('Could not seed the Copilot profile identity; sign-in will be required', {
      profileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Exported for the binding check's benefit: the seeded host, normalised. */
export function seededHostMatches(host: string, profileHost: string): boolean {
  return normalizeCopilotHost(host) === normalizeCopilotHost(profileHost);
}
