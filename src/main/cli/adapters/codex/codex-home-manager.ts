import {
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
      try {
        const stat = lstatSync(source);
        symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
      } catch {
        logger.debug('Could not symlink codex entry', { entry });
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
