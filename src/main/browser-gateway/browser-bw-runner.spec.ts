import { describe, expect, it, vi } from 'vitest';
import { createBwRunner } from './browser-bw-runner';

type Captured = {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

type FakeChild = {
  stdin: { end: ReturnType<typeof vi.fn> };
};

type FakeExecArgs = [
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: 'utf-8' },
  callback: (
    error: (Error & { code?: number | string }) | null,
    stdout: string,
    stderr: string,
  ) => void,
];

function fakeExecFile(
  onCall: (c: Captured) => void,
  outcome: { error?: (Error & { code?: number }) | null; stdout?: string; stderr?: string },
  child: FakeChild = { stdin: { end: vi.fn() } },
) {
  return (...[file, args, options, callback]: FakeExecArgs): FakeChild => {
    onCall({ file, args, env: options.env });
    callback(outcome.error ?? null, outcome.stdout ?? '', outcome.stderr ?? '');
    return child;
  };
}

describe('createBwRunner', () => {
  it('passes the session via env only, never in argv', async () => {
    let captured: Captured | undefined;
    const runner = createBwRunner({
      binary: 'bw',
      baseEnv: { PATH: '/usr/bin' },
      execFileFn: fakeExecFile((c) => (captured = c), { stdout: '{"id":"x"}' }),
    });

    const result = await runner.run(['get', 'item', 'abc'], { session: 'SECRET-SESSION' });

    expect(result).toEqual({ stdout: '{"id":"x"}', stderr: '', code: 0 });
    expect(captured?.args).toEqual(['get', 'item', 'abc', '--nointeraction']);
    // The session must not appear in argv.
    expect(captured?.args.join(' ')).not.toContain('SECRET-SESSION');
    // It must be in the child env.
    expect(captured?.env['BW_SESSION']).toBe('SECRET-SESSION');
  });

  it('forces unlock and ordinary commands to be non-interactive without duplicating the flag', async () => {
    const captured: string[][] = [];
    const runner = createBwRunner({
      execFileFn: fakeExecFile((call) => captured.push(call.args), { stdout: 'ok' }),
    });

    await runner.run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw']);
    await runner.run(['list', 'folders', '--nointeraction'], { session: 'session' });

    expect(captured).toEqual([
      ['unlock', '--passwordenv', 'BW_PASSWORD', '--raw', '--nointeraction'],
      ['list', 'folders', '--nointeraction'],
    ]);
  });

  it('closes the child stdin so Bitwarden cannot wait on an interactive prompt', async () => {
    const end = vi.fn();
    const runner = createBwRunner({
      execFileFn: fakeExecFile(
        () => undefined,
        { stdout: 'ok' },
        { stdin: { end } },
      ),
    });

    await runner.run(['status']);

    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith();
  });

  it('does not set BW_SESSION when no session is supplied', async () => {
    let captured: Captured | undefined;
    const runner = createBwRunner({
      baseEnv: {},
      execFileFn: fakeExecFile((c) => (captured = c), { stdout: 'ok' }),
    });
    await runner.run(['sync']);
    expect(captured?.env['BW_SESSION']).toBeUndefined();
  });

  it('expands a stripped packaged-app PATH so Homebrew bw can be resolved', async () => {
    let captured: Captured | undefined;
    const runner = createBwRunner({
      baseEnv: { PATH: '/usr/bin:/bin' },
      platform: 'darwin',
      execFileFn: fakeExecFile((c) => (captured = c), { stdout: 'ok' }),
    });

    await runner.run(['status']);

    expect(captured?.env['PATH']?.split(':')).toContain('/opt/homebrew/bin');
  });

  it('resolves a non-zero result (not a rejection) with the exit code and stderr', async () => {
    const runner = createBwRunner({
      execFileFn: fakeExecFile(() => undefined, {
        error: Object.assign(new Error('boom'), { code: 1 }),
        stderr: 'not logged in',
      }),
    });
    const result = await runner.run(['get', 'item', 'x'], { session: 's' });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('not logged in');
  });

  it('invokes the configured binary path', async () => {
    let captured: Captured | undefined;
    const runner = createBwRunner({
      binary: '/opt/bw',
      execFileFn: fakeExecFile((c) => (captured = c), { stdout: '' }),
    });
    await runner.run(['sync'], { session: 's' });
    expect(captured?.file).toBe('/opt/bw');
  });
});
