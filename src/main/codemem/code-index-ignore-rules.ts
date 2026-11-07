import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';
import { getLogger } from '../logging/logger';
import { DEFAULT_CODE_INDEX_IGNORES } from './code-index-ignores';

const execFileAsync = promisify(execFile);
const logger = getLogger('CodeIndexIgnoreRules');

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Decides whether a workspace-relative path, with folders ending in `/`, stays out of the code index. */
export interface CodeIndexIgnoreRules {
  ignores(relativePath: string): boolean;
}

interface GitIgnoredPaths {
  files: Set<string>;
  folders: Set<string>;
}

const warnedWorkspaces = new Set<string>();

/**
 * The code index skips `DEFAULT_CODE_INDEX_IGNORES` everywhere. In a git work tree it also skips every
 * untracked file git ignores, by git's own rules: nested `.gitignore` files, `.git/info/exclude` and
 * the global excludes file. Elsewhere it reads the workspace root's `.gitignore`.
 */
export async function loadCodeIndexIgnoreRules(workspacePath: string): Promise<CodeIndexIgnoreRules> {
  const defaults = ignore().add(['.gitignore', ...DEFAULT_CODE_INDEX_IGNORES]);
  const gitIgnored = await listGitIgnoredPaths(workspacePath);
  if (gitIgnored) {
    return {
      ignores: (relativePath) => defaults.ignores(relativePath) || isListed(gitIgnored, relativePath),
    };
  }

  try {
    defaults.add(await fs.readFile(path.join(workspacePath, '.gitignore'), 'utf8'));
  } catch {
    // Missing .gitignore is expected for some workspaces.
  }
  return defaults;
}

function isListed(listed: GitIgnoredPaths, relativePath: string): boolean {
  if (listed.files.has(relativePath) || listed.folders.has(relativePath)) {
    return true;
  }
  // A path inside a listed folder is ignored too; check each enclosing folder.
  let slash = relativePath.indexOf('/');
  while (slash !== -1 && slash < relativePath.length - 1) {
    if (listed.folders.has(relativePath.slice(0, slash + 1))) {
      return true;
    }
    slash = relativePath.indexOf('/', slash + 1);
  }
  return false;
}

/**
 * Null when the workspace is not governed by a git work tree's rules: outside git, git not installed,
 * or the whole workspace is itself ignored by an enclosing repository (git then answers `./`).
 */
async function listGitIgnoredPaths(workspacePath: string): Promise<GitIgnoredPaths | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      {
        cwd: workspacePath,
        // English messages, so a folder outside git is recognised from stderr.
        env: { ...process.env, LC_ALL: 'C' },
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    ));
  } catch (error) {
    if (!isOutsideGit(error) && !warnedWorkspaces.has(workspacePath)) {
      warnedWorkspaces.add(workspacePath);
      logger.warn('Could not read git ignore rules; using the root .gitignore only', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  const listed: GitIgnoredPaths = { files: new Set<string>(), folders: new Set<string>() };
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    if (entry === './') return null;
    (entry.endsWith('/') ? listed.folders : listed.files).add(entry);
  }
  return listed;
}

function isOutsideGit(error: unknown): boolean {
  const details = error as { code?: unknown; stderr?: unknown } | null;
  if (details?.code === 'ENOENT') return true;
  return typeof details?.stderr === 'string' && details.stderr.includes('not a git repository');
}
