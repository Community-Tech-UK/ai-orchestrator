import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/claude-cost-audit-report.mjs');
const tempDirs: string[] = [];

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
}

function createUserDataFixture(): string {
  const userData = mkdtempSync(join(tmpdir(), 'claude-cost-audit-'));
  tempDirs.push(userData);
  mkdirSync(join(userData, 'cost-attribution'), { recursive: true });
  mkdirSync(join(userData, 'rlm'), { recursive: true });
  mkdirSync(join(userData, 'loop-mode'), { recursive: true });

  writeFileSync(
    join(userData, 'cost-attribution', 'cost-attribution-test.jsonl'),
    '{"ts":9999999999999,"source":"one-shot","taskType":"verify-orchestration","provider":"claude","model":"opus","usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":7,"cacheWriteTokens":11,"cost":0.1234},"costKnown":true}\n',
  );

  execFileSync('sqlite3', [
    join(userData, 'rlm', 'rlm.db'),
    `CREATE TABLE cost_entries (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0
    );
    INSERT INTO cost_entries VALUES ('c1', 9999999999999, 'i1', 's1', 'opus', 10, 5, 2, 3, 0.0456);`,
  ]);

  execFileSync('sqlite3', [
    join(userData, 'loop-mode', 'loop-mode.db'),
    `CREATE TABLE loop_iterations (
      loop_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO loop_iterations VALUES ('loop-1', 9999999999999, 1234, 789);`,
  ]);

  return userData;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!hasSqlite3())('claude-cost-audit-report', () => {
  it('uses sqlite3 CLI fallback for read-only cross-checks when requested', () => {
    const userData = createUserDataFixture();
    const result = spawnSync(process.execPath, [scriptPath, '--userdata', userData, '--since', '2026-01-01'], {
      encoding: 'utf8',
      env: { ...process.env, AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(output).toContain('| verify-orchestration [claude/opus] | 1 | 100 | 50 | 7/11 | $0.1234 | 100.0% |');
    expect(output).toContain('(using sqlite3 CLI fallback for');
    expect(output).toContain('| opus | 1 | 10 | 5 | 2/3 | $0.0456 |');
    expect(output).toContain('| loop-1 | 1 | 1,234 | $7.8900 |');
  });
});
