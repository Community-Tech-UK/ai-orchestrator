import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { threadId } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { join } from 'path';
import { getLogger } from '../../../logging/logger';
import { preserveHarnessCliShellPolicy } from './codex-harness-shell-policy';
import { disableClaudeCallbackTools } from './codex-claude-mcp-policy';
import { mergeCodexMcpConfig } from './codex-mcp-config-merge';

const logger = getLogger('CodexHomeManager');
const OWNER_FILE = '.aio-codex-home-owner.json';
const activeTempHomes = new Set<string>();

function claimTempHome(directory: string): void {
  activeTempHomes.add(directory);
  writeFileSync(join(directory, OWNER_FILE), JSON.stringify({ pid: process.pid, threadId, createdAt: Date.now() }), { mode: 0o600 });
}


/**
 * Session-history artifacts inside CODEX_HOME. These are never symlinked to
 * the user's ~/.codex — they're redirected to the persistent AIO session
 * store so orchestrator-driven sessions stay out of the Codex app/CLI
 * history (the user asked for zero AIO noise there).
 */
const SESSION_ARTIFACT_DIRS = ['sessions', 'archived_sessions'] as const;
const SESSION_ARTIFACT_FILES = ['history.jsonl', 'session_index.jsonl'] as const;
const THREAD_STATE_FILES = ['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm'] as const;

/**
 * Persistent store for AIO-owned Codex session history. Lives outside
 * ~/.codex so the Codex app never lists orchestrator sessions, and outside
 * the per-instance temp homes so rollouts survive cleanup for resume.
 * Env-derived (not Electron userData) because this module also runs in
 * worker processes.
 */
export function getAioCodexStateDir(): string {
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || tmpdir();
  return join(homeDir, '.ai-orchestrator', 'codex');
}

export function getAioCodexSessionsDir(): string {
  return join(getAioCodexStateDir(), 'sessions');
}

/**
 * Creates a temporary CODEX_HOME that mirrors ~/.codex with session history
 * redirected to the persistent AIO store, and optionally with MCP server
 * config removed (exec-mode startup should not load user MCP tools).
 */
export interface CodexHomeManagerOptions {
  /** Current spawn only: never read or borrow another session's bridge environment. */
  harnessCliEnv?: Record<string, string>;
  /**
   * Account-pool profile home. When set, the prepared home links
   * `<authSourceDir>/auth.json` instead of `~/.codex/auth.json`, so the Codex
   * child signs in as that profile. Config, MCP OAuth (`.credentials.json`) and
   * everything else still come from `~/.codex`.
   */
  authSourceDir?: string;
}

export class CodexHomeManager {
  private codexHomeDir?: string;

  constructor(private readonly options: CodexHomeManagerOptions = {}) {}

  /**
   * Session-isolated home with user MCP servers stripped from config.toml.
   * For exec mode, where loading user MCP tool definitions slows startup.
   */
  prepareMcpFreeHome(): string | null {
    return this.prepareHome({ stripUserMcp: true });
  }

  /**
   * Session-isolated home retaining user MCP servers, with Claude-only
   * callback tools disabled. For app-server mode.
   */
  prepareSessionIsolatedHome(): string | null {
    return this.prepareHome({ stripUserMcp: false });
  }

  private prepareHome(opts: { stripUserMcp: boolean }): string | null {
    this.cleanup();
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');
    let tempDir: string | undefined;

    try {
      const configPath = join(codexDir, 'config.toml');
      const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
      const stripConfig = opts.stripUserMcp && configContent !== null;
      const nextConfig = preserveHarnessCliShellPolicy(
        stripConfig ? stripMcpServers(configContent) : disableClaudeCallbackTools(configContent ?? ''),
        this.options.harnessCliEnv,
      );
      const writePrivateConfig = stripConfig || nextConfig !== (configContent ?? '');

      tempDir = mkdtempSync(join(tmpdir(), opts.stripUserMcp ? 'codex-nomcp-' : 'codex-aio-'));
      claimTempHome(tempDir);
      if (existsSync(codexDir)) {
        this.symlinkCodexHomeEntries(codexDir, tempDir, { includeConfig: !writePrivateConfig });
      }
      this.linkProfileAuth(tempDir);
      if (writePrivateConfig) {
        writeFileSync(join(tempDir, 'config.toml'), nextConfig, { encoding: 'utf-8', mode: 0o600 });
      }
      this.linkSessionStore(tempDir);
      this.linkThreadStateStore(tempDir);

      this.codexHomeDir = tempDir;
      logger.info('Created session-isolated CODEX_HOME', { path: tempDir, mcpStripped: stripConfig });
      return tempDir;
    } catch (err) {
      if (tempDir) {
        activeTempHomes.delete(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
      logger.warn('Failed to create session-isolated CODEX_HOME', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  prepareHomeWithMcpConfig(mcpConfigToml: string, mode: 'app-server' | 'exec'): string | null {
    this.cleanup();
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');
    let tempDir: string | undefined;

    try {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-browser-mcp-'));
      claimTempHome(tempDir);
      if (existsSync(codexDir)) {
        this.symlinkCodexHomeEntries(codexDir, tempDir);
      }
      this.linkProfileAuth(tempDir);

      const configPath = join(codexDir, 'config.toml');
      const baseConfig = existsSync(configPath)
        ? readFileSync(configPath, 'utf-8')
        : '';
      const nextConfig = preserveHarnessCliShellPolicy(
        disableClaudeCallbackTools(mergeCodexMcpConfig(baseConfig, mcpConfigToml, mode === 'exec')), this.options.harnessCliEnv,
      );
      writeFileSync(join(tempDir, 'config.toml'), nextConfig, { encoding: 'utf-8', mode: 0o600 });
      this.linkSessionStore(tempDir);
      this.linkThreadStateStore(tempDir);

      this.codexHomeDir = tempDir;
      logger.info('Created Browser Gateway MCP CODEX_HOME', { path: tempDir });
      return tempDir;
    } catch (err) {
      if (tempDir) {
        activeTempHomes.delete(tempDir);
        rmSync(tempDir, { recursive: true, force: true });
      }
      logger.warn('Failed to create Browser Gateway MCP CODEX_HOME', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  cleanup(): void {
    if (!this.codexHomeDir) {
      return;
    }

    try {
      rmSync(this.codexHomeDir, { recursive: true, force: true });
      logger.debug('Cleaned up CODEX_HOME', { path: this.codexHomeDir });
    } catch {
      // Best-effort cleanup; OS will reclaim temp dir eventually.
    }
    activeTempHomes.delete(this.codexHomeDir);
    this.codexHomeDir = undefined;
  }

  private symlinkCodexHomeEntries(
    codexDir: string,
    tempDir: string,
    opts: { includeConfig?: boolean } = {},
  ): void {
    const isolatedArtifacts: readonly string[] = [
      ...SESSION_ARTIFACT_DIRS,
      ...SESSION_ARTIFACT_FILES,
      ...THREAD_STATE_FILES,
    ];
    for (const entry of readdirSync(codexDir)) {
      if (entry === OWNER_FILE) continue;
      if (entry === 'config.toml' && !opts.includeConfig) continue;
      // A profile-routed home takes its sign-in from the profile (linkProfileAuth).
      if (entry === 'auth.json' && this.options.authSourceDir) continue;
      // Session history is redirected to the AIO store (linkSessionStore),
      // never shared with the user's ~/.codex.
      if (isolatedArtifacts.includes(entry)) continue;

      const source = join(codexDir, entry);
      const target = join(tempDir, entry);
      let stat;
      try {
        stat = lstatSync(source);
        symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
      } catch {
        // symlinkSync needs Developer Mode / elevation on Windows and throws
        // EPERM otherwise, which would silently drop auth.json (breaking Codex
        // auth). Fall back to copying — but ONLY for regular files (auth.json,
        // version.json, …). Never recursively copy directories: ~/.codex holds
        // multi-GB session/rollout trees that would balloon disk usage on every
        // prepared home. A missing symlinked dir degrades gracefully; a filled
        // disk does not.
        if (stat?.isFile()) {
          try {
            copyFileSync(source, target);
          } catch {
            logger.debug('Could not symlink or copy codex entry', { entry });
          }
        } else {
          logger.debug('Could not symlink codex entry (dir, not copied)', { entry });
        }
      }
    }
  }

  /**
   * Links the account-pool profile's `auth.json` into the prepared home. A
   * missing profile sign-in leaves no `auth.json` at all rather than falling
   * back to `~/.codex`: running as the wrong account is worse than a clear
   * "not signed in" from Codex.
   */
  private linkProfileAuth(tempDir: string): void {
    const authSourceDir = this.options.authSourceDir;
    if (!authSourceDir) return;
    const source = join(authSourceDir, 'auth.json');
    if (!existsSync(source)) {
      logger.warn('Codex account profile has no sign-in; the session will start unauthenticated');
      return;
    }
    const target = join(tempDir, 'auth.json');
    try {
      symlinkSync(source, target, 'file');
    } catch {
      // Same Windows EPERM fallback as symlinkCodexHomeEntries.
      try {
        copyFileSync(source, target);
      } catch {
        logger.warn('Could not link the Codex account profile sign-in into the session home');
      }
    }
  }

  /**
   * Points the prepared home's session-history entries at the persistent AIO
   * store. Codex writes rollouts/history through these symlinks, so sessions
   * survive temp-home cleanup (resume keeps working) without ever touching
   * ~/.codex/sessions.
   *
   * On Windows without Developer Mode symlinkSync throws EPERM; the entries
   * are then simply absent and codex creates real ones inside the temp home.
   * Isolation still holds (no ~/.codex noise), but those sessions don't
   * survive cleanup — degrade with a warning rather than fail the spawn.
   */
  private linkSessionStore(tempDir: string): void {
    const stateDir = getAioCodexStateDir();
    for (const dir of SESSION_ARTIFACT_DIRS) {
      try {
        const target = join(stateDir, dir);
        mkdirSync(target, { recursive: true });
        symlinkSync(target, join(tempDir, dir), 'dir');
      } catch (err) {
        logger.warn('Could not link persistent codex session dir', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const file of SESSION_ARTIFACT_FILES) {
      try {
        const target = join(stateDir, file);
        mkdirSync(stateDir, { recursive: true });
        if (!existsSync(target)) {
          writeFileSync(target, '', 'utf-8');
        }
        symlinkSync(target, join(tempDir, file), 'file');
      } catch (err) {
        logger.debug('Could not link persistent codex session file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Keeps AIO thread metadata in the same private persistent boundary as its
   * rollouts. Sharing the user's state_5.sqlite makes the Codex app list AIO
   * threads whose rollout paths belong to disposable prepared homes.
   */
  private linkThreadStateStore(tempDir: string): void {
    const stateDir = getAioCodexStateDir();
    mkdirSync(stateDir, { recursive: true });

    for (const file of THREAD_STATE_FILES) {
      try {
        const target = join(stateDir, file);
        if (file === 'state_5.sqlite' && !existsSync(target)) {
          writeFileSync(target, '');
        }
        symlinkSync(target, join(tempDir, file), 'file');
      } catch (err) {
        logger.warn('Could not link private Codex thread state', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Strip all [mcp_servers.*] sections from a TOML config string.
 */
export function stripMcpServers(config: string): string {
  return mergeCodexMcpConfig(config, '', true);
}

/** Temp-dir prefixes created by CodexHomeManager. */
const TEMP_HOME_PREFIXES = ['codex-nomcp-', 'codex-browser-mcp-', 'codex-aio-'] as const;

/** Unmarked homes from older builds retain the one-day grace period. */
const STALE_TEMP_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface TempHomeOwner { pid: number; threadId: number; createdAt: number; }
export interface CodexTempHomeSweepSafety {
  isProcessAlive?: (pid: number) => boolean;
  /** Fail closed if process inspection cannot prove Codex is idle. */
  isCodexIdle?: () => boolean;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Process names only; never read command lines or process environments. */
function isCodexIdle(): boolean {
  try {
    const output = process.platform === 'win32'
      ? execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq codex*.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('pgrep', ['-ix', 'codex([.-].*)?'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return process.platform === 'win32' ? !/"codex[^"\r\n]*\.exe"/i.test(output) : output.trim() === '';
  } catch (error) {
    // pgrep returns 1 when no process matched; all other failures are unknown.
    return process.platform !== 'win32' && (error as { status?: number }).status === 1;
  }
}

function readTempHomeOwner(directory: string): TempHomeOwner | 'legacy' | 'unknown' {
  try {
    const marker = join(directory, OWNER_FILE);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024) return 'unknown';
    const owner = JSON.parse(readFileSync(marker, 'utf8')) as Partial<TempHomeOwner>;
    return Number.isSafeInteger(owner.pid) && owner.pid! > 0 && owner.pid! <= 2_147_483_647
      && Number.isSafeInteger(owner.threadId) && owner.threadId! >= 0
      && Number.isFinite(owner.createdAt) && owner.createdAt! > 0
      ? owner as TempHomeOwner : 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'legacy' : 'unknown';
  }
}

/**
 * Reclaim abandoned private homes at startup and hourly. Registry/PID ownership
 * protects active managers, including homes untouched for days. Dead owners and
 * old unmarked homes additionally require Codex to be stopped: an orphaned child
 * can outlive its Harness parent. Unknown ownership or process state is retained.
 * baseDir and safety probes let fixture tests avoid inspecting/deleting real homes.
 */
export function sweepStaleCodexTempHomes(
  maxAgeMs: number = STALE_TEMP_HOME_MAX_AGE_MS,
  baseDir?: string,
  safety: CodexTempHomeSweepSafety = {},
): number {
  let removed = 0;
  let codexIdle: boolean | undefined;
  try {
    const base = baseDir ?? tmpdir();
    for (const entry of readdirSync(base)) {
      if (!TEMP_HOME_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
      const fullPath = join(base, entry);
      try {
        const stat = lstatSync(fullPath);
        if (!stat.isDirectory() || activeTempHomes.has(fullPath)) continue;
        const owner = readTempHomeOwner(fullPath);
        if (owner === 'unknown') continue;
        if (owner === 'legacy') {
          if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
        } else if ((safety.isProcessAlive ?? isProcessAlive)(owner.pid)) continue;
        codexIdle ??= (safety.isCodexIdle ?? isCodexIdle)();
        if (!codexIdle) continue;
        rmSync(fullPath, { recursive: true, force: true });
        removed++;
      } catch {
        // A racing process or uncertain ownership must not lead to deletion.
      }
    }
  } catch {
    // Best-effort overall — never block startup on temp cleanup.
  }
  if (removed > 0) logger.info('Swept abandoned temporary CODEX_HOME directories', { removed });
  return removed;
}
