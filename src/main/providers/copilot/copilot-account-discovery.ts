/**
 * Discover GitHub accounts Copilot is already signed in to on this machine.
 *
 * Why this exists: the shared Copilot home (`~/.copilot`) already lists every
 * account the user has authenticated, and their tokens already sit in the OS
 * keychain keyed by `host:login`. Making someone hand-type an account Harness
 * could simply see was pointless friction — and it invited typos in exactly the
 * field (host/login) that identity verification then rejects.
 *
 * This reads bounded identity metadata ONLY. It never returns, copies, or logs
 * a token, and it never writes to the shared home — reading it is safe;
 * *routing* through it is what the whole feature refuses to do.
 */

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { normalizeCopilotHost } from '../../../shared/types/copilot-account.types';
import { getLogger } from '../../logging/logger';
import { MAX_COPILOT_CONFIG_BYTES } from './copilot-account-binding-service';

const logger = getLogger('CopilotAccountDiscovery');

export interface DiscoveredCopilotAccount {
  login: string;
  host: string;
  /** True when a Harness profile is already bound to this identity. */
  alreadyAdded: boolean;
}

/** Field-picking, non-passthrough: `copilotTokens` cannot survive this parse. */
const identitySchema = z
  .object({
    host: z.string().min(1).max(253).optional(),
    login: z.string().min(1).max(64).optional(),
  })
  .transform((value) => ({ host: value.host, login: value.login }));

const configSchema = z.object({
  lastLoggedInUser: identitySchema.optional().catch(undefined),
  loggedInUsers: z.array(identitySchema).max(64).optional().catch(undefined),
});

function stripLineComments(input: string): string {
  return input.replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The shared Copilot home. Read-only, and never used for routing. */
export function sharedCopilotConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['COPILOT_HOME']?.trim();
  return join(explicit || join(homedir(), '.copilot'), 'config.json');
}

export interface DiscoverCopilotAccountsOptions {
  configPath?: string;
  /**
   * Profiles Harness already has, as `{login, label, host}`.
   *
   * `label` matters as much as `login`: a profile added from a suggestion
   * before the login was recorded has `expectedLogin: null`, and matching on
   * login alone made discovery offer that same account again forever — the
   * duplicate `LAWRENCJ_PE1` row with an [Add] button beside the real one.
   * Recording the login on create fixed new profiles; matching the label as
   * well is what heals the ones already on disk.
   */
  existing?: { login: string | null; label?: string; host: string }[];
}

export async function discoverCopilotAccounts(
  options: DiscoverCopilotAccountsOptions = {},
): Promise<DiscoveredCopilotAccount[]> {
  const configPath = options.configPath ?? sharedCopilotConfigPath();
  try {
    const stats = await stat(configPath);
    if (stats.size > MAX_COPILOT_CONFIG_BYTES) {
      return [];
    }
    const parsed = configSchema.safeParse(
      JSON.parse(stripLineComments(await readFile(configPath, 'utf8'))) as unknown,
    );
    if (!parsed.success) {
      return [];
    }

    const taken = new Set<string>();
    for (const entry of options.existing ?? []) {
      const host = normalizeCopilotHost(entry.host);
      // Either identifier is enough to mean "Harness already has this one".
      if (entry.login) taken.add(`${host}:${entry.login.toLowerCase()}`);
      if (entry.label) taken.add(`${host}:${entry.label.trim().toLowerCase()}`);
    }

    const seen = new Set<string>();
    const found: DiscoveredCopilotAccount[] = [];
    for (const candidate of [
      ...(parsed.data.loggedInUsers ?? []),
      ...(parsed.data.lastLoggedInUser ? [parsed.data.lastLoggedInUser] : []),
    ]) {
      const login = candidate.login?.trim();
      if (!login) continue;
      const host = normalizeCopilotHost(candidate.host) || 'github.com';
      const key = `${host}:${login.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ login, host, alreadyAdded: taken.has(key) });
    }
    return found;
  } catch (error) {
    // An absent or unreadable shared home simply means nothing to suggest.
    logger.debug('No discoverable Copilot accounts', {
      reason: (error as { code?: string } | null)?.code ?? 'unreadable',
    });
    return [];
  }
}
