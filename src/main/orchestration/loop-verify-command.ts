import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

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
    if (parent === current) return null;
    current = parent;
  }
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
