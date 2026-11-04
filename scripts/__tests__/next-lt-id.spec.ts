import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-next-lt-'));
  scratch.push(dir);
  const file = join(dir, 'register.md');
  writeFileSync(file, content);
  return spawnSync(process.execPath, [resolve('scripts/next-lt-id.mjs'), file], { encoding: 'utf8' });
}

describe('next live-test defect identifier', () => {
  it('uses the maximum index number, including grouped rows, and ignores out-of-order details', () => {
    const result = run('# Register\n## Remediation Index\n| ID | Priority | Required fix | Evidence source | Retest source |\n| --- | --- | --- | --- | --- |\n| LT-002 | P1 | Fix | Source | Source |\n| LT-070, LT-711 | P1 | Fix | Source | Source |\n| LT-010 | P1 | Fix | Source | Source |\n## LT-999 — unrelated detail\n| LT-1000 | example |\n## LT-003 — last heading\n');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('LT-712');
  });
  it('refuses a missing index rather than suggesting a colliding first identifier', () => {
    const result = run('# Register\n## LT-707\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/index/i);
  });
  it('refuses an index with no numeric identifier', () => {
    const result = run('## Remediation Index\n| ID | Status |\n| --- | --- |\n');
    expect(result.status).not.toBe(0);
  });
});
