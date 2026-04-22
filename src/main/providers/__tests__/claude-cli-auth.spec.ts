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

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T> | T,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  }
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

  it('uses Windows shell-aware spawn options when checking auth status', async () => {
    const originalEnv = {
      APPDATA: process.env['APPDATA'],
      LOCALAPPDATA: process.env['LOCALAPPDATA'],
      PATH: process.env['PATH'],
      ProgramFiles: process.env['ProgramFiles'],
      ProgramFilesX86: process.env['ProgramFiles(x86)'],
      USERPROFILE: process.env['USERPROFILE'],
    };

    process.env['APPDATA'] = 'C:\\Users\\User\\AppData\\Roaming';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] = 'C:\\Windows\\System32';
    process.env['ProgramFiles'] = 'C:\\Program Files';
    process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    process.env['USERPROFILE'] = 'C:\\Users\\User';

    mockExecFileSuccess(
      JSON.stringify({
        loggedIn: true,
      }),
    );

    try {
      await withPlatform('win32', () => getClaudeCliAuthStatus());

      const options = execFileMock.mock.calls[0]?.[2] as {
        env: NodeJS.ProcessEnv;
        shell: boolean;
        timeout: number;
        windowsHide: boolean;
      };

      expect(options).toMatchObject({
        shell: true,
        timeout: 5000,
        windowsHide: true,
      });
      expect(options.env['PATH']).toContain('C:\\Users\\User\\AppData\\Roaming\\npm');
      expect(options.env['PATH']).toContain('C:\\Windows\\System32');
    } finally {
      process.env['APPDATA'] = originalEnv.APPDATA;
      process.env['LOCALAPPDATA'] = originalEnv.LOCALAPPDATA;
      process.env['PATH'] = originalEnv.PATH;
      process.env['ProgramFiles'] = originalEnv.ProgramFiles;
      process.env['ProgramFiles(x86)'] = originalEnv.ProgramFilesX86;
      process.env['USERPROFILE'] = originalEnv.USERPROFILE;
    }
  });
});
