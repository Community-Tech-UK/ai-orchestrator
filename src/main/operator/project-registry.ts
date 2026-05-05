import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { getConversationLedgerService } from '../conversation-ledger';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import type { Instance } from '../../shared/types/instance.types';
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';
import type {
  OperatorProjectListQuery,
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
  OperatorProjectRemote,
  OperatorProjectResolution,
  OperatorProjectSource,
  OperatorProjectUpsertInput,
} from '../../shared/types/operator.types';
import { getOperatorDatabase } from './operator-database';
import { normalizeKey, OperatorProjectStore } from './operator-project-store';

const execFileAsync = promisify(execFile);
const DEFAULT_SCAN_IGNORES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
]);

interface RecentDirectoriesSource {
  getDirectories(options?: unknown): Promise<RecentDirectoryEntry[]>;
}

interface ConversationLedgerSource {
  listConversations(query?: unknown): Array<{ workspacePath: string | null; updatedAt: number }>;
}

interface InstanceManagerSource {
  getAllInstances(): Array<Pick<Instance, 'workingDirectory' | 'lastActivity'>>;
}

export interface ProjectRegistryConfig {
  store?: OperatorProjectStore;
  recentDirectories?: RecentDirectoriesSource;
  conversationLedger?: ConversationLedgerSource;
  instanceManager?: InstanceManagerSource;
}

interface PathSeedOptions {
  source: OperatorProjectSource;
  displayName?: string;
  aliases?: string[];
  isPinned?: boolean;
  lastAccessedAt?: number | null;
  metadata?: Record<string, unknown>;
}

export class ProjectRegistry {
  private static instance: ProjectRegistry | null = null;
  private readonly store: OperatorProjectStore;
  private readonly recentDirectories?: RecentDirectoriesSource;
  private readonly conversationLedger?: ConversationLedgerSource;
  private readonly instanceManager?: InstanceManagerSource;

  static getInstance(config?: ProjectRegistryConfig): ProjectRegistry {
    this.instance ??= new ProjectRegistry(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(config: ProjectRegistryConfig = {}) {
    this.store = config.store ?? new OperatorProjectStore(getOperatorDatabase().db);
    this.recentDirectories = config.recentDirectories ?? getRecentDirectoriesManager();
    this.conversationLedger = config.conversationLedger ?? getConversationLedgerService();
    this.instanceManager = config.instanceManager;
  }

  listProjects(query: OperatorProjectListQuery = {}): OperatorProjectRecord[] {
    return this.store.listProjects(query);
  }

  async refreshProjects(options: OperatorProjectRefreshOptions = {}): Promise<OperatorProjectRecord[]> {
    const includeRecent = options.includeRecent ?? true;
    const includeActiveInstances = options.includeActiveInstances ?? true;
    const includeConversationLedger = options.includeConversationLedger ?? true;

    if (includeRecent) {
      await this.seedRecentDirectories();
    }
    if (includeActiveInstances) {
      await this.seedActiveInstances();
    }
    if (includeConversationLedger) {
      await this.seedConversationLedger();
    }
    for (const root of options.roots ?? []) {
      await this.seedScanRoot(root);
    }
    return this.listProjects();
  }

  async upsertProjectFromPath(dirPath: string, options: PathSeedOptions): Promise<OperatorProjectRecord> {
    const input = await this.buildProjectInput(dirPath, options);
    return this.store.upsertProject(input);
  }

  resolveProject(query: string): OperatorProjectResolution {
    const normalizedQuery = normalizeKey(query);
    if (!normalizedQuery) {
      return { status: 'not_found', query, project: null, candidates: [] };
    }

    const projects = this.store.listProjects();
    const exact = projects.filter((project) =>
      normalizeKey(project.canonicalPath) === normalizedQuery
      || normalizeKey(project.displayName) === normalizedQuery
      || project.aliases.some((alias) => normalizeKey(alias) === normalizedQuery)
    );
    if (exact.length === 1) {
      return { status: 'resolved', query, project: exact[0], candidates: exact };
    }
    if (exact.length > 1) {
      return { status: 'ambiguous', query, project: null, candidates: rankProjects(exact) };
    }

    const fuzzy = projects.filter((project) =>
      normalizeKey(project.displayName).includes(normalizedQuery)
      || normalizeKey(project.canonicalPath).includes(normalizedQuery)
      || project.aliases.some((alias) => normalizeKey(alias).includes(normalizedQuery))
    );
    if (fuzzy.length === 1) {
      return { status: 'resolved', query, project: fuzzy[0], candidates: fuzzy };
    }
    if (fuzzy.length > 1) {
      return { status: 'ambiguous', query, project: null, candidates: rankProjects(fuzzy) };
    }
    return { status: 'not_found', query, project: null, candidates: [] };
  }

  private async seedRecentDirectories(): Promise<void> {
    if (!this.recentDirectories) return;
    const entries = await this.recentDirectories.getDirectories({ includePinned: true, limit: 500 });
    for (const entry of entries) {
      await this.upsertProjectFromPath(entry.path, {
        source: 'recent-directory',
        displayName: entry.displayName,
        isPinned: entry.isPinned,
        lastAccessedAt: entry.lastAccessed,
        metadata: { accessCount: entry.accessCount },
      });
    }
  }

  private async seedActiveInstances(): Promise<void> {
    if (!this.instanceManager) return;
    for (const instance of this.instanceManager.getAllInstances()) {
      if (!instance.workingDirectory) continue;
      await this.upsertProjectFromPath(instance.workingDirectory, {
        source: 'active-instance',
        lastAccessedAt: instance.lastActivity,
      });
    }
  }

  private async seedConversationLedger(): Promise<void> {
    if (!this.conversationLedger) return;
    const threads = this.conversationLedger.listConversations({ limit: 500 });
    for (const thread of threads) {
      if (!thread.workspacePath) continue;
      await this.upsertProjectFromPath(thread.workspacePath, {
        source: 'conversation-ledger',
        lastAccessedAt: thread.updatedAt,
      });
    }
  }

  private async seedScanRoot(root: string): Promise<void> {
    const repos = await findRepositories(root);
    for (const repo of repos) {
      await this.upsertProjectFromPath(repo, { source: 'scan' });
    }
  }

  private async buildProjectInput(
    dirPath: string,
    options: PathSeedOptions,
  ): Promise<OperatorProjectUpsertInput> {
    const normalizedPath = path.resolve(dirPath);
    const gitRoot = await findGitRoot(normalizedPath);
    const canonicalPath = gitRoot ?? normalizedPath;
    const packageName = await readPackageName(canonicalPath);
    const readmeTitle = await readReadmeTitle(canonicalPath);
    const gitMetadata = gitRoot ? await readGitMetadata(gitRoot) : { remotes: [], currentBranch: null };
    const displayName = readmeTitle
      ?? packageName
      ?? options.displayName
      ?? path.basename(canonicalPath)
      ?? canonicalPath;
    const aliases = dedupeAliases([
      displayName,
      options.displayName,
      packageName,
      packageName ? packageName.replace(/^@/, '') : undefined,
      packageName?.includes('/') ? packageName.split('/').at(-1) : undefined,
      path.basename(canonicalPath),
      ...gitMetadata.remotes.flatMap(remoteAliases),
      ...(options.aliases ?? []),
    ]);

    return {
      canonicalPath,
      displayName,
      aliases,
      source: options.source,
      gitRoot,
      remotes: gitMetadata.remotes,
      currentBranch: gitMetadata.currentBranch,
      isPinned: options.isPinned ?? false,
      lastAccessedAt: options.lastAccessedAt ?? null,
      metadata: {
        ...(packageName ? { packageName } : {}),
        ...(readmeTitle ? { readmeTitle } : {}),
        ...(options.metadata ?? {}),
      },
    };
  }
}

export function getProjectRegistry(config?: ProjectRegistryConfig): ProjectRegistry {
  return ProjectRegistry.getInstance(config);
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = startPath;
  for (;;) {
    if (await pathExists(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findRepositories(root: string): Promise<string[]> {
  const normalizedRoot = path.resolve(root);
  const repos: string[] = [];
  async function walk(dirPath: string): Promise<void> {
    const basename = path.basename(dirPath);
    if (DEFAULT_SCAN_IGNORES.has(basename)) return;
    if (await pathExists(path.join(dirPath, '.git'))) {
      repos.push(dirPath);
      return;
    }
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DEFAULT_SCAN_IGNORES.has(entry.name)) continue;
      await walk(path.join(dirPath, entry.name));
    }
  }
  await walk(normalizedRoot);
  return repos.sort((a, b) => a.localeCompare(b));
}

async function readPackageName(projectPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

async function readReadmeTitle(projectPath: string): Promise<string | null> {
  for (const filename of ['README.md', 'readme.md']) {
    try {
      const raw = await fs.readFile(path.join(projectPath, filename), 'utf-8');
      const firstHeading = raw.split(/\r?\n/).find((line) => line.startsWith('# '));
      if (firstHeading) {
        return firstHeading.slice(2).trim() || null;
      }
    } catch {
      // Try the next conventional casing.
    }
  }
  return null;
}

async function readGitMetadata(gitRoot: string): Promise<{
  remotes: OperatorProjectRemote[];
  currentBranch: string | null;
}> {
  const remotesOutput = await readGit(gitRoot, ['remote', '-v']);
  const currentBranch = await readGit(gitRoot, ['branch', '--show-current']);
  const remotes = parseRemotes(remotesOutput);
  return {
    remotes,
    currentBranch: currentBranch.trim() || null,
  };
}

async function readGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: 2000,
      maxBuffer: 128 * 1024,
    });
    return result.stdout;
  } catch {
    return '';
  }
}

function parseRemotes(output: string): OperatorProjectRemote[] {
  const remotes = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== 'fetch') continue;
    remotes.set(match[1], match[2]);
  }
  return Array.from(remotes, ([name, url]) => ({ name, url }));
}

function remoteAliases(remote: OperatorProjectRemote): string[] {
  const withoutGit = remote.url.replace(/\.git$/, '');
  const sshMatch = withoutGit.match(/[:/]([^/:]+\/[^/]+)$/);
  return sshMatch ? [sshMatch[1]] : [];
}

function rankProjects(projects: OperatorProjectRecord[]): OperatorProjectRecord[] {
  return [...projects].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0)
      || a.displayName.localeCompare(b.displayName);
  });
}

function dedupeAliases(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = normalizeKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(trimmed);
  }
  return aliases;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
