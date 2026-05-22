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
  const packageJson = await readPackageJson(workspaceCwd);
  if (!packageJson) return null;

  const scripts = packageJson.scripts;
  if (!scripts) return null;

  if (isUsableScript(scripts['verify'])) {
    return {
      command: 'npm run verify',
      source: 'package.json script "verify"',
    };
  }

  const scriptNames = COMPOSABLE_NPM_VERIFY_SCRIPTS.filter((name) =>
    isUsableScript(scripts[name]),
  );
  if (scriptNames.length === 0) return null;

  return {
    command: scriptNames.map((name) => `npm run ${name}`).join(' && '),
    source: `package.json scripts: ${scriptNames.join(', ')}`,
  };
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
