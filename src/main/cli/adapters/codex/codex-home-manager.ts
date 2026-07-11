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
import { join } from 'path';
import { getLogger } from '../../../logging/logger';
import { CodexTomlEditor } from '../../../mcp/adapters/codex-toml-editor';

const logger = getLogger('CodexHomeManager');

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
export class CodexHomeManager {
  private codexHomeDir?: string;

  /**
   * Session-isolated home with user MCP servers stripped from config.toml.
   * For exec mode, where loading user MCP tool definitions slows startup.
   */
  prepareMcpFreeHome(): string | null {
    return this.prepareHome({ stripUserMcp: true });
  }

  /**
   * Session-isolated home with config.toml mirrored untouched (user MCP
   * servers keep working). For app-server mode.
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
      const stripConfig = opts.stripUserMcp && configContent !== null && configContent.includes('[mcp_servers');

      tempDir = mkdtempSync(join(tmpdir(), opts.stripUserMcp ? 'codex-nomcp-' : 'codex-aio-'));
      if (existsSync(codexDir)) {
        this.symlinkCodexHomeEntries(codexDir, tempDir, { includeConfig: !stripConfig });
      }
      if (stripConfig) {
        writeFileSync(join(tempDir, 'config.toml'), stripMcpServers(configContent), 'utf-8');
      }
      this.linkSessionStore(tempDir);
      this.linkThreadStateStore(tempDir);

      this.codexHomeDir = tempDir;
      logger.info('Created session-isolated CODEX_HOME', { path: tempDir, mcpStripped: stripConfig });
      return tempDir;
    } catch (err) {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      logger.warn('Failed to create session-isolated CODEX_HOME', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  prepareHomeWithMcpConfig(mcpConfigToml: string): string | null {
    this.cleanup();
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');
    let tempDir: string | undefined;

    try {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-browser-mcp-'));
      if (existsSync(codexDir)) {
        this.symlinkCodexHomeEntries(codexDir, tempDir);
      }

      const configPath = join(codexDir, 'config.toml');
      const baseConfig = existsSync(configPath)
        ? stripMcpServers(readFileSync(configPath, 'utf-8')).trim()
        : '';
      const nextConfig = [baseConfig, mcpConfigToml.trim()]
        .filter(Boolean)
        .join('\n\n');
      writeFileSync(join(tempDir, 'config.toml'), nextConfig, 'utf-8');
      this.linkSessionStore(tempDir);
      this.linkThreadStateStore(tempDir);

      this.codexHomeDir = tempDir;
      logger.info('Created Browser Gateway MCP CODEX_HOME', { path: tempDir });
      return tempDir;
    } catch (err) {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
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
      if (entry === 'config.toml' && !opts.includeConfig) continue;
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
  return new CodexTomlEditor().stripMcpServers(config);
}

/** Temp-dir prefixes created by CodexHomeManager. */
const TEMP_HOME_PREFIXES = ['codex-nomcp-', 'codex-browser-mcp-', 'codex-aio-'] as const;

/**
 * Only sweep temp homes that haven't been touched for a day. Cleanup during
 * normal operation is per-instance and best-effort (`cleanup()`), so crashes
 * and force-kills leak directories; anything this old cannot belong to a
 * codex process spawned by the current app run.
 */
const STALE_TEMP_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Startup sweep for leaked temporary CODEX_HOME directories.
 * Returns the number of directories removed. Never throws.
 *
 * @param baseDir Injectable for tests — sweeping the real tmpdir with a tiny
 *   maxAgeMs in a spec could delete CODEX_HOMEs of live codex processes.
 */
export function sweepStaleCodexTempHomes(
  maxAgeMs: number = STALE_TEMP_HOME_MAX_AGE_MS,
  baseDir?: string,
): number {
  let removed = 0;
  try {
    const base = baseDir ?? tmpdir();
    for (const entry of readdirSync(base)) {
      if (!TEMP_HOME_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
      const fullPath = join(base, entry);
      try {
        const stat = lstatSync(fullPath);
        if (!stat.isDirectory()) continue;
        if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
        rmSync(fullPath, { recursive: true, force: true });
        removed++;
      } catch {
        // Best-effort per entry; a racing process or permissions issue is fine.
      }
    }
  } catch {
    // Best-effort overall — never block startup on temp cleanup.
  }
  if (removed > 0) {
    logger.info('Swept stale temporary CODEX_HOME directories', { removed });
  }
  return removed;
}
