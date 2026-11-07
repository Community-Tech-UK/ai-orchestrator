import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSelfTest } from './self-test';

let workRoot: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'plan-ex-ab-self-'));
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('runner self-test', () => {
  it('passes every dry harness check, including catching a deliberately broken patch', async () => {
    const result = await runSelfTest(workRoot);
    const failures = result.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
    expect(failures).toEqual([]);
    expect(result.passed).toBe(true);
    const names = result.checks.map((check) => check.name);
    expect(names.some((name) => name.includes('broken patch is caught'))).toBe(true);
  }, 60_000);
});
