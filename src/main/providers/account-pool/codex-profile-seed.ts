/**
 * Seeds a derived Codex account-profile home (`CODEX_HOME` for `codex login`
 * and the identity probe).
 *
 * The profile home only needs to hold `auth.json`. Harness writes a
 * `config.toml` pinning `cli_auth_credentials_store = "file"` so the sign-in
 * lands in `auth.json` rather than a keyring item keyed on this directory, which
 * the per-instance temp homes could never read. Nothing else is written, and
 * `auth.json` is written by `codex login` only.
 */

import { existsSync, lstatSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CodexProfileSeed');

export const CODEX_PROFILE_CONFIG_TOML = 'cli_auth_credentials_store = "file"\n';

export function seedCodexProfileHome(home: string): { configSeeded: boolean } {
  try {
    writeFileSync(join(home, 'config.toml'), CODEX_PROFILE_CONFIG_TOML, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { configSeeded: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EEXIST') {
      logger.warn('Could not seed config for a Codex profile home', { code });
    }
    return { configSeeded: false };
  }
}

/** Whether the profile home holds a sign-in. Existence only: the file is never parsed here. */
export function codexProfileHasAuth(home: string): boolean {
  const path = join(home, 'auth.json');
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
