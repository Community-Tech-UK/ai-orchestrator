/**
 * Markdown Command Registry
 *
 * Loads slash commands from markdown files with YAML frontmatter.
 * This is intentionally "in-repo" (no dependency on other project directories).
 *
 * Supported locations (global + project ancestry):
 * - `~/.orchestrator/commands/**.md`
 * - `~/.claude/commands/**.md`
 * - `~/.opencode/command/**.md` and `~/.opencode/commands/**.md`
 * - `<project-scan-root>/.orchestrator/commands/**.md`
 * - `<project-scan-root>/.claude/commands/**.md`
 * - `<project-scan-root>/.opencode/command/**.md` and `<project-scan-root>/.opencode/commands/**.md`
 *
 * Project scan roots run from the repository root (when available) down to the
 * active working directory. Later sources override earlier ones by command name.
 */

import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  COMMAND_CATEGORIES,
  createMarkdownCommandId,
  type CommandApplicability,
  type CommandCategory,
  type CommandDiagnostic,
  type CommandRankHints,
  type CommandTemplate,
} from '../../shared/types/command.types';
import { parseMarkdownFrontmatter } from '../../shared/utils/markdown-frontmatter';
import { resolveProjectScanRoots } from '../util/project-scan-roots';

type CommandFrontmatter = {
  name?: string;
  description?: string;
  'argument-hint'?: string;
  argumentHint?: string;
  hint?: string;
  model?: string;
  agent?: string;
  subtask?: boolean;
  aliases?: unknown;
  category?: unknown;
  usage?: unknown;
  examples?: unknown;
  applicability?: unknown;
  disabledReason?: unknown;
  rankHints?: unknown;
};

interface CacheEntry {
  loadedAt: number;
  commandsByName: Map<string, CommandTemplate>;
  candidatesByName: Map<string, CommandTemplate[]>;
  diagnostics: CommandDiagnostic[];
  scanDirs: string[];
}

const CACHE_TTL_MS = 10_000;

export class MarkdownCommandRegistry {
  private static instance: MarkdownCommandRegistry | null = null;

  // Cache per working directory, because project-level commands are scoped.
  private cacheByWorkingDir = new Map<string, CacheEntry>();

  /**
   * Per-directory mtime cache.  Keyed by absolute directory path.
   * Populated after each successful directory walk; used to skip re-walking
   * unchanged directories within the TTL window.
   */
  private dirMtimeCache = new Map<string, number>();

  static getInstance(): MarkdownCommandRegistry {
    if (!MarkdownCommandRegistry.instance) {
      MarkdownCommandRegistry.instance = new MarkdownCommandRegistry();
    }
    return MarkdownCommandRegistry.instance;
  }

  static _resetForTesting(): void {
    MarkdownCommandRegistry.instance = null;
  }

  private constructor() {}

  private getHomeDir(): string | null {
    // `app.getPath('home')` is safe after app is ready; fall back to env for tests.
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getScanRoots(workingDirectory: string): string[] {
    const home = this.getHomeDir();
    return [
      ...(home ? [home] : []),
      ...resolveProjectScanRoots(workingDirectory, home),
    ];
  }

  private getCommandDirs(root: string): string[] {
    // Keep this explicit and predictable. Later entries override earlier ones.
    return [
      path.join(root, '.orchestrator', 'commands'),
      path.join(root, '.orchestrator', 'command'),
      path.join(root, '.claude', 'commands'),
      path.join(root, '.claude', 'command'),
      path.join(root, '.opencode', 'commands'),
      path.join(root, '.opencode', 'command'),
    ];
  }

  private getAllScanDirs(workingDirectory: string): string[] {
    const dirs: string[] = [];
    for (const root of this.getScanRoots(workingDirectory)) {
      dirs.push(...this.getCommandDirs(root));
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
          // Avoid accidentally scanning huge trees if someone misconfigures.
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

  private deriveNameFromPath(commandsDir: string, filePath: string): string {
    const rel = path.relative(commandsDir, filePath);
    const withoutExt = rel.replace(/\.md$/i, '');
    // Use ":" instead of "/" so users can type `/foo:bar` (common convention in CLIs).
    return withoutExt.split(path.sep).filter(Boolean).join(':');
  }

  private extractHeadingTitle(markdown: string): string | null {
    const firstLine = (markdown || '').split('\n')[0] || '';
    const m = firstLine.match(/^#{1,6}\s+(.+)\s*$/);
    return m?.[1]?.trim() || null;
  }

  private collectInvalidType(
    diagnostics: CommandDiagnostic[],
    filePath: string,
    field: string,
    expected: string,
  ): void {
    diagnostics.push({
      code: 'invalid-frontmatter-type',
      severity: 'warn',
      filePath,
      message: `Invalid frontmatter field "${field}": expected ${expected}`,
    });
  }

  private parseStringArray(
    value: unknown,
    field: string,
    filePath: string,
    diagnostics: CommandDiagnostic[],
  ): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      this.collectInvalidType(diagnostics, filePath, field, 'an array of strings');
      return undefined;
    }
    const values = value.map((item) => item.trim()).filter(Boolean);
    return values.length > 0 ? values : undefined;
  }

  private parseCategory(
    value: unknown,
    filePath: string,
    diagnostics: CommandDiagnostic[],
  ): CommandCategory | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      this.collectInvalidType(diagnostics, filePath, 'category', 'a string');
      return undefined;
    }
    if (!(COMMAND_CATEGORIES as readonly string[]).includes(value)) {
      diagnostics.push({
        code: 'unknown-category',
        severity: 'warn',
        filePath,
        message: `Unknown command category "${value}"`,
      });
      return undefined;
    }
    return value as CommandCategory;
  }

  private parseApplicability(
    value: unknown,
    filePath: string,
    diagnostics: CommandDiagnostic[],
  ): CommandApplicability | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.collectInvalidType(diagnostics, filePath, 'applicability', 'an object');
      return undefined;
    }

    const allowed = new Set([
      'provider',
      'instanceStatus',
      'requiresWorkingDirectory',
      'requiresGitRepo',
      'featureFlag',
      'hideWhenIneligible',
    ]);
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        diagnostics.push({
          code: 'unknown-applicability-key',
          severity: 'warn',
          filePath,
          message: `Unknown applicability key "${key}"`,
        });
      }
    }

    const applicability: CommandApplicability = {};
    if (typeof raw['provider'] === 'string') {
      applicability.provider = raw['provider'] as CommandApplicability['provider'];
    } else if (Array.isArray(raw['provider']) && raw['provider'].every((item) => typeof item === 'string')) {
      applicability.provider = raw['provider'] as CommandApplicability['provider'];
    } else if (raw['provider'] !== undefined) {
      this.collectInvalidType(diagnostics, filePath, 'applicability.provider', 'a string or array of strings');
    }

    if (typeof raw['instanceStatus'] === 'string') {
      applicability.instanceStatus = raw['instanceStatus'] as CommandApplicability['instanceStatus'];
    } else if (Array.isArray(raw['instanceStatus']) && raw['instanceStatus'].every((item) => typeof item === 'string')) {
      applicability.instanceStatus = raw['instanceStatus'] as CommandApplicability['instanceStatus'];
    } else if (raw['instanceStatus'] !== undefined) {
      this.collectInvalidType(diagnostics, filePath, 'applicability.instanceStatus', 'a string or array of strings');
    }

    for (const key of ['requiresWorkingDirectory', 'requiresGitRepo', 'hideWhenIneligible'] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] === 'boolean') {
        applicability[key] = raw[key];
      } else {
        this.collectInvalidType(diagnostics, filePath, `applicability.${key}`, 'a boolean');
      }
    }

    if (raw['featureFlag'] !== undefined) {
      if (typeof raw['featureFlag'] === 'string') {
        applicability.featureFlag = raw['featureFlag'];
      } else {
        this.collectInvalidType(diagnostics, filePath, 'applicability.featureFlag', 'a string');
      }
    }

    return Object.keys(applicability).length > 0 ? applicability : undefined;
  }

  private parseRankHints(
    value: unknown,
    filePath: string,
    diagnostics: CommandDiagnostic[],
  ): CommandRankHints | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      diagnostics.push({
        code: 'invalid-rank-hints',
        severity: 'warn',
        filePath,
        message: 'Invalid rankHints: expected an object',
      });
      return undefined;
    }

    const raw = value as Record<string, unknown>;
    const hints: CommandRankHints = {};
    if (raw['pinned'] !== undefined) {
      if (typeof raw['pinned'] === 'boolean') {
        hints.pinned = raw['pinned'];
      } else {
        diagnostics.push({
          code: 'invalid-rank-hints',
          severity: 'warn',
          filePath,
          message: 'Invalid rankHints.pinned: expected a boolean',
        });
      }
    }
    if (raw['providerAffinity'] !== undefined) {
      if (Array.isArray(raw['providerAffinity']) && raw['providerAffinity'].every((item) => typeof item === 'string')) {
        hints.providerAffinity = raw['providerAffinity'] as CommandRankHints['providerAffinity'];
      } else {
        diagnostics.push({
          code: 'invalid-rank-hints',
          severity: 'warn',
          filePath,
          message: 'Invalid rankHints.providerAffinity: expected an array of strings',
        });
      }
    }
    if (raw['weight'] !== undefined) {
      if (typeof raw['weight'] === 'number' && Number.isFinite(raw['weight'])) {
        hints.weight = Math.min(Math.max(raw['weight'], 0), 3);
      } else {
        diagnostics.push({
          code: 'invalid-rank-hints',
          severity: 'warn',
          filePath,
          message: 'Invalid rankHints.weight: expected a finite number',
        });
      }
    }
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  private toCommandTemplate(params: {
    name: string;
    template: string;
    description: string;
    hint?: string;
    filePath: string;
    model?: string;
    agent?: string;
    subtask?: boolean;
    priority?: number;
    aliases?: string[];
    category?: CommandCategory;
    usage?: string;
    examples?: string[];
    applicability?: CommandApplicability;
    disabledReason?: string;
    rankHints?: CommandRankHints;
  }): CommandTemplate {
    const now = Date.now();
    return {
      id: createMarkdownCommandId(params.name),
      name: params.name,
      description: params.description,
      template: params.template,
      hint: params.hint,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
      source: 'file',
      filePath: params.filePath,
      model: params.model,
      agent: params.agent,
      subtask: params.subtask,
      priority: params.priority,
      aliases: params.aliases,
      category: params.category ?? 'custom',
      usage: params.usage,
      examples: params.examples,
      applicability: params.applicability,
      disabledReason: params.disabledReason,
      rankHints: params.rankHints,
    };
  }

  private computeCollisionDiagnostics(
    commandsByName: Map<string, CommandTemplate>,
    candidatesByName: Map<string, CommandTemplate[]>,
  ): CommandDiagnostic[] {
    const diagnostics: CommandDiagnostic[] = [];
    for (const [name, candidates] of candidatesByName.entries()) {
      if (candidates.length > 1) {
        diagnostics.push({
          code: 'name-collision',
          severity: 'warn',
          message: `Multiple markdown commands define "/${name}"; highest-priority source wins.`,
          commandId: commandsByName.get(name)?.id,
          candidates: candidates.map((candidate) => candidate.filePath || candidate.id),
        });
      }
    }

    const names = new Map<string, CommandTemplate>();
    for (const command of commandsByName.values()) {
      names.set(command.name.toLowerCase(), command);
    }

    const aliases = new Map<string, CommandTemplate[]>();
    for (const command of commandsByName.values()) {
      for (const alias of command.aliases ?? []) {
        const key = alias.toLowerCase();
        const existing = aliases.get(key) ?? [];
        existing.push(command);
        aliases.set(key, existing);
      }
    }

    for (const [alias, ownerList] of aliases.entries()) {
      const shadow = names.get(alias);
      if (shadow && ownerList.some((owner) => owner.id !== shadow.id)) {
        diagnostics.push({
          code: 'alias-shadowed-by-name',
          severity: 'warn',
          alias,
          commandId: shadow.id,
          message: `Alias "${alias}" is shadowed by command "/${shadow.name}"`,
          candidates: [shadow.id, ...ownerList.map((owner) => owner.id)],
        });
      }
      const uniqueOwners = [...new Map(ownerList.map((owner) => [owner.id, owner])).values()];
      if (uniqueOwners.length > 1) {
        diagnostics.push({
          code: 'alias-collision',
          severity: 'warn',
          alias,
          message: `Alias "${alias}" is defined by multiple markdown commands`,
          candidates: uniqueOwners.map((owner) => owner.id),
        });
      }
    }

    return diagnostics;
  }

  private async loadCommandsForWorkingDirectory(workingDirectory: string): Promise<Map<string, CommandTemplate>> {
    const commandsByName = new Map<string, CommandTemplate>();
    const candidatesByName = new Map<string, CommandTemplate[]>();
    const diagnostics: CommandDiagnostic[] = [];

    const roots = this.getScanRoots(workingDirectory);
    // Load low-to-high priority so later wins.  sourcePriority increments per
    // directory so each directory's commands carry a distinct priority level.
    let sourcePriority = 0;
    for (const root of roots) {
      const dirs = this.getCommandDirs(root);
      for (const commandsDir of dirs) {
        // Per-directory mtime optimisation: stat the directory and skip
        // re-walking if the mtime is unchanged since the last scan.
        let currentMtime: number | undefined;
        try {
          const statResult: Stats = await fs.stat(commandsDir);
          currentMtime = statResult.mtimeMs;
        } catch {
          // Directory does not exist — skip.
          sourcePriority++;
          continue;
        }

        const cachedMtime = this.dirMtimeCache.get(commandsDir);
        if (cachedMtime !== undefined && cachedMtime === currentMtime) {
          // Mtime unchanged — reuse already-loaded commands for this directory
          // by re-inserting candidates from the existing cache entry if present.
          const existing = this.cacheByWorkingDir.get(workingDirectory);
          if (existing) {
            for (const [name, candidates] of existing.candidatesByName.entries()) {
              for (const cmd of candidates) {
                if (cmd.filePath?.startsWith(commandsDir + path.sep) ||
                    cmd.filePath?.startsWith(commandsDir + '/')) {
                  const existingCandidates = candidatesByName.get(name) || [];
                  existingCandidates.push(cmd);
                  candidatesByName.set(name, existingCandidates);
                  commandsByName.set(name, cmd);
                }
              }
            }
          }
          sourcePriority++;
          continue;
        }

        const files = await this.walkMarkdownFiles(commandsDir);
        // Update the mtime cache for this directory after walking.
        if (currentMtime !== undefined) {
          this.dirMtimeCache.set(commandsDir, currentMtime);
        }

        for (const filePath of files) {
          let raw: string;
          try {
            raw = await fs.readFile(filePath, 'utf-8');
          } catch {
            continue;
          }

          const parsed = parseMarkdownFrontmatter<CommandFrontmatter>(raw);
          const content = parsed.content.trim();
          if (!content) continue;

          const derivedName = this.deriveNameFromPath(commandsDir, filePath);
          const explicitName =
            typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
          const name = explicitName || derivedName;
          if (!name) continue;

          const title = this.extractHeadingTitle(content);
          const description =
            (typeof parsed.data.description === 'string' && parsed.data.description.trim()) ||
            title ||
            `Custom command: ${name}`;

          const hint =
            (parsed.data['argument-hint'] as string | undefined) ||
            parsed.data.argumentHint ||
            parsed.data.hint;

          const template = content;

          const model = typeof parsed.data.model === 'string' ? parsed.data.model : undefined;
          const agent = typeof parsed.data.agent === 'string' ? parsed.data.agent : undefined;
          const subtask = typeof parsed.data.subtask === 'boolean' ? parsed.data.subtask : undefined;
          const aliases = this.parseStringArray(parsed.data.aliases, 'aliases', filePath, diagnostics);
          const category = this.parseCategory(parsed.data.category, filePath, diagnostics);
          const usage = typeof parsed.data.usage === 'string' ? parsed.data.usage : undefined;
          if (parsed.data.usage !== undefined && typeof parsed.data.usage !== 'string') {
            this.collectInvalidType(diagnostics, filePath, 'usage', 'a string');
          }
          const examples = this.parseStringArray(parsed.data.examples, 'examples', filePath, diagnostics);
          const applicability = this.parseApplicability(parsed.data.applicability, filePath, diagnostics);
          const disabledReason = typeof parsed.data.disabledReason === 'string' ? parsed.data.disabledReason : undefined;
          if (parsed.data.disabledReason !== undefined && typeof parsed.data.disabledReason !== 'string') {
            this.collectInvalidType(diagnostics, filePath, 'disabledReason', 'a string');
          }
          const rankHints = this.parseRankHints(parsed.data.rankHints, filePath, diagnostics);

          const cmd = this.toCommandTemplate({
            name,
            template,
            description,
            hint,
            filePath,
            model,
            agent,
            subtask,
            priority: sourcePriority,
            aliases,
            category,
            usage,
            examples,
            applicability,
            disabledReason,
            rankHints,
          });

          const existing = candidatesByName.get(name) || [];
          existing.push(cmd);
          candidatesByName.set(name, existing);
          commandsByName.set(name, cmd);
        }

        sourcePriority++;
      }
    }

    const scanDirs = this.getAllScanDirs(workingDirectory);
    this.cacheByWorkingDir.set(workingDirectory, {
      loadedAt: Date.now(),
      commandsByName,
      candidatesByName,
      diagnostics: [...diagnostics, ...this.computeCollisionDiagnostics(commandsByName, candidatesByName)],
      scanDirs,
    });
    return commandsByName;
  }

  async getCommand(workingDirectory: string, name: string): Promise<CommandTemplate | undefined> {
    const cacheKey = workingDirectory;
    const cached = this.cacheByWorkingDir.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
      return cached.commandsByName.get(name);
    }

    await this.loadCommandsForWorkingDirectory(workingDirectory);
    return this.cacheByWorkingDir.get(cacheKey)?.commandsByName.get(name);
  }

  async listCommands(workingDirectory: string): Promise<{
    commands: CommandTemplate[];
    candidatesByName: Record<string, CommandTemplate[]>;
    diagnostics: CommandDiagnostic[];
    scanDirs: string[];
  }> {
    const cacheKey = workingDirectory;
    const cached = this.cacheByWorkingDir.get(cacheKey);
    const now = Date.now();

    if (!cached || now - cached.loadedAt >= CACHE_TTL_MS) {
      await this.loadCommandsForWorkingDirectory(workingDirectory);
    }

    const entry = this.cacheByWorkingDir.get(cacheKey)!;
    const commands = Array.from(entry.commandsByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    const candidatesByName: Record<string, CommandTemplate[]> = {};
    for (const [name, list] of entry.candidatesByName.entries()) {
      candidatesByName[name] = list.slice();
    }

    return {
      commands,
      candidatesByName,
      diagnostics: entry.diagnostics.slice(),
      scanDirs: entry.scanDirs.slice(),
    };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
  }

  /**
   * Clear the per-directory mtime cache so the next load will re-stat and
   * potentially re-walk directories.  Pass a workingDirectory to clear only
   * directories belonging to that project; omit to clear everything.
   */
  clearDirectoryMtimeCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.dirMtimeCache.clear();
      return;
    }
    const dirsForWorkingDir = this.getAllScanDirs(workingDirectory);
    for (const dir of dirsForWorkingDir) {
      this.dirMtimeCache.delete(dir);
    }
  }
}

let markdownCommandRegistry: MarkdownCommandRegistry | null = null;
export function getMarkdownCommandRegistry(): MarkdownCommandRegistry {
  if (!markdownCommandRegistry) {
    markdownCommandRegistry = MarkdownCommandRegistry.getInstance();
  }
  return markdownCommandRegistry;
}

export function _resetMarkdownCommandRegistryForTesting(): void {
  markdownCommandRegistry = null;
  MarkdownCommandRegistry._resetForTesting();
}
