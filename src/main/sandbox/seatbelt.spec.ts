import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSeatbeltForTesting,
  buildSandboxExitAdvice,
  buildSeatbeltCommand,
  classifySandboxFailure,
  defaultHardenedWritableRoots,
  loadBasePolicy,
  resolveHardenedSpawn,
  SANDBOX_EXEC_PATH,
} from './seatbelt';
import * as os from 'node:os';
import * as path from 'node:path';

const BASE = '(version 1)\n(deny default)\n(allow file-read*)';

describe('buildSeatbeltCommand', () => {
  beforeEach(() => _resetSeatbeltForTesting());

  it('wraps the command with sandbox-exec, param-gated writable roots via -D', () => {
    const wrapped = buildSeatbeltCommand({
      command: '/usr/local/bin/claude',
      args: ['--print', 'hi'],
      writableRoots: ['/tmp/workspace', '/tmp/workspace'], // dedup
      basePolicy: BASE,
    });

    expect(wrapped.command).toBe(SANDBOX_EXEC_PATH);
    const policy = wrapped.args[1];
    expect(wrapped.args[0]).toBe('-p');
    // Generated clauses reference only fixed param KEYS…
    expect(policy).toContain('(allow file-write* (subpath (param "WRITABLE_ROOT_0")))');
    // …and never the raw path (injection safety).
    expect(policy).not.toContain('/tmp/workspace');
    // The value rides -D.
    expect(wrapped.args).toContain('-D');
    expect(wrapped.args).toContain('WRITABLE_ROOT_0=/tmp/workspace');
    // Deduped: no second root param.
    expect(wrapped.args.join(' ')).not.toContain('WRITABLE_ROOT_1');
    // Original command follows the separator.
    const sep = wrapped.args.indexOf('--');
    expect(wrapped.args.slice(sep + 1)).toEqual(['/usr/local/bin/claude', '--print', 'hi']);
  });

  it('supports multiple writable roots with sequential params', () => {
    const wrapped = buildSeatbeltCommand({
      command: 'codex', args: [], writableRoots: ['/a', '/b'], basePolicy: BASE,
    });
    expect(wrapped.args).toContain('WRITABLE_ROOT_0=/a');
    expect(wrapped.args).toContain('WRITABLE_ROOT_1=/b');
    expect(wrapped.args[1]).toContain('WRITABLE_ROOT_1');
  });

  it('fails closed with no writable roots', () => {
    expect(() =>
      buildSeatbeltCommand({ command: 'x', args: [], writableRoots: [], basePolicy: BASE }),
    ).toThrow(/at least one writable root/);
  });

  it('fails closed when the base policy is missing or not deny-by-default', () => {
    expect(() => loadBasePolicy('/nonexistent/policy.sbpl')).toThrow();
    _resetSeatbeltForTesting();
    // A permissive policy must be rejected outright.
    expect(() => {
      const tmp = `${process.env['TMPDIR'] ?? '/tmp'}/aio-bad-policy-${process.pid}.sbpl`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('node:fs') as typeof import('node:fs')).writeFileSync(tmp, '(version 1)(allow default)');
      try {
        loadBasePolicy(tmp);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('node:fs') as typeof import('node:fs')).unlinkSync(tmp);
      }
    }).toThrow(/deny-by-default/);
  });

  it('loads the real shipped base policy (deny default, param-free write section)', () => {
    _resetSeatbeltForTesting();
    const policy = loadBasePolicy();
    expect(policy).toContain('(deny default)');
    // The static file must not pre-grant broad writes — those are param-gated.
    expect(policy).not.toContain('(allow file-write* (regex');
  });
});

describe('classifySandboxFailure', () => {
  it('flags keyword failures as sandbox denials', () => {
    expect(classifySandboxFailure({ exitCode: 1, stderr: 'EPERM: Operation not permitted, open /etc/x' }))
      .toBe('sandbox-denial');
    expect(classifySandboxFailure({ exitCode: 1, stdout: 'Sandbox: deny(1) file-write-create' }))
      .toBe('sandbox-denial');
  });

  it('treats quick-reject exit codes without keywords as normal failures', () => {
    expect(classifySandboxFailure({ exitCode: 127, stderr: 'command not found: foo' })).toBe('normal-failure');
    expect(classifySandboxFailure({ exitCode: 2, stderr: 'usage: grep …' })).toBe('normal-failure');
  });

  it('keyword wins over quick-reject codes (codex ordering)', () => {
    expect(classifySandboxFailure({ exitCode: 126, stderr: 'permission denied: ./run.sh' }))
      .toBe('sandbox-denial');
  });

  it('exit 0 is never a denial', () => {
    expect(classifySandboxFailure({ exitCode: 0, stderr: 'sandbox' })).toBe('normal-failure');
  });
});

describe('resolveHardenedSpawn', () => {
  beforeEach(() => _resetSeatbeltForTesting());

  it('returns the command unchanged when not hardened', () => {
    const result = resolveHardenedSpawn({
      hardened: false,
      command: 'claude',
      args: ['--print'],
      writableRoots: ['/tmp/ws'],
      available: false,
    });
    expect(result).toEqual({ command: 'claude', args: ['--print'] });
  });

  it('FAILS CLOSED: throws when hardened but sandbox-exec is unavailable', () => {
    expect(() =>
      resolveHardenedSpawn({
        hardened: true,
        command: 'claude',
        args: [],
        writableRoots: ['/tmp/ws'],
        available: false,
      }),
    ).toThrow(/refusing to spawn unsandboxed/);
  });

  it('wraps in sandbox-exec when hardened and available', () => {
    const result = resolveHardenedSpawn({
      hardened: true,
      command: 'claude',
      args: ['--print'],
      writableRoots: ['/tmp/ws'],
      available: true,
      basePolicy: BASE,
    });
    expect(result.command).toBe(SANDBOX_EXEC_PATH);
    expect(result.args.slice(-3)).toEqual(['--', 'claude', '--print']);
    expect(result.args).toContain('WRITABLE_ROOT_0=/tmp/ws');
  });
});

describe('defaultHardenedWritableRoots', () => {
  it('includes the workspace, temp dir, and provider state homes', () => {
    const roots = defaultHardenedWritableRoots('/tmp/my-project');
    expect(roots).toContain('/tmp/my-project');
    expect(roots).toContain(os.tmpdir());
    expect(roots).toContain(path.join(os.homedir(), '.claude'));
    expect(roots).toContain(path.join(os.homedir(), '.codex'));
    expect(roots).toContain(path.join(os.homedir(), '.ai-orchestrator'));
  });

  it('omits the workspace entry when the working directory is undefined', () => {
    const roots = defaultHardenedWritableRoots(undefined);
    expect(roots[0]).toBe(os.tmpdir());
  });
});

describe('buildSandboxExitAdvice', () => {
  it('returns null for non-hardened instances regardless of output', () => {
    expect(
      buildSandboxExitAdvice({ hardened: false, exitCode: 1, recentOutput: 'operation not permitted' }),
    ).toBeNull();
  });

  it('returns null for a hardened instance whose exit is a normal failure', () => {
    expect(
      buildSandboxExitAdvice({ hardened: true, exitCode: 127, recentOutput: 'command not found' }),
    ).toBeNull();
  });

  it('returns the allow-and-retry advice on a hardened denial-classified exit', () => {
    const advice = buildSandboxExitAdvice({
      hardened: true,
      exitCode: 1,
      recentOutput: 'write failed: Operation not permitted',
    });
    expect(advice).toContain('Hardened mode (Seatbelt) likely blocked file access');
    expect(advice).toContain('Allow path & retry');
  });
});
