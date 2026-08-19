import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

import { checkCodexCliAuthentication } from '../codex-cli-auth';

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

function mockExecFileFailure(stdout: string, stderr = ''): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const error = Object.assign(new Error('Command failed'), { stdout, stderr });
      callback(error, stdout, stderr);
      return {} as ReturnType<typeof execFileMock>;
    }
  );
}

describe('codex-cli-auth', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('reports authenticated when logged in via ChatGPT', async () => {
    mockExecFileSuccess('Logged in using ChatGPT');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: true,
      message: 'Codex CLI authenticated via ChatGPT',
      metadata: {
        authMethod: 'chatgpt',
        rawOutput: 'Logged in using ChatGPT',
      },
    });
  });

  it('reports authenticated when logged in via API key', async () => {
    mockExecFileSuccess('Logged in using an API key');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: true,
      message: 'Codex CLI authenticated via API key',
      metadata: {
        authMethod: 'api-key',
        rawOutput: 'Logged in using an API key',
      },
    });
  });

  // Regression for the substring trap: "Not logged in" contains "logged in"
  // as a substring, so a naive `.includes('logged in')` check-first-wins
  // ordering misclassifies a genuine sign-out as authenticated.
  it('reports NOT authenticated when the CLI says "Not logged in" (exit 0)', async () => {
    mockExecFileSuccess('Not logged in');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Codex CLI is not logged in',
      metadata: {
        rawOutput: 'Not logged in',
      },
    });
  });

  it('reports NOT authenticated when the CLI exits non-zero with "Not logged in"', async () => {
    mockExecFileFailure('Not logged in');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Codex CLI is not logged in',
      metadata: {
        rawOutput: 'Not logged in',
      },
    });
  });

  it('reports NOT authenticated on "login required"', async () => {
    mockExecFileSuccess('login required');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Codex CLI is not logged in',
      metadata: {
        rawOutput: 'login required',
      },
    });
  });

  it('reports NOT authenticated on "logged out"', async () => {
    mockExecFileSuccess('logged out');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Codex CLI is not logged in',
      metadata: {
        rawOutput: 'logged out',
      },
    });
  });

  it('falls back to "unable to read" for unrecognised output', async () => {
    mockExecFileSuccess('some unexpected banner text');

    await expect(checkCodexCliAuthentication()).resolves.toEqual({
      authenticated: false,
      message: 'Unable to read Codex CLI login status',
      metadata: {
        rawOutput: 'some unexpected banner text',
      },
    });
  });
});
