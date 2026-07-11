import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { buildCliSpawnOptions } from './cli-environment';

/**
 * Resolve a bare command name to a concrete path using the platform path
 * resolver (`which` on POSIX, `where` on Windows), run with the app's augmented
 * CLI PATH.
 *
 * Why this exists: `child_process.spawn` on POSIX resolves the executable
 * against the *parent* process's PATH, NOT the `env.PATH` we hand it via
 * buildCliSpawnOptions. A packaged-Electron app frequently starts with a
 * stripped PATH, so a bare `agy`/`cursor-agent`/etc. spawn fails to locate an
 * install that lives in nvm, ~/.local/bin, Homebrew, or any other dir the user's
 * login shell adds — even though our spawn env lists those dirs. Running
 * `which`/`where` (which reads PATH from the env we pass it) returns the real
 * absolute path, which callers can then spawn directly.
 *
 * Returns the resolved path, or null when the command is not found. If an
 * absolute/relative path (containing a separator) is passed and it exists on
 * disk, it is returned unchanged.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if ((command.includes('/') || command.includes('\\')) && existsSync(command)) {
    return command;
  }

  const pathResolver = platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(pathResolver, [command], {
    encoding: 'utf8',
    ...buildCliSpawnOptions(env, platform),
  });

  if (result.status !== 0) {
    return null;
  }

  // `where` can return multiple matches (one per line); take the first.
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}
