import { spawn, type SpawnOptions } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getProviderStateRoot } from '../../cli/adapters/adapter-spawn-helpers';
import { assertSafeAccountProfileId, CODEX_PROFILES_ROOT_DIR } from '../../cli/adapters/account-pool/provider-account-home-resolver';
import { CODEX_PROFILE_CONFIG_TOML } from './codex-profile-seed';
import type { CodexDeviceLoginChild } from './codex-device-login';

/** Exclusive creation: never adopt or modify an existing profile, even an empty one. */
export function prepareCodexDeviceLoginHome(profileId: string): string {
  try { assertSafeAccountProfileId(profileId); } catch { throw new Error('fresh_profile_required'); }
  if (profileId === 'legacy') throw new Error('fresh_profile_required');
  try {
    // The configured state root is trusted; canonicalization preserves OS aliases such as /var.
    // Only our derived profiles root and newly created home are subject to the no-symlink rule.
    const root = join(realpathSync(getProviderStateRoot()), CODEX_PROFILES_ROOT_DIR);
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_root');
    const home = join(root, profileId);
    try { mkdirSync(home, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('fresh_profile_required');
      throw error;
    }
    writeFileSync(join(home, 'config.toml'), CODEX_PROFILE_CONFIG_TOML, { flag: 'wx', mode: 0o600 });
    return home;
  } catch (error) {
    throw new Error(error instanceof Error && error.message === 'fresh_profile_required'
      ? 'fresh_profile_required' : 'profile_preparation_failed');
  }
}

export function codexDeviceLoginSpawnOptions(home: string): SpawnOptions {
  // Native executable only. No inherited auth, issuer, proxy, debug, or runtime injection.
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  env['CODEX_HOME'] = home;
  return { cwd: home, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
}

/** The composition root supplies a discovered native binary, never a model command or npm shim. */
export function spawnCodexDeviceLogin(executable: string, home: string): CodexDeviceLoginChild {
  if (!isAbsolute(executable) || /\.(?:cmd|bat|js|mjs|cjs)$/i.test(executable)) {
    throw new Error('native_executable_required');
  }
  try {
    const child = spawn(executable, ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth'], codexDeviceLoginSpawnOptions(home));
    if (!child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      throw new Error('login_spawn_failed');
    }
    return Object.assign(child, { stdout: child.stdout, stderr: child.stderr });
  } catch { throw new Error('login_spawn_failed'); }
}
