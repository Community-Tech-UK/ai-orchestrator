import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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


const script = resolve('scripts/next-lt-id.mjs');
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-lt-reservation-'));
  scratch.push(dir);
  // No hooks or signing from the developer's global git settings may run in the fixture.
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  mkdirSync(join(dir, 'docs/plans'), { recursive: true });
  const register = join(dir, 'docs/plans/livetest-remediation-register.md');
  writeFileSync(register, '## Remediation Index\n| ID | Priority | Required fix | Evidence source | Retest source |\n| --- | --- | --- | --- | --- |\n| LT-007 | P1 | Fix | Source | Source |\n');
  return { dir, git, register, ledger: join(dir, '.git/aio-lt-reservations') };
}

function reserve(cwd: string, extra: string[] = []) {
  return spawnSync(process.execPath, [...extra, script, '--reserve'], { cwd, encoding: 'utf8' });
}

describe('durable root defect reservations', () => {
  it('gives concurrent callers distinct identifiers without adding register rows', async () => {
    const { dir, ledger } = repository();
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolveResult, reject) => {
      const child = spawn(process.execPath, [script, '--reserve'], { cwd: dir });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(stderr)));
    })));
    expect(new Set(results).size).toBe(8);
    expect(results.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `LT-${String(i + 8).padStart(3, '0')}`));
    expect(readdirSync(ledger).sort()).toEqual(results.sort());
  });

  it('uses the common root register and ledger from a stale linked checkout', () => {
    const { dir, git, register } = repository();
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    const linked = join(dir, 'linked');
    git('worktree', 'add', '--quiet', '--detach', linked);
    writeFileSync(register, '## Remediation Index\n| ID | Current status |\n| --- | --- |\n| LT-050 | Root-only uncommitted finding |\n');
    expect(reserve(linked).stdout).toBe('LT-051\n');
    expect(reserve(dir).stdout).toBe('LT-052\n');
    const outside = spawnSync(process.execPath, [script, '--reserve', join(linked, 'docs/plans/livetest-remediation-register.md')], { cwd: linked, encoding: 'utf8' });
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain('authoritative root register');
  });

  it('never recycles an empty interrupted claim or one fsynced before a process crash', () => {
    const { dir, ledger } = repository();
    mkdirSync(ledger);
    writeFileSync(join(ledger, 'LT-008'), '');
    const hook = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.fsyncSync; let calls = 0;
      fs.fsyncSync = fd => { original(fd); if (++calls === 2) process.kill(process.pid, 'SIGKILL'); };
      syncBuiltinESMExports();`;
    const crashed = reserve(dir, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`]);
    expect(crashed.signal).toBe('SIGKILL');
    expect(crashed.stdout).toBe('');
    expect(readdirSync(ledger).sort()).toEqual(['LT-008', 'LT-009']);
    expect(reserve(dir).stdout).toBe('LT-010\n');
  });

  it('fails closed on malformed ledger entries and never deletes them', () => {
    const { dir, ledger } = repository();
    mkdirSync(ledger);
    writeFileSync(join(ledger, 'unexpected'), 'preserve');
    const result = reserve(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Malformed reservation ledger');
    expect(readdirSync(ledger)).toEqual(['unexpected']);
  });
});


it('refuses redirected reservation storage without writing through it', () => {
  const { dir, ledger } = repository();
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, ledger, 'dir');
  const result = reserve(dir);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('not a symlink');
  expect(readdirSync(elsewhere)).toEqual([]);
});

it('reports bounded contention rather than removing another caller’s claim', () => {
  const { dir } = repository();
  const hook = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.openSync; let now = 0; Date.now = () => now += 1000;
    fs.openSync = (p, flags, ...args) => {
      if (flags === 'wx') throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
      return original(p, flags, ...args);
    }; syncBuiltinESMExports();`;
  const result = reserve(dir, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('contention exceeded five seconds');
});

it('never prints an identifier if the durable flush fails, and burns that claim', () => {
  const { dir, ledger } = repository();
  const hook = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.fsyncSync; let calls = 0;
    fs.fsyncSync = fd => { if (++calls === 2) throw new Error('injected flush failure'); original(fd); };
    syncBuiltinESMExports();`;
  const result = reserve(dir, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('injected flush failure');
  expect(readdirSync(ledger)).toEqual(['LT-008']);
  expect(reserve(dir).stdout).toBe('LT-009\n');
});
