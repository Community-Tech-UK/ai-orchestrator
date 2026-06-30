import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LoopRepoStateSource = 'git' | 'none';

export interface LoopRepoBaseline {
  source: LoopRepoStateSource;
  capturedAt: number;
  workspaceCwd: string;
  headRef: string | null;
  dirtyAtStart: boolean;
  trackedDirtyAtStart: string[];
  untrackedAtStart: string[];
  trackedDirtyHashes?: Record<string, string>;
  untrackedHashes?: Record<string, string>;
}

export interface LoopRepoComparison {
  source: LoopRepoStateSource;
  baseline: LoopRepoBaseline;
  changedFiles: string[];
  trackedDiff: string;
  untrackedFiles: string[];
  dirtyAtStartCarriedForward: boolean;
  truncated: boolean;
}

export interface LoopRepoComparisonOptions {
  maxDiffChars?: number;
}

export type LoopRepoGitRunner = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr?: string };

const DEFAULT_MAX_DIFF_CHARS = 96_000;
const IGNORED_REPO_PREFIXES = [
  '.aio-loop-control/',
  '.aio-loop-attachments/',
  '.aio-loop-state/',
  '.git/',
  'node_modules/',
];

const defaultGitRunner: LoopRepoGitRunner = (args, cwd) => {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

export function captureLoopRepoBaseline(
  workspaceCwd: string,
  runner: LoopRepoGitRunner = defaultGitRunner,
): LoopRepoBaseline {
  const capturedAt = Date.now();
  const fallback = (): LoopRepoBaseline => ({
    source: 'none',
    capturedAt,
    workspaceCwd,
    headRef: null,
    dirtyAtStart: false,
    trackedDirtyAtStart: [],
    untrackedAtStart: [],
  });

  const insideRepo = runner(['rev-parse', '--is-inside-work-tree'], workspaceCwd);
  if (insideRepo.status !== 0 || !/true/i.test(insideRepo.stdout)) {
    return fallback();
  }

  const head = runner(['rev-parse', 'HEAD'], workspaceCwd);
  const headRef = head.status === 0 ? head.stdout.trim() || null : null;
  const trackedDirtyAtStart = headRef
    ? readPathList(runner(['diff', '--name-only', headRef], workspaceCwd).stdout)
    : [];
  const untrackedAtStart = readPathList(runner(['ls-files', '--others', '--exclude-standard'], workspaceCwd).stdout);

  return {
    source: 'git',
    capturedAt,
    workspaceCwd,
    headRef,
    dirtyAtStart: trackedDirtyAtStart.length > 0 || untrackedAtStart.length > 0,
    trackedDirtyAtStart,
    untrackedAtStart,
    trackedDirtyHashes: hashTrackedDirtyFiles(workspaceCwd, headRef, trackedDirtyAtStart, runner),
    untrackedHashes: hashWorkspaceFiles(workspaceCwd, untrackedAtStart),
  };
}

export function compareLoopRepoState(
  workspaceCwd: string,
  baseline: LoopRepoBaseline,
  options: LoopRepoComparisonOptions = {},
  runner: LoopRepoGitRunner = defaultGitRunner,
): LoopRepoComparison {
  if (baseline.source !== 'git' || !baseline.headRef) {
    return emptyComparison(baseline);
  }

  const insideRepo = runner(['rev-parse', '--is-inside-work-tree'], workspaceCwd);
  if (insideRepo.status !== 0 || !/true/i.test(insideRepo.stdout)) {
    return emptyComparison({ ...baseline, source: 'none' });
  }

  const trackedFiles = readPathList(runner(['diff', '--name-only', baseline.headRef], workspaceCwd).stdout);
  const untrackedFiles = readPathList(runner(['ls-files', '--others', '--exclude-standard'], workspaceCwd).stdout);

  let dirtyAtStartCarriedForward = false;
  const changedFiles = new Set<string>();
  for (const relPath of trackedFiles) {
    if (baseline.trackedDirtyAtStart.includes(relPath)) {
      const currentHash = hashTrackedDirtyFile(workspaceCwd, baseline.headRef, relPath, runner);
      if (currentHash === baseline.trackedDirtyHashes?.[relPath]) continue;
      dirtyAtStartCarriedForward = true;
    }
    changedFiles.add(relPath);
  }
  for (const relPath of untrackedFiles) {
    if (baseline.untrackedAtStart.includes(relPath)) {
      const currentHash = hashWorkspaceFile(path.join(workspaceCwd, relPath));
      if (currentHash === baseline.untrackedHashes?.[relPath]) continue;
      dirtyAtStartCarriedForward = true;
    }
    changedFiles.add(relPath);
  }
  const changedFileList = [...changedFiles].sort();
  const diffArgs = ['--', ...changedFileList];
  const stat = changedFileList.length > 0
    ? runner(['-c', 'core.pager=cat', 'diff', '--stat', baseline.headRef, ...diffArgs], workspaceCwd)
    : { status: 0, stdout: '' };
  const diff = changedFileList.length > 0
    ? runner(['-c', 'core.pager=cat', 'diff', baseline.headRef, ...diffArgs], workspaceCwd)
    : { status: 0, stdout: '' };

  const diffSections = [
    stat.status === 0 && stat.stdout.trim()
      ? `## Change summary (git diff --stat ${baseline.headRef})\n${stat.stdout.trim()}`
      : '',
    diff.status === 0 && diff.stdout.trim()
      ? `## Tracked changes (git diff ${baseline.headRef})\n${diff.stdout.trimEnd()}`
      : '',
    renderUntrackedDiff(workspaceCwd, untrackedFiles.filter((relPath) => changedFiles.has(relPath))),
  ].filter(Boolean);

  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  let trackedDiff = diffSections.join('\n\n');
  let truncated = false;
  if (trackedDiff.length > maxDiffChars) {
    trackedDiff = `${trackedDiff.slice(0, maxDiffChars)}\n... (repo diff truncated)`;
    truncated = true;
  }

  return {
    source: 'git',
    baseline,
    changedFiles: changedFileList,
    trackedDiff,
    untrackedFiles,
    dirtyAtStartCarriedForward,
    truncated,
  };
}

function emptyComparison(baseline: LoopRepoBaseline): LoopRepoComparison {
  return {
    source: 'none',
    baseline,
    changedFiles: [],
    trackedDiff: '',
    untrackedFiles: [],
    dirtyAtStartCarriedForward: false,
    truncated: false,
  };
}

function readPathList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => normalizeRepoPath(line.trim()))
    .filter((line) => line.length > 0 && !isIgnoredLoopRepoPath(line))
    .sort();
}

function normalizeRepoPath(relPath: string): string {
  return relPath.split(path.sep).join('/').split('\\').join('/');
}

function isIgnoredLoopRepoPath(relPath: string): boolean {
  const normalized = normalizeRepoPath(relPath);
  return IGNORED_REPO_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function hashTrackedDirtyFiles(
  workspaceCwd: string,
  headRef: string | null,
  relPaths: string[],
  runner: LoopRepoGitRunner,
): Record<string, string> {
  if (!headRef) return {};
  const hashes: Record<string, string> = {};
  for (const relPath of relPaths) {
    hashes[relPath] = hashTrackedDirtyFile(workspaceCwd, headRef, relPath, runner);
  }
  return hashes;
}

function hashTrackedDirtyFile(
  workspaceCwd: string,
  headRef: string,
  relPath: string,
  runner: LoopRepoGitRunner,
): string {
  const diff = runner(['diff', headRef, '--', relPath], workspaceCwd);
  return hashText(diff.status === 0 ? diff.stdout : '');
}

function hashWorkspaceFiles(workspaceCwd: string, relPaths: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const relPath of relPaths) {
    hashes[relPath] = hashWorkspaceFile(path.join(workspaceCwd, relPath));
  }
  return hashes;
}

function hashWorkspaceFile(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return '';
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return '';
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function renderUntrackedDiff(workspaceCwd: string, relPaths: string[]): string {
  if (relPaths.length === 0) return '';
  const sections: string[] = [];
  for (const relPath of relPaths.sort()) {
    const absPath = path.join(workspaceCwd, relPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      const text = fs.readFileSync(absPath, 'utf8');
      sections.push([
        `diff --git a/${relPath} b/${relPath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${relPath}`,
        ...text.split(/\r?\n/).map((line) => `+${line}`),
      ].join('\n'));
    } catch {
      // Binary, unreadable, or deleted between status and read: omit from the text diff.
    }
  }
  return sections.length > 0 ? `## Untracked files\n${sections.join('\n\n')}` : '';
}
