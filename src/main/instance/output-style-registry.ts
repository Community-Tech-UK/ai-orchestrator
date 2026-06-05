/**
 * User-defined output-style loader (claude2_todo #29).
 *
 * Built-in output styles live in `output-style.ts`. This registry adds
 * **user-authored** styles discovered from markdown files, so a user can define
 * their own communication style — and, unlike the append-only built-ins, opt
 * into a full-prompt-swap (`mode: replace`).
 *
 * Locations (mirrors the agent/command markdown loaders):
 *   - `~/.orchestrator/output-styles/**.md`
 *   - `~/.claude/output-styles/**.md`
 *   - `<project-scan-root>/.orchestrator/output-styles/**.md`
 *   - `<project-scan-root>/.claude/output-styles/**.md`
 *
 * File format: optional YAML frontmatter (`label`, `mode`, `description`,
 * `name`) + a markdown body that becomes the directive/prompt text. The style
 * name defaults to the file path (relative, `:`-joined, sans `.md`).
 *
 * Built-in names are reserved: a user file named after a built-in is ignored so
 * the curated built-ins can never be silently broken.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import { parseMarkdownFrontmatter } from '../../shared/utils/markdown-frontmatter';
import { resolveProjectScanRoots } from '../util/project-scan-roots';
import {
  isOutputStyleName,
  type OutputStyleMode,
  type ResolvedOutputStyle,
} from './output-style';

const logger = getLogger('OutputStyleRegistry');

interface OutputStyleFrontmatter extends Record<string, unknown> {
  name?: unknown;
  label?: unknown;
  mode?: unknown;
  description?: unknown;
}

export interface UserOutputStyle extends ResolvedOutputStyle {
  source: 'user';
  filePath: string;
  description?: string;
}

interface CacheEntry {
  styles: UserOutputStyle[];
  scanDirs: string[];
}

function parseMode(value: unknown): OutputStyleMode {
  return value === 'replace' ? 'replace' : 'append';
}

export class OutputStyleRegistry {
  private static instance: OutputStyleRegistry | null = null;
  private cacheByWorkingDir = new Map<string, CacheEntry>();

  static getInstance(): OutputStyleRegistry {
    if (!OutputStyleRegistry.instance) {
      OutputStyleRegistry.instance = new OutputStyleRegistry();
    }
    return OutputStyleRegistry.instance;
  }

  static _resetForTesting(): void {
    OutputStyleRegistry.instance = null;
  }

  private getHomeDir(): string | null {
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getStyleDirs(root: string): string[] {
    return [
      path.join(root, '.orchestrator', 'output-styles'),
      path.join(root, '.claude', 'output-styles'),
    ];
  }

  private getAllScanDirs(workingDirectory: string): string[] {
    const home = this.getHomeDir();
    const roots = [...(home ? [home] : []), ...resolveProjectScanRoots(workingDirectory, home)];
    const dirs: string[] = [];
    for (const root of roots) {
      dirs.push(...this.getStyleDirs(root));
    }
    return dirs;
  }

  private async walkMarkdownFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          out.push(full);
        }
      }
    }
    return out;
  }

  private deriveName(styleDir: string, filePath: string): string {
    const rel = path.relative(styleDir, filePath).replace(/\.md$/i, '');
    return rel.split(path.sep).filter(Boolean).join(':');
  }

  private async loadFromDirs(workingDirectory: string): Promise<CacheEntry> {
    const scanDirs = this.getAllScanDirs(workingDirectory);
    const styles: UserOutputStyle[] = [];
    const seen = new Set<string>();

    for (const dir of scanDirs) {
      const files = await this.walkMarkdownFiles(dir);
      for (const filePath of files) {
        let raw: string;
        try {
          raw = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
          logger.warn('Failed to read output-style file', { filePath, error: String(err) });
          continue;
        }
        const { data, content } = parseMarkdownFrontmatter<OutputStyleFrontmatter>(raw);
        const fmName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined;
        const name = fmName ?? this.deriveName(dir, filePath);
        const directive = content.trim();

        if (!name || !directive) {
          // A style with no name or empty body is unusable — skip it.
          continue;
        }
        if (isOutputStyleName(name)) {
          // Built-in names are reserved; never let a user file shadow a built-in.
          logger.warn('Ignoring user output style that collides with a built-in name', { name, filePath });
          continue;
        }
        if (seen.has(name)) {
          // Earlier scan dirs (home before project) win; keep the first.
          continue;
        }
        seen.add(name);

        const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim() : name;
        const description = typeof data.description === 'string' ? data.description : undefined;
        styles.push({
          name,
          label,
          directive,
          mode: parseMode(data.mode),
          source: 'user',
          filePath,
          ...(description ? { description } : {}),
        });
      }
    }

    styles.sort((a, b) => a.name.localeCompare(b.name));
    return { styles, scanDirs };
  }

  private async getEntry(workingDirectory: string): Promise<CacheEntry> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    if (cached) return cached;
    const entry = await this.loadFromDirs(workingDirectory);
    this.cacheByWorkingDir.set(workingDirectory, entry);
    return entry;
  }

  /**
   * Resolve a user-defined style by name for a working directory. Returns null
   * for unknown names and for built-in names (callers resolve built-ins first).
   */
  async resolveUserStyle(workingDirectory: string, name: string): Promise<UserOutputStyle | null> {
    if (!name || isOutputStyleName(name)) return null;
    const entry = await this.getEntry(workingDirectory);
    return entry.styles.find((s) => s.name === name) ?? null;
  }

  /** List the user styles discovered for a working directory (for pickers / ecosystem list). */
  async listUserStyles(workingDirectory: string): Promise<{ styles: UserOutputStyle[]; scanDirs: string[] }> {
    const entry = await this.getEntry(workingDirectory);
    return { styles: entry.styles.slice(), scanDirs: entry.scanDirs.slice() };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
  }
}

export function getOutputStyleRegistry(): OutputStyleRegistry {
  return OutputStyleRegistry.getInstance();
}
