/**
 * Agent Registry
 *
 * Loads built-in agent profiles plus optional user/project-defined agents from markdown.
 * Custom agents are "lifted" into the orchestrator as first-class profiles (system prompt + permissions + model hint).
 *
 * This intentionally does not load code from sibling repos; it only reads markdown definitions from:
 * - `~/.orchestrator/agents/**.md`
 * - `~/.claude/agents/**.md`
 * - `~/.opencode/agent/**.md` and `~/.opencode/agents/**.md`
 * - `<project-scan-root>/.orchestrator/agents/**.md`
 * - `<project-scan-root>/.claude/agents/**.md`
 * - `<project-scan-root>/.opencode/agent/**.md` and `<project-scan-root>/.opencode/agents/**.md`
 *
 * Project scan roots run from the repository root (when available) down to the
 * active working directory, so nested worktrees inherit agent definitions from
 * their containing project.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import z from 'zod';
import type { AgentMode, AgentProfile, AgentToolPermissions, ToolPermission } from '../../shared/types/agent.types';
import { BUILTIN_AGENTS, getDefaultAgent } from '../../shared/types/agent.types';
import { parseMarkdownFrontmatter } from '../../shared/utils/markdown-frontmatter';
import { resolveProjectScanRoots } from '../util/project-scan-roots';

const ToolPermissionSchema = z.enum(['allow', 'deny', 'ask'] satisfies ToolPermission[]);

const PermissionsSchema = z.object({
  read: ToolPermissionSchema.optional(),
  write: ToolPermissionSchema.optional(),
  bash: ToolPermissionSchema.optional(),
  web: ToolPermissionSchema.optional(),
  task: ToolPermissionSchema.optional(),
});

const AgentFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.string().optional(), // accept wide range; normalize below
  color: z.string().optional(),
  icon: z.string().optional(),
  shortcutHint: z.string().optional(),
  model: z.string().optional(),
  permissions: PermissionsSchema.optional(),
});

type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

interface CacheEntry {
  loadedAt: number;
  agentsById: Map<string, AgentProfile>;
  agentsByName: Map<string, AgentProfile>;
  customAgents: Array<{ profile: AgentProfile; filePath: string }>;
  scanDirs: string[];
}

const CACHE_TTL_MS = 10_000;

function normalizeMode(mode: string | undefined): AgentMode {
  const m = (mode || '').toLowerCase().trim();
  if (m === 'plan') return 'plan';
  if (m === 'review') return 'review';
  if (m === 'build') return 'build';
  return 'custom';
}

function defaultPermissionsForMode(mode: AgentMode): AgentToolPermissions {
  switch (mode) {
    case 'plan':
    case 'review':
      return { read: 'allow', write: 'deny', bash: 'ask', web: 'allow', task: 'allow' };
    case 'build':
      return { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' };
    default:
      return { read: 'allow', write: 'ask', bash: 'ask', web: 'allow', task: 'allow' };
  }
}

export class AgentRegistry {
  private static instance: AgentRegistry | null = null;

  private cacheByWorkingDir = new Map<string, CacheEntry>();

  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry();
    }
    return AgentRegistry.instance;
  }

  static _resetForTesting(): void {
    AgentRegistry.instance = null;
  }

  private constructor() {}

  private getHomeDir(): string | null {
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

  private getAgentDirs(root: string): string[] {
    return [
      path.join(root, '.orchestrator', 'agents'),
      path.join(root, '.orchestrator', 'agent'),
      path.join(root, '.claude', 'agents'),
      path.join(root, '.claude', 'agent'),
      path.join(root, '.opencode', 'agents'),
      path.join(root, '.opencode', 'agent'),
    ];
  }

  private getAllScanDirs(workingDirectory: string): string[] {
    const dirs: string[] = [];
    for (const root of this.getScanRoots(workingDirectory)) {
      dirs.push(...this.getAgentDirs(root));
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

  private deriveNameFromPath(agentDir: string, filePath: string): string {
    const rel = path.relative(agentDir, filePath);
    const withoutExt = rel.replace(/\.md$/i, '');
    return withoutExt.split(path.sep).filter(Boolean).join(':');
  }

  private extractHeadingTitle(markdown: string): string | null {
    const firstLine = (markdown || '').split('\n')[0] || '';
    const m = firstLine.match(/^#{1,6}\s+(.+)\s*$/);
    return m?.[1]?.trim() || null;
  }

  private toCustomAgent(params: {
    id: string;
    name: string;
    description: string;
    mode: AgentMode;
    systemPrompt: string;
    permissions: AgentToolPermissions;
    modelOverride?: string;
    color?: string;
    icon?: string;
    shortcutHint?: string;
  }): AgentProfile {
    return {
      id: params.id,
      name: params.name,
      description: params.description,
      mode: params.mode,
      color: params.color || '#64748b',
      icon: params.icon || 'sparkles',
      shortcutHint: params.shortcutHint,
      systemPrompt: params.systemPrompt,
      permissions: params.permissions,
      modelOverride: params.modelOverride,
      builtin: false,
    };
  }

  private async loadAgentsForWorkingDirectory(workingDirectory: string): Promise<CacheEntry> {
    const agentsById = new Map<string, AgentProfile>();
    const agentsByName = new Map<string, AgentProfile>();
    const customAgents: Array<{ profile: AgentProfile; filePath: string }> = [];

    // Seed with built-ins (always available).
    for (const agent of BUILTIN_AGENTS) {
      agentsById.set(agent.id, agent);
      agentsByName.set(agent.name.toLowerCase(), agent);
    }

    const roots = this.getScanRoots(workingDirectory);
    for (const root of roots) {
      const dirs = this.getAgentDirs(root);
      for (const agentDir of dirs) {
        const files = await this.walkMarkdownFiles(agentDir);
        for (const filePath of files) {
          let raw: string;
          try {
            raw = await fs.readFile(filePath, 'utf-8');
          } catch {
            continue;
          }

          const parsed = parseMarkdownFrontmatter<Record<string, unknown>>(raw);
          const fmResult = AgentFrontmatterSchema.safeParse(parsed.data);
          const fm: AgentFrontmatter = fmResult.success ? fmResult.data : {};

          const content = parsed.content.trim();
          if (!content) continue;

          const derivedName = this.deriveNameFromPath(agentDir, filePath);
          const name = (fm.name || derivedName).trim();
          if (!name) continue;

          const title = this.extractHeadingTitle(content);
          const description = (fm.description || title || `Custom agent: ${name}`).trim();

          const mode = normalizeMode(fm.mode);
          const basePerms = defaultPermissionsForMode(mode);
          const permissions: AgentToolPermissions = {
            read: fm.permissions?.read || basePerms.read,
            write: fm.permissions?.write || basePerms.write,
            bash: fm.permissions?.bash || basePerms.bash,
            web: fm.permissions?.web || basePerms.web,
            task: fm.permissions?.task || basePerms.task,
          };

          const id = `custom:${name}`;
          const agent = this.toCustomAgent({
            id,
            name,
            description,
            mode,
            systemPrompt: content,
            permissions,
            modelOverride: fm.model,
            color: fm.color,
            icon: fm.icon,
            shortcutHint: fm.shortcutHint,
          });

          // Later sources override earlier ones by id/name.
          agentsById.set(agent.id, agent);
          agentsByName.set(agent.name.toLowerCase(), agent);
          customAgents.push({ profile: agent, filePath });
        }
      }
    }

    return {
      loadedAt: Date.now(),
      agentsById,
      agentsByName,
      customAgents,
      scanDirs: this.getAllScanDirs(workingDirectory),
    };
  }

  async resolveAgent(workingDirectory: string, idOrName?: string | null): Promise<AgentProfile> {
    if (!idOrName) return getDefaultAgent();

    const key = workingDirectory;
    const cached = this.cacheByWorkingDir.get(key);
    const now = Date.now();
    const entry = cached && now - cached.loadedAt < CACHE_TTL_MS ? cached : await this.loadAgentsForWorkingDirectory(workingDirectory);
    this.cacheByWorkingDir.set(key, entry);

    // Prefer exact id match; then allow lookup by name (case-insensitive).
    const byId = entry.agentsById.get(idOrName);
    if (byId) return byId;

    const byName = entry.agentsByName.get(idOrName.toLowerCase());
    if (byName) return byName;

    return getDefaultAgent();
  }

  async listAgents(workingDirectory: string): Promise<{
    agents: AgentListingItem[];
    scanDirs: string[];
  }> {
    const key = workingDirectory;
    const cached = this.cacheByWorkingDir.get(key);
    const now = Date.now();
    const entry =
      cached && now - cached.loadedAt < CACHE_TTL_MS
        ? cached
        : await this.loadAgentsForWorkingDirectory(workingDirectory);
    this.cacheByWorkingDir.set(key, entry);

    const agents: AgentListingItem[] = [];
    for (const agent of BUILTIN_AGENTS) {
      agents.push({ source: 'built-in', profile: agent });
    }
    for (const a of entry.customAgents) {
      agents.push({ source: 'file', profile: a.profile, filePath: a.filePath });
    }

    // Sort: built-ins first, then custom, each by name.
    agents.sort((a, b) => {
      const sa = a.source === 'built-in' ? 0 : 1;
      const sb = b.source === 'built-in' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.profile.name.localeCompare(b.profile.name);
    });

    return { agents, scanDirs: entry.scanDirs.slice() };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
  }
}

let agentRegistry: AgentRegistry | null = null;
export function getAgentRegistry(): AgentRegistry {
  if (!agentRegistry) {
    agentRegistry = AgentRegistry.getInstance();
  }
  return agentRegistry;
}

export function _resetAgentRegistryForTesting(): void {
  agentRegistry = null;
  AgentRegistry._resetForTesting();
}

export type AgentListingItem =
  | { source: 'built-in'; profile: AgentProfile }
  | { source: 'file'; profile: AgentProfile; filePath: string };

// (intentionally no standalone list function; use `getAgentRegistry().listAgents(...)`)
