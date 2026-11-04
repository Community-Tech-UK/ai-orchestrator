import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/next-lt-id.mjs');
const directories: string[] = [];
const indexHeader = '| ID | Priority | Required fix | Evidence source | Retest source |\n'
  + '| --- | --- | --- | --- | --- |';

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(markdown: string) {
  const directory = mkdtempSync(join(tmpdir(), 'next-lt-id-'));
  directories.push(directory);
  const register = join(directory, 'register.md');
  writeFileSync(register, '## Remediation Index\n' + markdown);
  return spawnSync(process.execPath, [script, register], { cwd: directory, encoding: 'utf8' });
}

describe('next-lt-id CLI', () => {
  it('uses the maximum index ID despite out-of-order rows and detail sections', () => {
    const result = run(`# Live-Test Remediation Register
| ID | Current status |
| --- | --- |
| LT-999 | Mention outside the index |

${indexHeader}
| LT-002 | P0 | Fix | LT-9000 | Source |
| LT-707 | P1 | Fix | Source | Source |
| LT-099 | P2 | Fix | Source | Source |

## LT-9999: Unindexed detail
| LT-8888 | A table in a detail section |
## LT-707: Latest indexed entry
## LT-002: Last heading
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LT-708\n');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['LT-009', 'LT-010'],
    ['LT-999', 'LT-1000'],
    ['LT-1000', 'LT-1001'],
  ])('increments %s numerically with at least three digits', (current, expected) => {
    const result = run(`${indexHeader}\r\n| ${current} | P1 | Fix | Source | Source |\r\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
  });

  it('includes later index rows after blank lines in the standing register', () => {
    const result = run(`${indexHeader}
| LT-303 | P2 | Fix | Source | Source |

| LT-706 | P2 | Fix | Source | Source |

## LT-303: Details
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LT-707\n');
  });

  it.each(['ID', 'LT status', 'LT-ID', 'LT-9999', ''])('stops at a separate table headed %s after blank-separated index rows', (heading) => {
    const result = run(`${indexHeader}\n| LT-707 | P1 | Fix | Source | Source |\n
| ${heading} | Current status |
| --- | --- |
| LT-9999 | Other table |
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LT-708\n');
    expect(result.stderr).toBe('');
  });

  it('accepts legacy index rows without the optional evidence columns', () => {
    const result = run(`${indexHeader}\n| LT-614 | P2 | Legacy fix |\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LT-615\n');
  });

  it.each([
    '| ID | Priority | Required fix | Evidence source | Retest source |\n| LT-707 | P1 | Fix | Source | Source |',
    `${indexHeader}\n| LT-707 |`,
    `${indexHeader}\n| LT-707 | P1 |`,
    `${indexHeader}\n| LT-broken | P1 | Fix |`,
    `${indexHeader}\n| LT-707 | P1 | Fix | Source | Source |\n| | P1 | Missing ID | Source | Source |\n| LT-708 | P1 | Allocated | Source | Source |`,
    `${indexHeader}\n| LT-707 | P1 | Fix | Source | Source |\n| LT708 | P1 | Mistyped ID | Source | Source |\n| LT-708 | P1 | Allocated | Source | Source |`,
  ])('rejects malformed index structure without printing an allocation', (markdown) => {
    const result = run(markdown);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Malformed remediation index');
  });

  it.each([
    '## LT-707: Heading without an index',
    `${indexHeader}\n`,
  ])('refuses to suggest an ID without indexed entries', (markdown) => {
    const result = run(markdown);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No LT IDs found in the remediation index');
  });
});
