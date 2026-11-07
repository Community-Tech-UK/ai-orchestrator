/**
 * A cheap readiness check when a run starts: not the checklist itself (about 50 minutes here), only the three
 * things that used to waste whole rounds. Each failure names the thing and what to do, in plain words.
 *   - Node: the checks run through a shell on the PATH Harness gives them, which once picked Homebrew Node 26
 *     for a project pinned to 24. The run refuses when the major version differs from the project's `.nvmrc`.
 *   - Dependencies: `npm ci --dry-run` must succeed when the project has a lockfile. It runs in the live checkout, and
 *     npm before 10.8 ignores `--dry-run` and empties node_modules, so older npm is skipped, never run.
 *   - Gates: every configured check command must exist (an npm script in package.json, or a program on the PATH).
 *   - Disk: each job needs its own work folder with dependencies, so a nearly full disk refuses the run.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { buildCliEnv } from '../cli/cli-environment';
import { getLogger } from '../logging/logger';
import { runInProcessGroup } from './plan-queue-process';

const logger = getLogger('PlanQueueRunReadiness');
const NODE_TIMEOUT_MS = 20_000;
const DEPENDENCY_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 600;

export interface ReadinessShell {
  /** Run one shell command in the project, with the environment the queue's checks get. */
  run(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }>;
}

export const defaultReadinessShell: ReadinessShell = {
  run: (command, cwd, timeoutMs) => runInProcessGroup(command, [], {
    cwd, env: buildCliEnv(), shell: true, timeoutMs, outputTail: OUTPUT_TAIL, label: `\`${command}\``,
  }),
};

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf-8').catch(() => null);
}

async function npmScripts(repoRoot: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path.join(repoRoot, 'package.json'));
  if (text === null) return null;
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? scripts as Record<string, unknown> : {};
  } catch {
    return null;
  }
}

const major = (version: string): string | null => /^v?(\d+)/.exec(version.trim())?.[1] ?? null;

async function checkNode(repoRoot: string, shell: ReadinessShell): Promise<string | null> {
  const pinned = (await readText(path.join(repoRoot, '.nvmrc')))?.trim();
  if (!pinned || major(pinned) === null) return null;
  const result = await shell.run('node --version', repoRoot, NODE_TIMEOUT_MS);
  const actual = result.exitCode === 0 ? result.output.trim().split('\n').at(-1) ?? '' : '';
  if (major(actual) === null) return `Node could not be started for the project's checks (${result.output.trim().slice(-200) || 'no output'}). Install Node ${pinned} with nvm, then try again.`;
  return major(actual) === major(pinned) ? null
    : `the project's checks would run on Node ${actual.trim()}, but the project asks for Node ${pinned} (its .nvmrc file). Harness chooses the Node for checks itself: the newest one installed with nvm, then the Homebrew and system folders. Install Node ${pinned} with nvm and uninstall the newer versions, then try again.`;
}

async function checkDependencies(repoRoot: string, shell: ReadinessShell): Promise<string | null> {
  if (!(await fs.stat(path.join(repoRoot, 'package-lock.json')).then(() => true, () => false))) return null;
  // `--dry-run` is honoured by npm 10.8 and later only; an older npm would empty the project's node_modules.
  const npm = await shell.run('npm --version', repoRoot, NODE_TIMEOUT_MS);
  const [npmMajor, npmMinor] = (/^(\d+)\.(\d+)/.exec(npm.output.trim().split('\n').at(-1) ?? '') ?? []).slice(1).map(Number);
  if (npm.exitCode !== 0 || npmMajor === undefined || npmMinor === undefined || npmMajor < 10 || (npmMajor === 10 && npmMinor < 8)) {
    logger.info('Plan queue readiness: package check skipped, npm cannot be trusted to leave the checkout alone', { npmVersion: npm.output.trim().slice(-40) });
    return null;
  }
  const result = await shell.run('npm ci --dry-run --ignore-scripts --no-audit --no-fund', repoRoot, DEPENDENCY_TIMEOUT_MS);
  return result.exitCode === 0 ? null
    : `the project's packages would not install cleanly from its lock file (a trial install failed: ${result.output.trim().slice(-300) || 'no output'}).`;
}

async function checkGates(repoRoot: string, gates: readonly string[], shell: ReadinessShell): Promise<string | null> {
  const scripts = await npmScripts(repoRoot);
  for (const gate of gates) {
    // A gate written with npm flags (`npm run -w pkg test`) cannot be judged by its first word, so it is not.
    if (/^npm run\s+-/.test(gate.trim())) continue;
    const script = /^npm run (\S+)/.exec(gate.trim())?.[1];
    if (script !== undefined) {
      if (typeof scripts?.[script] !== 'string') return `the check "${gate}" cannot run: the project has no "${script}" command in its package.json. Give the run the project's own checks, or leave them empty so the checker uses the project's documented checks.`;
      continue;
    }
    const program = gate.trim().split(/\s+/)[0] ?? '';
    // `command -v` is POSIX shell; on Windows the shell is cmd.exe, so program existence is not judged there.
    if (process.platform === 'win32' || !program || !/^[\w./@+-]+$/.test(program)) continue;
    const found = await shell.run(`command -v ${program}`, repoRoot, NODE_TIMEOUT_MS);
    if (found.exitCode !== 0) return `the check "${gate}" cannot run: "${program}" is not installed where Harness looks for programs.`;
  }
  return null;
}

/**
 * Each job's work folder and its dependencies need room. macOS reports less than it can free on demand (local
 * snapshots, iCloud files), so the floor is low: below it the folders themselves start failing.
 */
export const MIN_FREE_DISK_BYTES = 2e9;

async function checkDisk(repoRoot: string): Promise<string | null> {
  const disk = await fs.statfs(repoRoot).catch(() => null);
  if (!disk) return null;
  const free = disk.bavail * disk.bsize;
  return free >= MIN_FREE_DISK_BYTES ? null
    : `only ${(free / 1e9).toFixed(1)} GB is free right now on the disk holding ${repoRoot}. Each job needs a work folder of its own; free some space, then try again.`;
}

/** Throws a plain-language error when the project cannot run this run's checks; the run then does not start. */
export async function assertRunReady(
  repoRoot: string,
  gates: readonly string[],
  shell: ReadinessShell = defaultReadinessShell,
): Promise<void> {
  const problem = await checkDisk(repoRoot) ?? await checkGates(repoRoot, gates, shell) ?? await checkNode(repoRoot, shell)
    ?? await checkDependencies(repoRoot, shell);
  if (problem) throw new Error(`This run cannot start: ${problem}`);
}
