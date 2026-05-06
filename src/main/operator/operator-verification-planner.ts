import * as fs from 'fs/promises';
import * as path from 'path';
import type { OperatorVerificationProjectKind } from '../../shared/types/operator.types';

export interface OperatorVerificationCheck {
  label: string;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
}

export interface OperatorVerificationPlan {
  projectPath: string;
  kinds: OperatorVerificationProjectKind[];
  checks: OperatorVerificationCheck[];
  fallbackReason?: string;
}

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export async function planProjectVerification(projectPath: string): Promise<OperatorVerificationPlan> {
  const normalizedPath = path.resolve(projectPath);
  const packageJson = await readPackageJson(normalizedPath);
  const hasTsconfig = await exists(path.join(normalizedPath, 'tsconfig.json'));
  const hasTsconfigSpec = await exists(path.join(normalizedPath, 'tsconfig.spec.json'));

  if (packageJson) {
    const scripts = packageJson.scripts ?? {};
    const kinds: OperatorVerificationProjectKind[] = ['node'];
    if (hasTsconfig) {
      kinds.push('typescript');
    }
    const checks: OperatorVerificationCheck[] = [];
    if (typeof scripts['typecheck'] === 'string') {
      checks.push(check('typecheck', 'npm', ['run', 'typecheck'], true));
    } else if (hasTsconfig) {
      checks.push(check('typecheck', 'npx', ['tsc', '--noEmit'], true));
    }
    if (hasTsconfigSpec && !scriptCoversSpecTypecheck(scripts['typecheck'])) {
      checks.push(check('spec-typecheck', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.spec.json'], true));
    }
    if (typeof scripts['test'] === 'string') {
      checks.push(check('test', 'npm', ['test', '--', '--run', '--watch=false'], true));
    }
    if (typeof scripts['lint'] === 'string') {
      checks.push(check('lint', 'npm', ['run', 'lint'], false));
    }
    return { projectPath: normalizedPath, kinds, checks };
  }

  if (await exists(path.join(normalizedPath, 'tsconfig.json'))) {
    return {
      projectPath: normalizedPath,
      kinds: ['typescript'],
      checks: [check('typecheck', 'npx', ['tsc', '--noEmit'], true)],
    };
  }

  if (await exists(path.join(normalizedPath, 'Cargo.toml'))) {
    return {
      projectPath: normalizedPath,
      kinds: ['rust'],
      checks: [check('test', 'cargo', ['test'], true)],
    };
  }

  if (await exists(path.join(normalizedPath, 'pom.xml'))) {
    return {
      projectPath: normalizedPath,
      kinds: ['maven'],
      checks: [check('test', 'mvn', ['test'], true)],
    };
  }

  if (
    await exists(path.join(normalizedPath, 'build.gradle'))
    || await exists(path.join(normalizedPath, 'build.gradle.kts'))
  ) {
    const wrapperCommand = await exists(path.join(normalizedPath, 'gradlew')) ? './gradlew' : 'gradle';
    return {
      projectPath: normalizedPath,
      kinds: ['gradle'],
      checks: [check('test', wrapperCommand, ['test'], true)],
    };
  }

  if (await exists(path.join(normalizedPath, 'go.mod'))) {
    return {
      projectPath: normalizedPath,
      kinds: ['go'],
      checks: [check('test', 'go', ['test', './...'], true)],
    };
  }

  if (
    await exists(path.join(normalizedPath, 'pyproject.toml'))
    || await exists(path.join(normalizedPath, 'requirements.txt'))
  ) {
    return {
      projectPath: normalizedPath,
      kinds: ['python'],
      checks: [check('test', 'python', ['-m', 'pytest'], true)],
    };
  }

  return {
    projectPath: normalizedPath,
    kinds: ['unknown'],
    checks: [],
    fallbackReason: 'No recognized project manifest found',
  };
}

function check(
  label: string,
  command: string,
  args: string[],
  required: boolean,
): OperatorVerificationCheck {
  return {
    label,
    command,
    args,
    required,
    timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
  };
}

async function readPackageJson(projectPath: string): Promise<{ scripts?: Record<string, unknown> } | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { scripts?: Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

function scriptCoversSpecTypecheck(script: unknown): boolean {
  return typeof script === 'string' && /\btsconfig\.spec\.json\b|\btsconfig\.spec\b/.test(script);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
