import {
  copyFileSync,
  existsSync,
  lstatSync,
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
 * Creates a temporary CODEX_HOME that mirrors ~/.codex but removes MCP server
 * config. This keeps exec-mode startup from loading user MCP tool definitions.
 */
export class CodexHomeManager {
  private codexHomeDir?: string;

  prepareMcpFreeHome(): string | null {
    this.cleanup();
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');

    if (!existsSync(codexDir)) {
      logger.debug('No ~/.codex directory found, skipping CODEX_HOME override');
      return null;
    }

    const configPath = join(codexDir, 'config.toml');
    if (!existsSync(configPath)) {
      logger.debug('No ~/.codex/config.toml found, skipping CODEX_HOME override');
      return null;
    }

    const configContent = readFileSync(configPath, 'utf-8');
    if (!configContent.includes('[mcp_servers')) {
      logger.debug('No MCP servers in config, skipping CODEX_HOME override');
      return null;
    }

    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'codex-nomcp-'));
      this.symlinkCodexHomeEntries(codexDir, tempDir);
      writeFileSync(join(tempDir, 'config.toml'), stripMcpServers(configContent), 'utf-8');

      this.codexHomeDir = tempDir;
      logger.info('Created MCP-free CODEX_HOME', { path: tempDir });
      return tempDir;
    } catch (err) {
      logger.warn('Failed to create clean CODEX_HOME, MCP servers may cause latency', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  prepareHomeWithMcpConfig(mcpConfigToml: string): string | null {
    this.cleanup();
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');

    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'codex-browser-mcp-'));
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

      this.codexHomeDir = tempDir;
      logger.info('Created Browser Gateway MCP CODEX_HOME', { path: tempDir });
      return tempDir;
    } catch (err) {
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

  private symlinkCodexHomeEntries(codexDir: string, tempDir: string): void {
    for (const entry of readdirSync(codexDir)) {
      if (entry === 'config.toml') continue;

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
}

/**
 * Strip all [mcp_servers.*] sections from a TOML config string.
 */
export function stripMcpServers(config: string): string {
  return new CodexTomlEditor().stripMcpServers(config);
}

/** Temp-dir prefixes created by CodexHomeManager. */
const TEMP_HOME_PREFIXES = ['codex-nomcp-', 'codex-browser-mcp-'] as const;

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
