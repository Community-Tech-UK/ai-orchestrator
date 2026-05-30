import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

export interface InferredLoopVerifyCommand {
  command: string;
  source: string;
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

  if (isUsableScript(scripts['verify'])) {
    return {
      command: npmRunCommand('verify', packageDir, requestedWorkspace),
      source: 'package.json script "verify"',
    };
  }

  const scriptNames = COMPOSABLE_NPM_VERIFY_SCRIPTS.filter((name) =>
    isUsableScript(scripts[name]),
  );
  if (scriptNames.length === 0) return null;

  return {
    command: scriptNames.map((name) => npmRunCommand(name, packageDir, requestedWorkspace)).join(' && '),
    source: `package.json scripts: ${scriptNames.join(', ')}`,
  };
}

function npmRunCommand(
  scriptName: string,
  packageDir: string,
  requestedWorkspace: string,
): string {
  if (path.resolve(packageDir) === path.resolve(requestedWorkspace)) {
    return `npm run ${scriptName}`;
  }
  return `npm --prefix ${quoteShellArg(packageDir)} run ${scriptName}`;
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
