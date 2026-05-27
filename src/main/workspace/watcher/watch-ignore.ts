import * as path from 'path';
import * as fs from 'fs';
import ignore from 'ignore';
import type { Matcher } from 'chokidar';

export const DEFAULT_WATCH_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/cache/**',
  '**/dist/**',
  '**/build/**',
  '**/libraries/**',
  '**/release/**',
  '**/external-benchmarks/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.angular/**',
  '**/.gradle/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/.parcel-cache/**',
  '**/.pytest_cache/**',
  '**/.ruff_cache/**',
  '**/.svelte-kit/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',
  '**/out/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
];

const PRUNED_DIRECTORY_NAMES = new Set([
  '.angular',
  '.cache',
  '.gradle',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.venv',
  'build',
  'cache',
  'coverage',
  'dist',
  'external-benchmarks',
  'libraries',
  'node_modules',
  'out',
  'release',
  'target',
  'venv',
]);

const PRUNED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

export function buildWatchIgnoredMatchers(
  rootDirectory: string,
  extraPatterns: readonly string[] = [],
): Matcher[] {
  const gitignoreMatcher = loadRootGitignore(rootDirectory);
  return [
    ...DEFAULT_WATCH_IGNORE_PATTERNS,
    ...extraPatterns,
    (candidatePath) =>
      isPathPrunedByDefault(rootDirectory, candidatePath)
      || isPathIgnoredByGitignore(rootDirectory, candidatePath, gitignoreMatcher),
  ];
}

export function isPathPrunedByDefault(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = relativeToRoot(rootDirectory, candidatePath);
  if (!relativePath) {
    return false;
  }

  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => PRUNED_DIRECTORY_NAMES.has(segment))) {
    return true;
  }

  const baseName = path.posix.basename(normalized);
  return PRUNED_FILE_NAMES.has(baseName) || baseName.endsWith('.log');
}

function relativeToRoot(rootDirectory: string, candidatePath: string): string {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);

  if (
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return candidate;
}

function loadRootGitignore(rootDirectory: string): ReturnType<typeof ignore> | null {
  try {
    const content = fs.readFileSync(path.join(rootDirectory, '.gitignore'), 'utf8');
    return ignore().add(content);
  } catch {
    return null;
  }
}

function isPathIgnoredByGitignore(
  rootDirectory: string,
  candidatePath: string,
  gitignoreMatcher: ReturnType<typeof ignore> | null,
): boolean {
  if (!gitignoreMatcher) {
    return false;
  }

  const relativePath = relativeInsideRoot(rootDirectory, candidatePath);
  if (!relativePath) {
    return false;
  }

  const normalized = relativePath.split(path.sep).join('/');
  return gitignoreMatcher.ignores(normalized) || gitignoreMatcher.ignores(`${normalized}/`);
}

function relativeInsideRoot(rootDirectory: string, candidatePath: string): string | null {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);

  if (
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return null;
}
