import * as path from 'path';
import type { Matcher } from 'chokidar';

export const DEFAULT_WATCH_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
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
  'coverage',
  'dist',
  'external-benchmarks',
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
  return [
    ...DEFAULT_WATCH_IGNORE_PATTERNS,
    ...extraPatterns,
    (candidatePath) => isPathPrunedByDefault(rootDirectory, candidatePath),
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
