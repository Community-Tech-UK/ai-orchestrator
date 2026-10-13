import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectOpenCodeLaunch } from './opencode-cli-launch';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), lookup: vi.fn(), safeEnv: vi.fn() }));
vi.mock('./opencode-effective-budget-config', () => ({ runOpenCodeCapture: mocks.capture }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: mocks.lookup, default: { ...actual, spawnSync: mocks.lookup } };
});
vi.mock('../../security/env-filter', () => ({ getSafeEnvForTrustedProcess: mocks.safeEnv }));

describe('OpenCode CLI selection', () => {
  const params = { workingDirectory: '/tmp', env: {}, candidates: ['/opt/old/opencode', '/Applications/OpenCode.app/Contents/Resources/opencode-cli'] };
  let fixtureRoot: string;
  beforeEach(() => {
    vi.clearAllMocks();
    fixtureRoot = mkdtempSync(join(tmpdir(), 'opencode-launch-'));
    mocks.safeEnv.mockReturnValue({ HOME: join(fixtureRoot, 'inherited-home'), PATH: join(fixtureRoot, 'inherited-bin') });
    mocks.lookup.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => ({
      status: 0,
      stdout: (options.env['PATH'] ?? '').split(delimiter)
        .map((directory) => join(directory, 'opencode'))
        .filter((candidate) => candidate.startsWith(fixtureRoot) && existsSync(candidate)).join('\n'),
    }));
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => {
      if (call.command.endsWith('/old/opencode')) return { code: 1, stdout: '' };
      if (call.args[0] === '--version') return { code: 0, stdout: 'opencode v2.0.18\n' };
      return { code: 0, stdout: '[]' };
    });
  });
  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  function installAt(...parts: string[]): string {
    const directory = join(fixtureRoot, ...parts);
    mkdirSync(directory, { recursive: true });
    const command = join(directory, 'opencode');
    writeFileSync(command, 'fixture executable');
    return command;
  }

  it('discovers the user installation with an overrides-only factory environment', async () => {
    const userCommand = installAt('inherited-home', '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    const fallbackCommand = installAt('inherited-bin');
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => ({
      code: 0,
      stdout: call.args[0] === '--version' ? (call.command === userCommand ? '1.19.0' : '2.0.18') : '{}',
    }));
    await expect(selectOpenCodeLaunch({ workingDirectory: fixtureRoot, env: { NODE_ENV: 'test' } }))
      .resolves.toEqual({ command: userCommand, major: 1 });
    expect(mocks.lookup.mock.results[0]?.value.stdout.split('\n')).toEqual([userCommand, fallbackCommand]);
    expect(mocks.capture.mock.calls.every(([call]) => call.command === userCommand)).toBe(true);
  });

  it('keeps caller HOME and PATH overrides ahead of inherited values', async () => {
    installAt('inherited-home', '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    installAt('inherited-bin');
    const callerCommand = installAt('caller-home', '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    const callerPathCommand = installAt('caller-bin');
    await expect(selectOpenCodeLaunch({ workingDirectory: fixtureRoot,
      env: { HOME: join(fixtureRoot, 'caller-home'), PATH: join(fixtureRoot, 'caller-bin') },
    })).resolves.toEqual({ command: callerCommand, major: 2 });
    expect(mocks.lookup.mock.results[0]?.value.stdout.split('\n')).toEqual([callerCommand, callerPathCommand]);
  });

  it('finds an inherited PATH-only installation when no user install exists', async () => {
    const command = installAt('inherited-bin');
    await expect(selectOpenCodeLaunch({ workingDirectory: fixtureRoot, env: {} }))
      .resolves.toEqual({ command, major: 2 });
  });

  it('skips a CLI that cannot print config and uses the next install', async () => {
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({
      command: '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
      major: 2,
    });
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args])).toEqual([
      ['/opt/old/opencode', ['debug', 'config']],
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', ['debug', 'config']],
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', ['--version']],
    ]);
  });

  it('keeps the first CLI that prints a config document', async () => {
    mocks.capture.mockImplementation(async (call: { args: string[] }) => (
      call.args[0] === '--version' ? { code: 0, stdout: '1.18.35\n' } : { code: 0, stdout: '{}' }
    ));
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({ command: '/opt/old/opencode', major: 1 });
  });

  it('refuses startup when every install fails the config read', async () => {
    mocks.capture.mockResolvedValue({ code: 1, stdout: '' });
    await expect(selectOpenCodeLaunch(params)).rejects.toThrow(/^Unable to resolve OpenCode model limits safely; refusing to replace native configuration\.$/);
  });
});
