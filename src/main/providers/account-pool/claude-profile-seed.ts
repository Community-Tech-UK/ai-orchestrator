/**
 * Seeds a derived Claude Code account-profile home (`CLAUDE_CONFIG_DIR`).
 *
 * A fresh config dir has no settings, commands, skills or session store, so a
 * profile-routed session would otherwise behave like a different install.
 * This links the user's shared configuration from `~/.claude` and, under the
 * `shared-store` continuation policy, the `projects/` session store, so native
 * resume can continue a conversation that started under another profile.
 *
 * What this never does: touch `.credentials.json` or the Keychain (written by
 * `claude auth login` only), overwrite an existing entry, or follow an existing
 * symlink. Idempotent: safe to run before every login and every spawn.
 */

import { existsSync, lstatSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AccountContinuationMode } from '../../../shared/types/provider-account.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ClaudeProfileSeed');

/** Shared user configuration linked from `~/.claude` when present. */
export const CLAUDE_SHARED_CONFIG_ENTRIES = ['settings.json', 'CLAUDE.md', 'commands', 'skills', 'agents', 'plugins'] as const;
export const CLAUDE_SESSION_STORE_ENTRY = 'projects';

export interface SeedClaudeProfileHomeOptions {
  /** The legacy config dir to share from. Defaults to `~/.claude`. */
  legacyClaudeDir?: string;
  continuation: AccountContinuationMode;
}

export interface SeedClaudeProfileHomeResult {
  linked: string[];
  onboardingSeeded: boolean;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkEntry(source: string, target: string, isDirectory: boolean): boolean {
  if (entryExists(target)) return false; // Never replace a real file or an existing link.
  try {
    symlinkSync(source, target, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return true;
  } catch (error) {
    logger.debug('Could not link a shared Claude config entry into a profile home', {
      entry: target.split(/[\\/]/).pop(),
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    });
    return false;
  }
}

export function seedClaudeProfileHome(home: string, options: SeedClaudeProfileHomeOptions): SeedClaudeProfileHomeResult {
  const legacyDir = options.legacyClaudeDir ?? join(homedir(), '.claude');
  const linked: string[] = [];

  const entries: string[] = [...CLAUDE_SHARED_CONFIG_ENTRIES];
  if (options.continuation === 'shared-store') entries.push(CLAUDE_SESSION_STORE_ENTRY);

  for (const entry of entries) {
    const source = join(legacyDir, entry);
    if (!existsSync(source)) continue;
    let isDirectory = false;
    try {
      isDirectory = lstatSync(source).isDirectory();
    } catch {
      continue;
    }
    if (linkEntry(source, join(home, entry), isDirectory)) linked.push(entry);
  }

  // `-p` runs on a fresh config dir must not stop at first-run onboarding.
  // `wx` refuses an existing file AND an existing (even dangling) symlink.
  let onboardingSeeded = false;
  try {
    writeFileSync(join(home, '.claude.json'), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    onboardingSeeded = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
      logger.warn('Could not seed onboarding state for a Claude profile home', {
        code: (error as NodeJS.ErrnoException | undefined)?.code,
      });
    }
  }

  return { linked, onboardingSeeded };
}
