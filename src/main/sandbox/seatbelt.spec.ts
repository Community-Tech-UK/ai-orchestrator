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


/**
 * LT-027 note: `buildSeatbeltCommand` now realpath-resolves roots, so a literal
 * `/tmp/...` expectation silently depends on whether that path happens to exist
 * on the machine running the suite (`/tmp` is a symlink to `/private/tmp` on
 * macOS). These fixtures are unique per run and their expectations are derived
 * the same way the implementation derives them, so the suite cannot be broken
 * by an unrelated scratch directory.
 */
const FIXTURE_A = `/tmp/aio-seatbelt-spec-a-${process.pid}`;
const FIXTURE_B = `/tmp/aio-seatbelt-spec-b-${process.pid}`;
/** What the builder must emit for a given root: nearest-existing-ancestor realpath + tail. */
function expectedRoot(root: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const resolve = (p: string): string => {
    try { return nodeFs.realpathSync(p); } catch {
      const parent = nodePath.dirname(p);
      return parent === p ? p : nodePath.join(resolve(parent), nodePath.basename(p));
    }
  };
  return resolve(nodePath.resolve(root));
}

const BASE = '(version 1)\n(deny default)\n(allow file-read*)';

describe('buildSeatbeltCommand', () => {
  beforeEach(() => _resetSeatbeltForTesting());

  it('wraps the command with sandbox-exec, param-gated writable roots via -D', () => {
    const wrapped = buildSeatbeltCommand({
      command: '/usr/local/bin/claude',
      args: ['--print', 'hi'],
      writableRoots: [FIXTURE_A, FIXTURE_A], // dedup
      basePolicy: BASE,
    });

    expect(wrapped.command).toBe(SANDBOX_EXEC_PATH);
    const policy = wrapped.args[1];
    expect(wrapped.args[0]).toBe('-p');
    // Generated clauses reference only fixed param KEYS…
    expect(policy).toContain('(allow file-write* (subpath (param "WRITABLE_ROOT_0")))');
    // …and never the raw path (injection safety).
    expect(policy).not.toContain(FIXTURE_A);
    expect(policy).not.toContain(expectedRoot(FIXTURE_A));
    // The value rides -D.
    expect(wrapped.args).toContain('-D');
    expect(wrapped.args).toContain(`WRITABLE_ROOT_0=${expectedRoot(FIXTURE_A)}`);
    // Deduped: no second root param.
    expect(wrapped.args.join(' ')).not.toContain('WRITABLE_ROOT_1');
    // Original command follows the separator.
    const sep = wrapped.args.indexOf('--');
    expect(wrapped.args.slice(sep + 1)).toEqual(['/usr/local/bin/claude', '--print', 'hi']);
  });

  it('supports multiple writable roots with sequential params', () => {
    const wrapped = buildSeatbeltCommand({
      command: 'codex', args: [], writableRoots: [FIXTURE_A, FIXTURE_B], basePolicy: BASE,
    });
    expect(wrapped.args).toContain(`WRITABLE_ROOT_0=${expectedRoot(FIXTURE_A)}`);
    expect(wrapped.args).toContain(`WRITABLE_ROOT_1=${expectedRoot(FIXTURE_B)}`);
    expect(wrapped.args[1]).toContain('WRITABLE_ROOT_1');
  });

  /**
   * LT-027. Seatbelt matches `subpath` against the REAL path, and on macOS both
   * `/tmp` and `os.tmpdir()` are symlinks — so unresolved roots granted no
   * write access at all. Measured: `mkdir` inside the unresolved root failed
   * `Operation not permitted`; with the realpath'd root it succeeded.
   */
  it('resolves writable roots through symlinks so the grant actually applies', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeOs = require('node:os') as typeof import('node:os');
    const symlinked = nodeOs.tmpdir();
    const real = nodeFs.realpathSync(symlinked);

    const wrapped = buildSeatbeltCommand({
      command: 'x', args: [], writableRoots: [symlinked], basePolicy: BASE,
    });

    expect(wrapped.args).toContain(`WRITABLE_ROOT_0=${real}`);
    if (real !== symlinked) {
      expect(wrapped.args).not.toContain(`WRITABLE_ROOT_0=${symlinked}`);
    }
  });

  it('passes through a root that does not exist yet rather than dropping it', () => {
    const missing = '/definitely/not/a/real/path/aio-test';
    const wrapped = buildSeatbeltCommand({
      command: 'x', args: [], writableRoots: [missing], basePolicy: BASE,
    });
    expect(wrapped.args).toContain(`WRITABLE_ROOT_0=${missing}`);
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

  /**
   * LT-026. Reading the login keychain is a mach-lookup to securityd, not a
   * file read — and the policy's own composition contract says read access is
   * broad "because CLIs need configs, keychains". Without this allowance every
   * provider CLI whose credentials live in the Keychain starts, fails to
   * authenticate and exits 1, so hardened mode killed every session it was
   * enabled on (observed: `Not logged in · Please run /login`, exit 1, 0.5 s
   * after spawn).
   */
  it('grants the keychain mach-lookup that credentialed CLIs need', () => {
    _resetSeatbeltForTesting();
    const policy = loadBasePolicy();
    expect(policy).toContain('com.apple.SecurityServer');
    expect(policy).toContain('com.apple.securityd.xpc');
  });
});

describe('classifySandboxFailure', () => {
  it('flags keyword failures as sandbox denials', () => {
    expect(classifySandboxFailure({ exitCode: 1, stderr: 'EPERM: Operation not permitted, open /etc/x' }))
      .toBe('sandbox-denial');
    expect(classifySandboxFailure({ exitCode: 1, stdout: 'Sandbox: deny(1) file-write-create' }))
      .toBe('sandbox-denial');
  });

  /**
   * LT-029. Hardened mode deliberately does not grant write access to
   * ~/Library/Keychains — that is the user's whole secret store. So a jailed
   * CLI can fail to refresh its token, and it reports that as an ordinary auth
   * error with nothing pointing at the sandbox. These pin that such a failure is
   * classified separately and gets the right remedy, not the "Allow path &
   * retry" advice (there is no path to allow).
   */
  it('classifies a credential failure separately from a file denial', () => {
    expect(classifySandboxFailure({ exitCode: 1, stdout: 'Not logged in · Please run /login' }))
      .toBe('credential-denial');
    expect(classifySandboxFailure({ exitCode: 1, stderr: 'API Error: 401 OAuth access token has been revoked' }))
      .toBe('credential-denial');
    expect(classifySandboxFailure({ exitCode: 1, stderr: 'Failed to authenticate.' }))
      .toBe('credential-denial');
  });

  it('advises re-authenticating outside the jail, not allowing a path', () => {
    const advice = buildSandboxExitAdvice({
      hardened: true, exitCode: 1, recentOutput: 'Not logged in · Please run /login',
    });
    expect(advice).toContain('does not grant write access to the system keychain');
    expect(advice).toContain('WITHOUT hardened mode');
    expect(advice).not.toContain('Allow path & retry');
  });

  it('still gives the path advice for a genuine file denial', () => {
    const advice = buildSandboxExitAdvice({
      hardened: true, exitCode: 1,
      recentOutput: "EPERM: operation not permitted, open '/Users/x/Desktop/probe.txt'",
    });
    expect(advice).toContain('Allow path & retry');
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
      writableRoots: [FIXTURE_A],
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
        writableRoots: [FIXTURE_A],
        available: false,
      }),
    ).toThrow(/refusing to spawn unsandboxed/);
  });

  it('wraps in sandbox-exec when hardened and available', () => {
    const result = resolveHardenedSpawn({
      hardened: true,
      command: 'claude',
      args: ['--print'],
      writableRoots: [FIXTURE_A],
      available: true,
      basePolicy: BASE,
    });
    expect(result.command).toBe(SANDBOX_EXEC_PATH);
    expect(result.args.slice(-3)).toEqual(['--', 'claude', '--print']);
    expect(result.args).toContain(`WRITABLE_ROOT_0=${expectedRoot(FIXTURE_A)}`);
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

  it('does not grant write access to ~/.cache (WS13 check 8, 2026-08-12 decision)', () => {
    // Measured live with the production buildSeatbeltCommand: neither Claude
    // nor Codex needed it (0 sandbox denials with or without), and it is the
    // single largest unjustified grant in the set (a 130 GB directory on the
    // machine measured). See the function's own doc comment for the evidence
    // and why the cross-provider-home half of the same finding is NOT applied.
    const roots = defaultHardenedWritableRoots('/tmp/my-project');
    expect(roots).not.toContain(path.join(os.homedir(), '.cache'));
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
