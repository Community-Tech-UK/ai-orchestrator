import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from './config';

const temps: string[] = [];

function writeConfig(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-ex-ab-config-'));
  temps.push(root);
  // Mirrors the real layout: <checkout>/benchmarks/plan-execute-ab/runner.config.json
  const dir = join(root, 'benchmarks', 'plan-execute-ab');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'runner.config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('keeps the committed default export workspace inside its checkout', () => {
    const path = join(process.cwd(), 'benchmarks/plan-execute-ab/runner.config.json');
    expect(readConfig(path).workRoot).toBe(join(process.cwd(), '_scratch/plan-execute-ab/workspaces'));
  });
  it('resolves relative repoPaths against the checkout that carries the config (LT-709)', () => {
    // Regression: workspaces linked a foreign checkout's node_modules whenever
    // repoPaths named one, and a worktree-internal workRoot let ancestor
    // installs leak into scoring. `.` must mean "the checkout the benchmark
    // runs from" — resolved from the config file, not the process CWD.
    const path = writeConfig({
      repoPaths: { 'ai-orchestrator': '.', other: 'repos/other' },
      resultsRoot: '_scratch/plan-execute-ab',
      workRoot: '/tmp/plan-execute-ab',
    });
    const config = readConfig(path);
    const checkout = resolve(path, '..', '..', '..');
    expect(config.repoPaths['ai-orchestrator']).toBe(checkout);
    expect(config.repoPaths['other']).toBe(join(checkout, 'repos/other'));
    expect(config.workRoot).toBe('/tmp/plan-execute-ab');
  });

  it('keeps absolute repoPaths as given', () => {
    const path = writeConfig({ repoPaths: { twelve: '/Users/suas/work/12steps' } });
    expect(readConfig(path).repoPaths['twelve']).toBe('/Users/suas/work/12steps');
  });
});
