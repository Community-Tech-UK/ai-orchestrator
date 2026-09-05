import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

/**
 * Where the package.json backing an inferred command sits relative to the
 * loop's workspace. Load-bearing for auto-adoption: `workspace` and
 * `descendant` verifiers test the tree the user pointed the loop at, and their
 * commands are expressed relative to the working directory (no absolute machine
 * paths). An `ancestor` verifier belongs to an enclosing project the loop was
 * NOT aimed at — it can only be addressed absolutely, and its suite covers code
 * outside the loop's scope — so it is suggested rather than adopted.
 */
export type InferredVerifyScope = 'workspace' | 'descendant' | 'ancestor';

export interface InferredLoopVerifyCommand {
  command: string;
  source: string;
  scope: InferredVerifyScope;
}

/**
 * Where a loop's verification authority came from.
 * - `explicit`: the caller supplied a verify command.
 * - `inferred`: none supplied, so the workspace's own verifier was adopted.
 * - `operator-reviewed`: a human signs off instead of a machine check.
 * - `none`: no authority available (only legal for investigation goals).
 */
export type LoopVerificationAuthority =
  | 'explicit'
  | 'inferred'
  | 'operator-reviewed'
  | 'none';

export interface ResolvedLoopVerification {
  authority: LoopVerificationAuthority;
  /** The command that will gate completion; '' when the authority isn't a command. */
  verifyCommand: string;
  /** Provenance of an inferred command (e.g. `package.json script "verify"`). */
  inferredSource?: string;
  /**
   * T42: set when a verifier WAS detected but was refused because another
   * writer is mid-edit in this unisolated workspace. Distinguishes "no
   * verifier here" from "the verifier would grade someone else's work".
   */
  contendedPaths?: string[];
}

/**
 * T42: paths whose presence as UNTRACKED files means another agent is editing
 * this workspace right now. A mid-edit spec file or a live loop-state directory
 * turns a green suite red for reasons that have nothing to do with the child,
 * and the HUD then blames the child for it.
 */
export function findContendedWorkspacePaths(gitStatusPorcelain: string): string[] {
  const contended: string[] = [];
  for (const line of gitStatusPorcelain.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!rel) continue;
    const normalized = rel.split('\\').join('/');
    if (normalized.startsWith('.aio-loop-')) contended.push(normalized);
    else if (/\.spec\.(ts|tsx|js|mjs)$/.test(normalized)) contended.push(normalized);
  }
  return contended;
}

export interface ResolveLoopVerificationInput {
  workspaceCwd: string;
  /** Caller-supplied command. Wins over everything when non-blank. */
  verifyCommand?: string;
  allowOperatorReviewedCompletion?: boolean;
  /**
   * True when the goal is an implementation task, which cannot complete
   * autonomously without a real authority (WS6). Investigation goals pass
   * `false`: their deliverable is a cited report, so inferring — and then
   * running — a test suite would be cost without gate value.
   */
  requireAuthority: boolean;
  /** Injectable for tests; defaults to {@link inferLoopVerifyCommand}. */
  infer?: (workspaceCwd: string) => Promise<InferredLoopVerifyCommand | null>;
  /**
   * T42: the loop will run in its own worktree, so a concurrent writer in the
   * repo root cannot poison its verify. Skips the contention probe.
   */
  isolated?: boolean;
  /**
   * T42: returns `git status --porcelain` for the workspace, or `null` when it
   * cannot be read (not a repo, git missing). Injectable for tests; `null`
   * fails open — an unreadable status is never treated as contention.
   */
  gitStatus?: (workspaceCwd: string) => Promise<string | null>;
}

/**
 * Resolve the verification authority for a loop start.
 *
 * The single seam that turns "this workspace has a verifier" into "this loop is
 * gated by that verifier". Before this existed, `inferLoopVerifyCommand` only
 * fed a UI hint, so a workspace with a `verify` script still had its
 * implementation loops refused for lacking a verification authority.
 *
 * Precedence is deliberate: an explicit command beats everything, and an
 * explicit operator-reviewed choice beats inference — quietly attaching a
 * detected test suite to a run the user asked to sign off by hand would add a
 * gate (and its cost) they never requested.
 */
export async function resolveLoopVerification(
  input: ResolveLoopVerificationInput,
): Promise<ResolvedLoopVerification> {
  const explicit = (input.verifyCommand ?? '').trim();
  if (explicit) {
    return { authority: 'explicit', verifyCommand: explicit };
  }
  if (input.allowOperatorReviewedCompletion) {
    return { authority: 'operator-reviewed', verifyCommand: '' };
  }
  if (!input.requireAuthority) {
    return { authority: 'none', verifyCommand: '' };
  }
  const inferred = await (input.infer ?? inferLoopVerifyCommand)(input.workspaceCwd);
  // An enclosing project's verifier is reported (the UI suggests it) but never
  // adopted silently: gating this loop on a suite for a tree the user did not
  // point it at is a decision they should make, not one we make for them.
  // They can still paste it in deliberately.
  if (!inferred || !isAutoAdoptable(inferred)) {
    return { authority: 'none', verifyCommand: '' };
  }
  // T42/T44: adopting a suite that a second agent is mid-edit in produces reds
  // this loop did not cause, and the child is then told to fix them. An
  // explicit command still runs (the operator chose it); only silent adoption
  // is refused, and only when the loop is NOT isolated.
  if (!input.isolated) {
    const status = await (input.gitStatus ?? readGitStatusPorcelain)(input.workspaceCwd);
    const contended = status === null ? [] : findContendedWorkspacePaths(status);
    if (contended.length > 0) {
      return { authority: 'none', verifyCommand: '', contendedPaths: contended };
    }
  }
  return {
    authority: 'inferred',
    verifyCommand: inferred.command,
    inferredSource: inferred.source,
  };
}

async function readGitStatusPorcelain(workspaceCwd: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['status', '--porcelain'], {
      cwd: workspaceCwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** True when an inferred command verifies the loop's OWN tree. */
function isAutoAdoptable(inferred: InferredLoopVerifyCommand): boolean {
  return inferred.scope !== 'ancestor';
}

const COMPOSABLE_NPM_VERIFY_SCRIPTS = [
  'typecheck',
  'typecheck:spec',
  'lint',
  'test',
] as const;

const DESCENDANT_PACKAGE_SEARCH_MAX_DEPTH = 4;
const DESCENDANT_PACKAGE_SEARCH_MAX_DIRS = 250;
const IGNORED_DESCENDANT_DIRS = new Set([
  '.angular',
  '.cache',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export async function inferLoopVerifyCommand(
  workspaceCwd: string,
): Promise<InferredLoopVerifyCommand | null> {
  const requestedWorkspace = path.resolve(workspaceCwd);
  let current = requestedWorkspace;

  while (true) {
    const packageJson = await readPackageJson(current);
    const inferred = inferFromPackageJson(packageJson, current, requestedWorkspace);
    if (inferred) return inferred;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return inferFromDescendantPackages(requestedWorkspace);
}

async function inferFromDescendantPackages(
  requestedWorkspace: string,
): Promise<InferredLoopVerifyCommand | null> {
  const queue: { dir: string; depth: number }[] = [{ dir: requestedWorkspace, depth: 0 }];
  const candidates: {
    inferred: InferredLoopVerifyCommand;
    depth: number;
    packageDir: string;
  }[] = [];
  let scannedDirs = 0;

  while (queue.length > 0 && scannedDirs < DESCENDANT_PACKAGE_SEARCH_MAX_DIRS) {
    const current = queue.shift();
    if (!current) break;
    scannedDirs += 1;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const childDirs = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DESCENDANT_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of childDirs) {
      const childDir = path.join(current.dir, entry.name);
      const packageJson = await readPackageJson(childDir);
      const inferred = inferFromPackageJson(packageJson, childDir, requestedWorkspace);
      if (inferred) {
        candidates.push({
          inferred,
          depth: current.depth + 1,
          packageDir: childDir,
        });
      }

      if (current.depth + 1 < DESCENDANT_PACKAGE_SEARCH_MAX_DEPTH) {
        queue.push({ dir: childDir, depth: current.depth + 1 });
      }
    }
  }

  candidates.sort((a, b) =>
    verificationPriority(a.inferred) - verificationPriority(b.inferred)
    || a.depth - b.depth
    || a.packageDir.localeCompare(b.packageDir)
  );

  return candidates[0]?.inferred ?? null;
}

function inferFromPackageJson(
  packageJson: { scripts?: Record<string, unknown> } | null,
  packageDir: string,
  requestedWorkspace: string,
): InferredLoopVerifyCommand | null {
  const scripts = packageJson?.scripts;
  if (!scripts) return null;
  const scope = inferredScope(packageDir, requestedWorkspace);

  if (isUsableScript(scripts['verify'])) {
    return {
      command: npmRunCommand('verify', packageDir, requestedWorkspace, scope),
      source: 'package.json script "verify"',
      scope,
    };
  }

  const scriptNames = COMPOSABLE_NPM_VERIFY_SCRIPTS.filter((name) =>
    isUsableScript(scripts[name]),
  );
  if (scriptNames.length === 0) return null;

  return {
    command: scriptNames
      .map((name) => npmRunCommand(name, packageDir, requestedWorkspace, scope))
      .join(' && '),
    source: `package.json scripts: ${scriptNames.join(', ')}`,
    scope,
  };
}

function inferredScope(packageDir: string, requestedWorkspace: string): InferredVerifyScope {
  const pkg = path.resolve(packageDir);
  const workspace = path.resolve(requestedWorkspace);
  if (pkg === workspace) return 'workspace';
  const relative = path.relative(workspace, pkg);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? 'descendant'
    : 'ancestor';
}

function npmRunCommand(
  scriptName: string,
  packageDir: string,
  requestedWorkspace: string,
  scope: InferredVerifyScope,
): string {
  if (scope === 'workspace') {
    return `npm run ${scriptName}`;
  }
  // Descendant packages get a WORKSPACE-RELATIVE prefix: the verify command is
  // spawned with cwd = the loop's working directory, so this stays portable
  // (and keeps pointing at the right package if that directory ever changes).
  // Only an ancestor has to be absolute — and those are not auto-adopted.
  const prefix = scope === 'descendant'
    ? path.relative(path.resolve(requestedWorkspace), path.resolve(packageDir))
    : packageDir;
  return `npm --prefix ${quoteShellArg(prefix)} run ${scriptName}`;
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function verificationPriority(inferred: InferredLoopVerifyCommand): number {
  return inferred.source === 'package.json script "verify"' ? 0 : 1;
}

async function readPackageJson(
  workspaceCwd: string,
): Promise<{ scripts?: Record<string, unknown> } | null> {
  try {
    const raw = await fsp.readFile(path.join(workspaceCwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as { scripts?: Record<string, unknown> };
  } catch {
    return null;
  }
}

function isUsableScript(script: unknown): boolean {
  return typeof script === 'string' && script.trim().length > 0;
}
