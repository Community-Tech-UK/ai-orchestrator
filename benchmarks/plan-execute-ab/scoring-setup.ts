import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { delimiter, dirname, join, resolve } from 'path';
import { Module } from 'module';
import { runCommand } from './exec';
import type { CommandResult } from './types';

export interface DependencyReceipt {
  fingerprint: string;
  files: Record<string, string>;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  nodeVersion: string;
  runtimePreparation: CommandResult[];
  cacheRoot: string;
}

const RECEIPT = '_scratch/scoring-dependencies.json';

/** Node and native bundlers must have no installed ancestor to fall back to. */
export function assertNoAncestorDependencies(dir: string): void {
  for (const root of new Set<string>([resolve(dir), realpathSync(dir)])) {
    for (let parent = dirname(root); ; parent = dirname(parent)) {
      const modules = join(parent, 'node_modules');
      try {
        lstatSync(modules);
        throw new Error(`scoring infrastructure: export has ancestor node_modules: ${modules}; choose a dependency-free export location`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (dirname(parent) === parent) break;
    }
  }
  for (const globalPath of (Module as unknown as { globalPaths: string[] }).globalPaths) {
    try {
      lstatSync(globalPath);
      throw new Error(`scoring infrastructure: installed global module path: ${globalPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function toolPath(workspaceDir: string, env: NodeJS.ProcessEnv): string {
  const globalPaths = (env['PATH'] ?? '').split(delimiter)
    .filter(entry => {
      if (!entry || entry.split(/[\\/]/).includes('node_modules')) return false;
      try { return !realpathSync(entry).split(/[\\/]/).includes('node_modules'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  return [join(resolve(workspaceDir), 'node_modules/.bin'), ...globalPaths].join(delimiter);
}

/** Never reuse host dependency executables, NODE_PATH, or an npx cache. */
export function scoringEnvironment(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scratch = join(workspaceDir, '_scratch');
  mkdirSync(scratch, { recursive: true });
  return {
    ...env, NODE_PATH: '', PATH: toolPath(workspaceDir, env), AIO_TEST_SUMMARY: '0',
    npm_config_offline: 'true', npm_config_yes: 'false',
    npm_config_cache: mkdtempSync(join(scratch, 'npm-exec-')),
  };
}

function manifests(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (['node_modules', '.git', '_scratch', 'dist', '.angular'].includes(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(entry.name)) {
        files[path] = createHash('sha256').update(readFileSync(join(dir, path))).digest('hex');
      }
    }
  };
  walk('');
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function fingerprint(files: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** Install only the exported task's frozen dependencies, before any coder runs. */
export async function prepareScoringDependencies(dir: string, evidenceDir?: string): Promise<DependencyReceipt> {
  assertNoAncestorDependencies(dir);
  const receiptPath = join(dir, RECEIPT);
  rmSync(receiptPath, { force: true });
  const files = manifests(dir);
  if (existsSync(join(dir, 'node_modules')) && lstatSync(join(dir, 'node_modules')).isSymbolicLink()) {
    throw new Error('scoring dependency setup refuses a host node_modules symlink');
  }
  let command: string[] = [];
  if (files['pnpm-lock.yaml']) command = ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'];
  else if (files['package-lock.json']) command = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  else if (files['package.json']) throw new Error('scoring dependency setup requires a frozen lockfile');
  const cacheRoot = join(dir, '_scratch/dependency-install-cache');
  mkdirSync(join(cacheRoot, 'tmp'), { recursive: true });
  const installEnv = {
    ...process.env, NODE_PATH: '', PATH: toolPath(dir, process.env), CI: 'true', npm_config_update_notifier: 'false',
    npm_config_cache: join(cacheRoot, 'npm'), electron_config_cache: join(cacheRoot, 'electron'),
    npm_config_devdir: join(cacheRoot, 'node-gyp'), npm_package_config_node_gyp_devdir: join(cacheRoot, 'node-gyp'),
    TMPDIR: join(cacheRoot, 'tmp'),
  };
  // npm's own removal can race while replacing Git-sourced packages. Start
  // from an empty owned install, with bounded filesystem removal retries.
  if (command.length) rmSync(join(dir, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const result = command.length ? await runCommand(command, {
    cwd: dir, timeoutMs: 20 * 60_000,
    env: installEnv,
  }) : { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  const runtimePreparation: CommandResult[] = [];
  if (result.exitCode === 0 && !result.timedOut) {
    const preparationCommands: string[][] = [];
    if (existsSync(join(dir, 'node_modules/electron/install.js'))) {
      preparationCommands.push([process.execPath, 'node_modules/electron/install.js']);
    }
    if (existsSync(join(dir, 'node_modules/better-sqlite3/package.json'))) {
      preparationCommands.push(['npm', 'rebuild', 'better-sqlite3']);
    }
    for (const argv of preparationCommands) {
      const prepared = await runCommand(argv, { cwd: dir, timeoutMs: 20 * 60_000, env: installEnv });
      runtimePreparation.push(prepared);
      if (prepared.exitCode !== 0 || prepared.timedOut) break;
    }
  }
  const failedPreparation = runtimePreparation.find(step => step.exitCode !== 0 || step.timedOut);
  const receipt: DependencyReceipt = {
    fingerprint: fingerprint(files), files, command, exitCode: failedPreparation ? failedPreparation.exitCode : result.exitCode,
    timedOut: result.timedOut || (failedPreparation?.timedOut ?? false), nodeVersion: process.version, runtimePreparation, cacheRoot,
  };
  const output = [result, ...runtimePreparation].map(step => `${step.stdout}\n${step.stderr}`).join('\n');
  mkdirSync(join(dir, '_scratch'), { recursive: true });
  writeFileSync(join(dir, '_scratch/scoring-dependencies.log'), output);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'dependencies.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(join(evidenceDir, 'dependencies.log'), output);
  }
  if (receipt.exitCode !== 0 || receipt.timedOut) throw new Error(`scoring dependency setup failed (exit ${receipt.exitCode}, timedOut ${receipt.timedOut}); see _scratch/scoring-dependencies.log`);
  return receipt;
}

export function verifyScoringDependencies(dir: string, expected?: DependencyReceipt): DependencyReceipt {
  assertNoAncestorDependencies(dir);
  const files = manifests(dir);
  const receiptPath = join(dir, RECEIPT);
  if (Object.keys(files).length === 0 && !existsSync(receiptPath) && !expected) return {
    fingerprint: fingerprint(files), files, command: [], exitCode: 0, timedOut: false, nodeVersion: process.version, runtimePreparation: [], cacheRoot: join(dir, '_scratch/dependency-install-cache'),
  };
  if (!existsSync(receiptPath)) throw new Error('scoring dependency setup receipt missing');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as DependencyReceipt;
  if (receipt.exitCode !== 0 || receipt.timedOut) throw new Error('scoring dependency setup failed');
  if (receipt.fingerprint !== fingerprint(files) || receipt.nodeVersion !== process.version
    || (expected && receipt.fingerprint !== expected.fingerprint)) {
    throw new Error('scoring dependency manifests or Node version changed after setup');
  }
  if (existsSync(join(dir, 'node_modules')) && lstatSync(join(dir, 'node_modules')).isSymbolicLink()) {
    throw new Error('scoring dependency receipt cannot authorize a host node_modules symlink');
  }
  return receipt;
}
