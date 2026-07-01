import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { interpolateConfigString } from '../config-interpolation';

describe('interpolateConfigString', () => {
  it('returns the input unchanged with no I/O when no token is present', async () => {
    const read = vi.fn();
    const r = await interpolateConfigString('plain text, no tokens', { readFile: read });
    expect(r.content).toBe('plain text, no tokens');
    expect(r.interpolated).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('resolves a non-secret {env:VAR} from the provided env', async () => {
    const r = await interpolateConfigString('name={env:PROJECT_NAME}', { env: { PROJECT_NAME: 'orchestrator' } });
    expect(r.content).toBe('name=orchestrator');
    expect(r.interpolated).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('blocks secret-shaped {env:VAR} names by default to prevent exfiltration', async () => {
    for (const name of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'MY_KEY']) {
      const r = await interpolateConfigString(`v={env:${name}}`, { env: { [name]: 'super-secret' } });
      expect(r.content).toBe('v=');
      expect(r.warnings.join(' ')).toMatch(/looks like a secret/i);
    }
  });

  it('allows secret-shaped env only when the caller explicitly opts in', async () => {
    const r = await interpolateConfigString('v={env:MY_API_KEY}', {
      env: { MY_API_KEY: 'tok' },
      allowSecretEnv: true,
    });
    expect(r.content).toBe('v=tok');
  });

  it('uses the :- default when the env var is unset or empty', async () => {
    const r1 = await interpolateConfigString('v={env:NOPE:-fallback}', { env: {} });
    expect(r1.content).toBe('v=fallback');
    expect(r1.warnings).toHaveLength(0);

    const r2 = await interpolateConfigString('v={env:EMPTY:-fallback}', { env: { EMPTY: '' } });
    expect(r2.content).toBe('v=fallback');
  });

  it('resolves an unset {env:VAR} without default to empty and warns', async () => {
    const r = await interpolateConfigString('v={env:MISSING}', { env: {} });
    expect(r.content).toBe('v=');
    expect(r.warnings.join(' ')).toMatch(/MISSING.*empty/i);
  });

  it('resolves {file:path} via the injected reader', async () => {
    const read = vi.fn(async () => 'FILE CONTENTS');
    const r = await interpolateConfigString('doc:\n{file:notes.md}', { cwd: '/proj', readFile: read });
    expect(r.content).toBe('doc:\nFILE CONTENTS');
    // path is resolved against cwd
    expect(read.mock.calls[0][0]).toBe('/proj/notes.md');
  });

  it('handles multiple distinct file tokens in order', async () => {
    const read = vi.fn(async (p: string) => (p.endsWith('a.txt') ? 'AAA' : 'BBB'));
    const r = await interpolateConfigString('{file:a.txt}-{file:b.txt}', { cwd: '/p', readFile: read });
    expect(r.content).toBe('AAA-BBB');
  });

  it('truncates a file that exceeds maxFileBytes and warns', async () => {
    const big = 'x'.repeat(100);
    const read = vi.fn(async () => big);
    const r = await interpolateConfigString('{file:big.txt}', { readFile: read, maxFileBytes: 10 });
    expect(r.content).toBe('x'.repeat(10));
    expect(r.warnings.join(' ')).toMatch(/truncated/i);
  });

  it('warns and substitutes empty when a file cannot be read', async () => {
    const read = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const r = await interpolateConfigString('before{file:gone.txt}after', { readFile: read });
    expect(r.content).toBe('beforeafter');
    expect(r.warnings.join(' ')).toMatch(/could not be read.*ENOENT/i);
  });

  it('does NOT re-interpolate resolved content (single-pass anti-injection)', async () => {
    // A file whose contents contain another token must NOT trigger a second read.
    const read = vi.fn(async () => 'malicious {file:/etc/shadow} {env:SECRET}');
    const r = await interpolateConfigString('{file:evil.txt}', { readFile: read, env: { SECRET: 'nope' } });
    expect(r.content).toBe('malicious {file:/etc/shadow} {env:SECRET}');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not resolve command tokens in untrusted instruction interpolation', async () => {
    const read = vi.fn();
    const r = await interpolateConfigString('${cmd:security find-generic-password -w -s aio}', { readFile: read });
    expect(r.content).toBe('${cmd:security find-generic-password -w -s aio}');
    expect(r.interpolated).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects ~ home-relative file paths (no arbitrary read)', async () => {
    const read = vi.fn(async () => 'home file');
    const r = await interpolateConfigString('{file:~/.ssh/id_rsa}', { cwd: '/proj', readFile: read });
    expect(r.content).toBe('');
    expect(r.warnings.join(' ')).toMatch(/home-relative paths are not allowed/i);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects absolute file paths outside the project root', async () => {
    const read = vi.fn(async () => 'root secrets');
    const r = await interpolateConfigString('{file:/etc/passwd}', { cwd: '/proj', readFile: read });
    expect(r.content).toBe('');
    expect(r.warnings.join(' ')).toMatch(/outside the project root/i);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects ../ traversal escaping the project root', async () => {
    const read = vi.fn(async () => 'escaped');
    const r = await interpolateConfigString('{file:../../etc/passwd}', { cwd: '/proj/sub', readFile: read });
    expect(r.content).toBe('');
    expect(r.warnings.join(' ')).toMatch(/outside the project root/i);
    expect(read).not.toHaveBeenCalled();
  });

  it('blocks a symlink that resolves outside the project root', async () => {
    const read = vi.fn(async () => 'symlinked secret');
    // realpath maps the in-tree path to an out-of-tree real location.
    const realpath = vi.fn(async (p: string) =>
      p === '/proj/link.txt' ? '/etc/shadow' : p,
    );
    const r = await interpolateConfigString('{file:link.txt}', { cwd: '/proj', readFile: read, realpath });
    expect(r.content).toBe('');
    expect(r.warnings.join(' ')).toMatch(/symlink outside the project root/i);
    expect(read).not.toHaveBeenCalled();
  });

  it('allows an in-root file whose realpath stays inside the root', async () => {
    const read = vi.fn(async () => 'ok');
    const realpath = vi.fn(async (p: string) => p); // identity: stays in-root
    const r = await interpolateConfigString('{file:notes.md}', { cwd: '/proj', readFile: read, realpath });
    expect(r.content).toBe('ok');
    expect(read).toHaveBeenCalledWith('/proj/notes.md', expect.any(Number));
  });

  it('resolves env before files and both together', async () => {
    const read = vi.fn(async () => 'CONTENT');
    const r = await interpolateConfigString('{env:NAME}: {file:doc.md}', {
      env: { NAME: 'Report' },
      readFile: read,
    });
    expect(r.content).toBe('Report: CONTENT');
  });
});
