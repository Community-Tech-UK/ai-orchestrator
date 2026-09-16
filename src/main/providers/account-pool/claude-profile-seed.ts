/**
 * Seeds a derived Claude Code account-profile home (`CLAUDE_CONFIG_DIR`).
 *
 * A fresh config dir has no settings, commands, skills or session store, so a
 * profile-routed session would otherwise behave like a different install.
 * This links the user's shared configuration from `~/.claude` and, under the
 * `shared-store` continuation policy, the `projects/` session store, so native
 * resume can continue a conversation that started under another profile.
 *
 * `~/.claude.json` (sibling of `~/.claude/`, not inside it) holds live,
 * per-account state — `oauthAccount`, per-project trust, `numStartups` — that
 * must stay scoped to each profile, so it is never linked wholesale. Its
 * `mcpServers` key (`claude mcp add --scope user`/local, the only pieces of it
 * a Claude account doesn't already own per-profile) is merged into the
 * profile's own `.claude.json` on every seed instead, so `claude mcp add`
 * servers configured once are visible no matter which pooled account a
 * session is routed to.
 *
 * What this never does: touch `.credentials.json` or the Keychain (written by
 * `claude auth login` only), overwrite an existing entry, or follow an existing
 * symlink. Idempotent: safe to run before every login and every spawn.
 */

import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AccountContinuationMode } from '../../../shared/types/provider-account.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ClaudeProfileSeed');

/** Shared user configuration linked from `~/.claude` when present. */
export const CLAUDE_SHARED_CONFIG_ENTRIES = ['settings.json', 'CLAUDE.md', 'commands', 'skills', 'agents', 'plugins'] as const;
export const CLAUDE_SESSION_STORE_ENTRY = 'projects';
const CLAUDE_JSON_FILENAME = '.claude.json';

export interface SeedClaudeProfileHomeOptions {
  /** The legacy config dir to share from. Defaults to `~/.claude`. */
  legacyClaudeDir?: string;
  /** The legacy global state file `mcpServers` are merged from. Defaults to `~/.claude.json`. */
  legacyClaudeJsonPath?: string;
  continuation: AccountContinuationMode;
}

export interface SeedClaudeProfileHomeResult {
  linked: string[];
  onboardingSeeded: boolean;
  /** Whether this profile's `.claude.json` picked up (new or changed) shared MCP servers. */
  mcpServersSynced: boolean;
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

/** Best-effort JSON object read; a missing or unparsable file is never fatal here. */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Merges the legacy account's user/local-scope `mcpServers` into this
 * profile's `.claude.json`, preserving every other key already there
 * (identity/session state Claude Code itself owns per-profile).
 *
 * Refuses to touch an existing symlink (same invariant as `linkEntry`), and
 * refuses to guess at the file's shape if it exists but fails to parse —
 * losing a profile's own state to a torn read is worse than a stale MCP list.
 */
function syncSharedMcpServers(home: string, legacyClaudeJsonPath: string): boolean {
  const shared = readJsonObject(legacyClaudeJsonPath);
  const sharedServers = shared?.['mcpServers'];
  if (typeof sharedServers !== 'object' || sharedServers === null || Object.keys(sharedServers).length === 0) {
    return false;
  }

  const targetPath = join(home, CLAUDE_JSON_FILENAME);
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) return false; // Never write through a symlink.

  const existing = stat ? readJsonObject(targetPath) : {};
  if (stat && existing === null) {
    logger.debug('Skipping shared MCP server sync: this profile\'s .claude.json did not parse as an object');
    return false;
  }
  const merged = { hasCompletedOnboarding: true, ...existing, mcpServers: sharedServers };
  if (existing && JSON.stringify(existing['mcpServers'] ?? null) === JSON.stringify(sharedServers)) {
    return false; // Already in sync — skip the write.
  }
  try {
    writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    logger.debug('Could not sync shared MCP servers into a Claude profile home', {
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    });
    return false;
  }
}

export function seedClaudeProfileHome(home: string, options: SeedClaudeProfileHomeOptions): SeedClaudeProfileHomeResult {
  const legacyDir = options.legacyClaudeDir ?? join(homedir(), '.claude');
  const legacyClaudeJsonPath = options.legacyClaudeJsonPath ?? join(homedir(), CLAUDE_JSON_FILENAME);
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
    writeFileSync(join(home, CLAUDE_JSON_FILENAME), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, {
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

  const mcpServersSynced = syncSharedMcpServers(home, legacyClaudeJsonPath);

  return { linked, onboardingSeeded, mcpServersSynced };
}
