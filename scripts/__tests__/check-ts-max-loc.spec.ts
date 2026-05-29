import { execFileSync, spawnSync } from 'node:child_process';
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

function runLocCheck(
  cwd: string,
  options: { args?: string[]; env?: Record<string, string> } = {},
): CheckResult {
  const { args = [], env = {} } = options;
  // spawnSync (rather than execFileSync) so stdout AND stderr are captured
  // regardless of exit code — warnings/notices go to stderr, the pass line to stdout.
  const result = spawnSync(tsxBin, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
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

  // The following tests use a real allowlisted path (preference-store.ts). They drive
  // the slack band via CHECK_TS_MAX_LOC_SLACK so they stay robust to the exact recorded
  // ceiling (they only assume the ceiling is below the 900-line fixture).
  it('reports allowlisted growth within the slack tolerance as a non-failing notice', () => {
    const repoDir = createTrackedRepo({
      'src/main/learning/preference-store.ts': 900,
    });

    const result = runLocCheck(repoDir, { env: { CHECK_TS_MAX_LOC_SLACK: '100000' } });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('within the');
    expect(result.output).toContain('preference-store.ts');
    expect(result.output).not.toContain('RATCHET EXCEEDED');
  });

  it('fails allowlisted files that grow beyond the slack tolerance', () => {
    const repoDir = createTrackedRepo({
      'src/main/learning/preference-store.ts': 900,
    });

    const result = runLocCheck(repoDir, { env: { CHECK_TS_MAX_LOC_SLACK: '0' } });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('RATCHET EXCEEDED');
    expect(result.output).toContain('preference-store.ts');
  });

  it('reports violations as warnings without failing when run with --warn', () => {
    const repoDir = createTrackedRepo({
      'src/main/example/large.ts': 705,
    });

    const result = runLocCheck(repoDir, { args: ['--warn'] });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      'TOO LARGE: src/main/example/large.ts has 705 lines (limit: 700).',
    );
    expect(result.output).toContain('warn-only mode');
  });
});
