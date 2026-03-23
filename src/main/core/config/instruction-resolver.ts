import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getLogger } from '../../logging/logger';
import { VcsManager } from '../../workspace/git/vcs-manager';
import type {
  InstructionMigrationDraft,
  InstructionResolution,
  InstructionSourceKind,
  InstructionSourceScope,
  ResolvedInstructionSource,
} from '../../../shared/types/instruction-source.types';

const logger = getLogger('InstructionResolver');

const EXCLUDED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.angular',
  '.worktrees',
  // macOS protected directories — scanning these triggers TCC permission prompts
  'Documents',
  'Desktop',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Library',
  'Applications',
  '.Trash',
  // Linux common non-project directories
  'snap',
  // Volumes / mounts — avoid removable volume TCC prompts
  'Volumes',
  'mnt',
  'media',
]);

interface InstructionSourceDescriptor {
  path: string;
  kind: InstructionSourceKind;
  scope: InstructionSourceScope;
  priority: number;
  label: string;
  matchPatterns?: string[];
}

export interface ResolveInstructionStackParams {
  workingDirectory: string;
  contextPaths?: string[];
  customPaths?: string[];
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function getHomeDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    return app.getPath('home');
  } catch {
    return process.env['HOME'] || process.env['USERPROFILE'] || '';
  }
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizePath(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function matchGlob(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/__DOUBLE_STAR__/g, '.*');

  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Returns true if the given directory is too broad to recursively scan for
 * instruction files.  The home directory and the filesystem root are never
 * real project roots — scanning them triggers macOS TCC permission prompts
 * (Documents, Desktop, removable volumes, etc.) and is extremely slow.
 */
function isBroadDirectory(directory: string): boolean {
  const resolved = path.resolve(directory);
  const home = os.homedir();
  // Filesystem root ('/' on unix, 'C:\' on Windows)
  if (resolved === path.parse(resolved).root) return true;
  // Home directory
  if (resolved === home) return true;
  // /Volumes on macOS (parent of all mount points)
  if (resolved === '/Volumes') return true;
  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectMatchingFiles(
  directory: string,
  predicate: (absolutePath: string) => boolean,
): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const results: string[] = [];
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_SCAN_DIRS.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return {};
  }

  try {
    const parsed = yaml.load(frontmatterMatch[1]);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseInstructionsApplyTo(content: string): string[] {
  const frontmatter = parseFrontmatter(content);
  const applyTo = frontmatter['applyTo'];

  if (typeof applyTo === 'string') {
    return applyTo
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (Array.isArray(applyTo)) {
    return applyTo
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
}

function buildWarnings(sources: ResolvedInstructionSource[]): string[] {
  const warnings: string[] = [];
  const appliedPathSpecific = sources.filter(
    (source) => source.applied && source.scope === 'path-specific',
  );

  if (appliedPathSpecific.length > 1) {
    warnings.push('Multiple path-specific instruction files matched the current context.');
  }

  const loadedKinds = new Set(
    sources
      .filter((source) => source.loaded && source.scope === 'project')
      .map((source) => source.kind),
  );

  if (loadedKinds.has('orchestrator') && loadedKinds.has('agents')) {
    warnings.push('Both orchestrator and AGENTS instructions are present at the project level.');
  }

  return warnings;
}

export function findInstructionProjectRoot(workingDirectory: string): string {
  try {
    const gitRoot = new VcsManager(workingDirectory).findGitRoot();
    if (gitRoot) {
      return normalizePath(gitRoot);
    }
  } catch (error) {
    logger.debug('Failed to detect git root for instruction resolution', {
      workingDirectory,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return normalizePath(workingDirectory);
}

async function discoverInstructionDescriptors(
  projectRoot: string,
  customPaths: string[],
): Promise<InstructionSourceDescriptor[]> {
  const homeDir = getHomeDir();
  const descriptors: InstructionSourceDescriptor[] = [];

  if (homeDir) {
    descriptors.push(
      {
        path: path.join(homeDir, '.orchestrator', 'INSTRUCTIONS.md'),
        kind: 'orchestrator',
        scope: 'user',
        priority: 1,
        label: 'Global orchestrator instructions',
      },
      {
        path: path.join(homeDir, '.claude', 'CLAUDE.md'),
        kind: 'claude',
        scope: 'user',
        priority: 2,
        label: 'Global CLAUDE.md',
      },
    );
  }

  descriptors.push(
    {
      path: path.join(projectRoot, 'CLAUDE.md'),
      kind: 'claude',
      scope: 'project',
      priority: 3,
      label: 'Project CLAUDE.md',
    },
    {
      path: path.join(projectRoot, 'GEMINI.md'),
      kind: 'gemini',
      scope: 'project',
      priority: 4,
      label: 'Project GEMINI.md',
    },
    {
      path: path.join(projectRoot, '.claude', 'CLAUDE.md'),
      kind: 'claude',
      scope: 'project',
      priority: 5,
      label: 'Project .claude/CLAUDE.md',
    },
    {
      path: path.join(projectRoot, '.github', 'copilot-instructions.md'),
      kind: 'copilot',
      scope: 'project',
      priority: 6,
      label: 'Project Copilot instructions',
    },
    {
      path: path.join(projectRoot, 'AGENTS.md'),
      kind: 'agents',
      scope: 'project',
      priority: 7,
      label: 'Project AGENTS.md',
    },
    {
      path: path.join(projectRoot, '.orchestrator', 'INSTRUCTIONS.md'),
      kind: 'orchestrator',
      scope: 'project',
      priority: 8,
      label: 'Project orchestrator instructions',
    },
  );

  // Only recursively scan for nested instruction files when the project root
  // is an actual project directory.  Broad directories (home, filesystem root)
  // would walk into macOS-protected folders and trigger TCC permission prompts.
  if (!isBroadDirectory(projectRoot)) {
    const nestedAgentFiles = await collectMatchingFiles(
      projectRoot,
      (absolutePath) =>
        path.basename(absolutePath) === 'AGENTS.md' &&
        normalizePath(absolutePath) !== normalizePath(path.join(projectRoot, 'AGENTS.md')),
    );

    for (const agentFile of nestedAgentFiles) {
      descriptors.push({
        path: agentFile,
        kind: 'agents',
        scope: 'path-specific',
        priority: 7,
        label: `Scoped AGENTS.md (${path.relative(projectRoot, path.dirname(agentFile)) || '.'})`,
      });
    }

    const copilotInstructionsDir = path.join(projectRoot, '.github', 'instructions');
    const copilotInstructionFiles = await collectMatchingFiles(
      copilotInstructionsDir,
      (absolutePath) => absolutePath.endsWith('.instructions.md'),
    );

    for (const instructionsFile of copilotInstructionFiles) {
      const content = await fs.readFile(instructionsFile, 'utf-8');
      descriptors.push({
        path: instructionsFile,
        kind: 'copilot',
        scope: 'path-specific',
        priority: 6,
        label: `Scoped Copilot instructions (${path.basename(instructionsFile)})`,
        matchPatterns: parseInstructionsApplyTo(content),
      });
    }
  } else {
    logger.debug('Skipping recursive instruction scan — project root is too broad', { projectRoot });
  }

  customPaths.forEach((customPath, index) => {
    descriptors.push({
      path: customPath,
      kind: 'custom',
      scope: 'custom',
      priority: 9 + index,
      label: `Custom instructions ${index + 1}`,
    });
  });

  return descriptors.sort((a, b) => a.priority - b.priority);
}

function collectContextAnchors(
  projectRoot: string,
  workingDirectory: string,
  contextPaths: string[],
): string[] {
  const normalizedContextDirectories = contextPaths.map((contextPath) =>
    path.dirname(normalizePath(contextPath)),
  );
  const anchors = dedupePreserveOrder([workingDirectory, ...normalizedContextDirectories]);
  return anchors.filter((absolutePath) => {
    const relative = path.relative(projectRoot, absolutePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function selectNearestAgentsFiles(
  sourcesByPath: Map<string, ResolvedInstructionSource>,
  anchors: string[],
): Set<string> {
  const selected = new Set<string>();
  const agentsPaths = Array.from(sourcesByPath.values())
    .filter((source) => source.loaded && source.scope === 'path-specific' && source.kind === 'agents')
    .map((source) => source.path);

  for (const anchor of anchors) {
    let current = anchor;

    while (true) {
      const candidate = path.join(current, 'AGENTS.md');
      if (agentsPaths.includes(candidate)) {
        selected.add(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return selected;
}

function matchInstructionPatterns(
  source: ResolvedInstructionSource,
  projectRoot: string,
  contextPaths: string[],
): string[] {
  if (!source.matchPatterns || source.matchPatterns.length === 0 || contextPaths.length === 0) {
    return [];
  }

  const matches: string[] = [];

  for (const contextPath of contextPaths) {
    const relativePath = toPosixPath(path.relative(projectRoot, contextPath));
    if (!relativePath || relativePath.startsWith('..')) {
      continue;
    }

    if (source.matchPatterns.some((pattern) => matchGlob(relativePath, pattern))) {
      matches.push(relativePath);
    }
  }

  return matches;
}

export async function resolveInstructionStack(
  params: ResolveInstructionStackParams,
): Promise<InstructionResolution> {
  const workingDirectory = normalizePath(params.workingDirectory);
  const projectRoot = findInstructionProjectRoot(workingDirectory);
  const rawContextPaths = params.contextPaths ?? [];
  const anchors = collectContextAnchors(projectRoot, workingDirectory, rawContextPaths);
  const descriptors = await discoverInstructionDescriptors(projectRoot, params.customPaths ?? []);

  const sources: ResolvedInstructionSource[] = [];

  for (const descriptor of descriptors) {
    const loaded = await pathExists(descriptor.path);
    sources.push({
      path: descriptor.path,
      kind: descriptor.kind,
      scope: descriptor.scope,
      loaded,
      applied: loaded && descriptor.scope !== 'path-specific',
      priority: descriptor.priority,
      label: descriptor.label,
      matchPatterns: descriptor.matchPatterns,
      reason: loaded ? undefined : 'File not found',
    });
  }

  const sourcesByPath = new Map(sources.map((source) => [source.path, source]));
  const selectedAgents = selectNearestAgentsFiles(sourcesByPath, anchors);

  for (const source of sources) {
    if (!source.loaded || source.scope !== 'path-specific') {
      continue;
    }

    if (source.kind === 'agents') {
      source.applied = selectedAgents.has(source.path);
      if (!source.applied) {
        source.reason = 'A nearer AGENTS.md matched the current context.';
      } else {
        source.reason = undefined;
      }
      continue;
    }

    const matchedPaths = matchInstructionPatterns(source, projectRoot, rawContextPaths);
    source.matchedPaths = matchedPaths;
    source.applied = matchedPaths.length > 0;
    source.reason = matchedPaths.length > 0
      ? undefined
      : rawContextPaths.length === 0
        ? 'No context paths provided.'
        : 'Pattern did not match the current context.';
  }

  const mergedParts: string[] = [];
  for (const source of sources.filter((item) => item.loaded && item.applied)) {
    const content = await fs.readFile(source.path, 'utf-8');
    const contentWithoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (!contentWithoutFrontmatter) {
      source.reason = 'File was empty after removing frontmatter.';
      source.applied = false;
      continue;
    }
    mergedParts.push(contentWithoutFrontmatter);
  }

  return {
    projectRoot,
    workingDirectory,
    contextPaths: rawContextPaths.map(normalizePath),
    mergedContent: mergedParts.join('\n\n---\n\n'),
    sources,
    warnings: buildWarnings(sources),
    timestamp: Date.now(),
  };
}

export function createInstructionMigrationDraft(
  resolution: InstructionResolution,
): InstructionMigrationDraft {
  const outputPath = path.join(
    resolution.projectRoot,
    '.orchestrator',
    'INSTRUCTIONS.md',
  );

  const appliedSources = resolution.sources.filter((source) => source.loaded && source.applied);
  const sourceSummary = appliedSources
    .map((source) => `- ${source.label}: ${source.path}`)
    .join('\n');

  const content = [
    '# Project Instructions',
    '',
    '> Generated by Claude Orchestrator from the currently resolved instruction stack.',
    '',
    '## Imported Sources',
    sourceSummary || '- None',
    '',
    '## Merged Instructions',
    resolution.mergedContent || 'Add project instructions here.',
    '',
  ].join('\n');

  return {
    outputPath,
    content,
    warnings: resolution.warnings,
  };
}
