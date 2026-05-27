import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/check-ts-max-loc.ts');
const tsxBin = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

interface CheckResult {
  exitCode: number;
  output: string;
}

const tempRepos: string[] = [];

function makeTypeScriptLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join(
    '\n',
  );
}

function createTrackedRepo(files: Record<string, number>): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-ts-max-loc-'));
  tempRepos.push(repoDir);

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  for (const [relPath, lineCount] of Object.entries(files)) {
    const absPath = resolve(repoDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, makeTypeScriptLines(lineCount));
  }

  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

function runLocCheck(cwd: string): CheckResult {
  try {
    const output = execFileSync(tsxBin, [scriptPath], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output };
  } catch (error) {
    const { status, stderr, stdout } = error as {
      status?: number;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    return {
      exitCode: status ?? 1,
      output: `${String(stdout ?? '')}${String(stderr ?? '')}`,
    };
  }
}

afterEach(() => {
  while (tempRepos.length > 0) {
    rmSync(tempRepos.pop()!, { recursive: true, force: true });
  }
});

describe('check-ts-max-loc', () => {
  it('skips tracked spec, test, and __tests__ files when enforcing max LOC', () => {
    const repoDir = createTrackedRepo({
      'src/main/example/large.spec.ts': 705,
      'src/main/example/large.test.ts': 706,
      'src/main/example/__tests__/large-helper.ts': 707,
    });

    const result = runLocCheck(repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('TypeScript file size ratchet passed.');
  });

  it('still fails tracked production TypeScript files over the max LOC', () => {
    const repoDir = createTrackedRepo({
      'src/main/example/large.ts': 705,
    });

    const result = runLocCheck(repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      'TOO LARGE: src/main/example/large.ts has 705 lines (limit: 700).',
    );
  });
});
