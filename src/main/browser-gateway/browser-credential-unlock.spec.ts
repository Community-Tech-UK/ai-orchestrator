import { describe, expect, it, vi } from 'vitest';
import { unlockCredentialVault } from './browser-credential-unlock';
import type { BwCommandResult, BwRunner } from './browser-credential-vault';

function makeSession() {
  const tokens: string[] = [];
  return {
    tokens,
    session: { unlock: (t: string) => tokens.push(t) },
  };
}

function runnerReturning(outcome: BwCommandResult): { runner: BwRunner; calls: Array<{ args: string[]; env?: Record<string, string> }> } {
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  return {
    calls,
    runner: {
      run: async (args, opts) => {
        calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
        return outcome;
      },
    },
  };
}

describe('unlockCredentialVault', () => {
  it('unlocks and stores the raw session token, passing the password via env only', async () => {
    const { session, tokens } = makeSession();
    const { runner, calls } = runnerReturning({ stdout: 'RAW-SESSION-TOKEN\n', stderr: '', code: 0 });

    const result = await unlockCredentialVault({
      runner,
      session,
      getMasterPassword: async () => 'master-pw',
    });

    expect(result).toEqual({ unlocked: true });
    expect(tokens).toEqual(['RAW-SESSION-TOKEN']);
    // Password went via env, never argv.
    expect(calls[0]?.args).toEqual(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw']);
    expect(calls[0]?.args.join(' ')).not.toContain('master-pw');
    expect(calls[0]?.env).toEqual({ BW_PASSWORD: 'master-pw' });
  });

  it('does not run bw when the master password is empty', async () => {
    const { session } = makeSession();
    const runner = { run: vi.fn() };
    const result = await unlockCredentialVault({
      runner: runner as unknown as BwRunner,
      session,
      getMasterPassword: async () => '',
    });
    expect(result).toEqual({ unlocked: false, reason: 'empty_password' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reports failure when bw unlock exits non-zero', async () => {
    const { session, tokens } = makeSession();
    const { runner } = runnerReturning({ stdout: '', stderr: 'Invalid master password.', code: 1 });
    const result = await unlockCredentialVault({ runner, session, getMasterPassword: async () => 'wrong' });
    expect(result).toMatchObject({ unlocked: false, reason: 'bw_unlock_failed' });
    expect(tokens).toHaveLength(0);
  });

  it('reports failure when bw returns an empty session', async () => {
    const { session } = makeSession();
    const { runner } = runnerReturning({ stdout: '   ', stderr: '', code: 0 });
    const result = await unlockCredentialVault({ runner, session, getMasterPassword: async () => 'pw' });
    expect(result).toMatchObject({ unlocked: false, reason: 'empty_session' });
  });
});
