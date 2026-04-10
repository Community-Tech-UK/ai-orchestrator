import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

import { checkClaudeCliAuthentication, getClaudeCliAuthStatus } from '../claude-cli-auth';

function mockExecFileSuccess(stdout: string, stderr = ''): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, stdout, stderr);
      return {} as ReturnType<typeof execFileMock>;
    }
  );
}

describe('claude-cli-auth', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses logged-in Claude auth status JSON', async () => {
    mockExecFileSuccess(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
      })
    );

    await expect(getClaudeCliAuthStatus()).resolves.toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    });
  });

  it('returns an authenticated result with Claude metadata when logged in', async () => {
    mockExecFileSuccess(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
      })
    );

    await expect(checkClaudeCliAuthentication()).resolves.toEqual({
      authenticated: true,
      message: 'Claude CLI authenticated via claude.ai (max)',
      metadata: {
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
      },
    });
  });

  it('returns a non-authenticated result when Claude is logged out', async () => {
    mockExecFileSuccess(
      JSON.stringify({
        loggedIn: false,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      })
    );

    await expect(checkClaudeCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Claude CLI is not logged in',
      metadata: {
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      },
    });
  });

  it('returns a failure result when auth status cannot be read', async () => {
    mockExecFileSuccess('not-json');

    await expect(checkClaudeCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Unable to read Claude CLI auth status',
    });
  });
});
