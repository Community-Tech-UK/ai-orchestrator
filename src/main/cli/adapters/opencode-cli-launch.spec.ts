import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectOpenCodeLaunch } from './opencode-cli-launch';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), lookup: vi.fn(), safeEnv: vi.fn() }));
vi.mock('./opencode-effective-budget-config', () => ({ runOpenCodeCapture: mocks.capture, openCodeProbeArgs: (major: number) => major >= 2 ? ['api', '--standalone', 'GET', '/api/config'] : ['debug', 'config'] }));
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

  it.each(['2.0.30', '2.0.31', '2.1.0', '2.0.30+build.1'])('prefers supported OpenCode %s over an earlier PATH v1', async (version) => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => ({
      code: 0, stdout: call.args[0] === '--version'
        ? (call.command === params.candidates[0] ? '1.19.1' : version) : '[{"type":"document","info":{}}]',
    }));
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({ command: params.candidates[1], major: 2 });
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({
      command: params.candidates[1], args: ['api', '--standalone', 'GET', '/api/config'],
    }));
    expect(mocks.capture.mock.calls.some(([call]) => call.args[0] === 'debug')).toBe(false);
  });

  it.each(['2.0.29', '2.0.30-beta.1', '3.0.0', '2.0.30garbage', '2.0.30.1'])('does not open the database for unsupported %s', async (version) => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: version });
    await expect(selectOpenCodeLaunch({ ...params, candidates: [params.candidates[1]] })).rejects.toThrow(/OpenCode/);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('falls back to v1 when supported v2 cannot read configuration', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => ({
      code: call.args[0] !== '--version' && call.command === params.candidates[1] ? 1 : 0,
      stdout: call.args[0] === '--version' ? (call.command === params.candidates[0] ? '1.19.1' : '2.0.30') : '{}',
    }));
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({ command: params.candidates[0], major: 1 });
  });

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
    expect(mocks.capture.mock.calls.filter(([call]) => call.args[0] !== '--version').every(([call]) => call.command === userCommand)).toBe(true);
  });

  it('keeps caller HOME and PATH overrides ahead of inherited values', async () => {
    installAt('inherited-home', '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    installAt('inherited-bin');
    const callerCommand = installAt('caller-home', '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    const callerPathCommand = installAt('caller-bin');
    mocks.capture.mockImplementation(async (call: { args: string[] }) => ({ code: 0, stdout: call.args[0] === '--version' ? '1.19.0' : '{}' }));
    await expect(selectOpenCodeLaunch({ workingDirectory: fixtureRoot,
      env: { HOME: join(fixtureRoot, 'caller-home'), PATH: join(fixtureRoot, 'caller-bin') },
    })).resolves.toEqual({ command: callerCommand, major: 1 });
    expect(mocks.lookup.mock.results[0]?.value.stdout.split('\n')).toEqual([callerCommand, callerPathCommand]);
  });

  it('finds an inherited PATH-only installation when no user install exists', async () => {
    const command = installAt('inherited-bin');
    mocks.capture.mockImplementation(async (call: { args: string[] }) => ({ code: 0, stdout: call.args[0] === '--version' ? '1.19.0' : '{}' }));
    await expect(selectOpenCodeLaunch({ workingDirectory: fixtureRoot, env: {} }))
      .resolves.toEqual({ command, major: 1 });
  });

  it('skips an OpenCode 1 install that cannot print config and uses the next one', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => {
      if (call.args[0] === '--version') return { code: 0, stdout: '1.19.0\n' };
      return call.command === '/opt/old/opencode' ? { code: 1, stdout: '' } : { code: 0, stdout: '{}' };
    });
    await expect(selectOpenCodeLaunch({ ...params, candidates: ['/opt/old/opencode', '/opt/next/opencode'] }))
      .resolves.toEqual({ command: '/opt/next/opencode', major: 1 });
  });

  it('keeps the first CLI that prints a config document', async () => {
    mocks.capture.mockImplementation(async (call: { args: string[] }) => (
      call.args[0] === '--version' ? { code: 0, stdout: '1.18.35\n' } : { code: 0, stdout: '{}' }
    ));
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({ command: '/opt/old/opencode', major: 1 });
  });

  it('never opens unsupported OpenCode 2 database when OpenCode 1 fails', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => {
      if (call.args[0] === '--version') return { code: 0, stdout: call.command === '/opt/old/opencode' ? '1.19.0\n' : 'opencode v2.0.18\n' };
      return call.command === '/opt/old/opencode' ? { code: 1, stdout: '' } : { code: 0, stdout: '[]' };
    });
    const result = selectOpenCodeLaunch(params);
    await expect(result).rejects.toThrow(/could not read its settings/);
    await expect(result).rejects.toThrow(/update OpenCode 2 to at least 2.0.30/);
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args])).toEqual([
      ['/opt/old/opencode', ['--version']],
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', ['--version']],
      ['/opt/old/opencode', ['debug', 'config']],
    ]);
  });

  it('skips an OpenCode 2 install listed before a working OpenCode 1 install', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => {
      if (call.args[0] === '--version') return { code: 0, stdout: call.command === '/opt/old/opencode' ? '1.19.0\n' : 'opencode v2.0.18\n' };
      return { code: 0, stdout: '{}' };
    });
    await expect(selectOpenCodeLaunch({ ...params, candidates: ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', '/opt/old/opencode'] }))
      .resolves.toEqual({ command: '/opt/old/opencode', major: 1 });
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args[0]])).toEqual([
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', '--version'],
      ['/opt/old/opencode', '--version'],
      ['/opt/old/opencode', 'debug'],
    ]);
  });

  it('runs both probes in the working directory with the hardened writable roots', async () => {
    mocks.capture.mockImplementation(async (call: { args: string[] }) => ({ code: 0, stdout: call.args[0] === '--version' ? '1.19.0' : '{}' }));
    const writableRoots = ['/tmp/jail-root'];
    await selectOpenCodeLaunch({ ...params, env: { NODE_ENV: 'test' }, writableRoots, candidates: ['/opt/old/opencode'] });
    expect(mocks.capture.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ args: ['--version'], workingDirectory: '/tmp', env: { NODE_ENV: 'test' }, writableRoots }),
      expect.objectContaining({ args: ['debug', 'config'], workingDirectory: '/tmp', env: { NODE_ENV: 'test' }, writableRoots }),
    ]);
  });

  it('refuses a lone OpenCode 2 install with a plain explanation', async () => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: 'opencode v2.0.18\n' });
    const result = selectOpenCodeLaunch({ ...params, candidates: ['/Applications/OpenCode.app/Contents/Resources/opencode-cli'] });
    await expect(result).rejects.toThrow(/update OpenCode 2 to at least 2.0.30/);
  });

  const NONE_FOUND = /Harness could not find a working OpenCode command-line tool/;

  it('reports a missing OpenCode 1 tool without mentioning a newer install that is not there', async () => {
    mocks.capture.mockResolvedValue({ code: 1, stdout: '' });
    await expect(selectOpenCodeLaunch(params)).rejects.toThrow(NONE_FOUND);
  });

  it('reports no OpenCode 1 tool when there are no install candidates', async () => {
    await expect(selectOpenCodeLaunch({ ...params, candidates: [] })).rejects.toThrow(NONE_FOUND);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('reports a broken OpenCode 1 tool alone when no newer install exists', async () => {
    mocks.capture.mockImplementation(async (call: { args: string[] }) => (
      call.args[0] === '--version' ? { code: 0, stdout: '1.19.0\n' } : { code: 1, stdout: '' }
    ));
    await expect(selectOpenCodeLaunch({ ...params, candidates: ['/opt/old/opencode'] }))
      .rejects.toThrow(/could not read its settings/);
  });

  it('treats an install that cannot report its version as unusable', async () => {
    mocks.capture.mockRejectedValue(new Error('Native configuration probe failed'));
    await expect(selectOpenCodeLaunch({ ...params, candidates: ['/opt/old/opencode'] })).rejects.toThrow(NONE_FOUND);
  });

  it.each([[2, '1.19.1'], [1, '2.0.30']] as const)('refuses wrong-major %s placement before reading configuration from %s', async (requiredMajor, version) => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: version });
    await expect(selectOpenCodeLaunch({ ...params, requiredMajor, candidates: [params.candidates[0]] })).rejects.toThrow(`requires OpenCode ${requiredMajor}`);
    expect(mocks.capture.mock.calls.map(([call]) => call.args)).toEqual([['--version']]);
  });

  it('selects explicit major 1 without reading a supported major 2 configuration', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => ({ code: 0,
      stdout: call.args[0] === '--version' ? (call.command === params.candidates[0] ? '1.19.1' : '2.0.30') : '{}',
    }));
    await expect(selectOpenCodeLaunch({ ...params, requiredMajor: 1 })).resolves.toEqual({ command: params.candidates[0], major: 1 });
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args])).toEqual([
      [params.candidates[0], ['--version']], [params.candidates[1], ['--version']], [params.candidates[0], ['debug', 'config']],
    ]);
  });

  it('does not fall back to a readable major 1 when required major 2 configuration is unreadable', async () => {
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => ({
      code: call.args[0] === '--version' || call.command === params.candidates[0] ? 0 : 1,
      stdout: call.args[0] === '--version' ? (call.command === params.candidates[0] ? '1.19.1' : '2.0.30') : '{}',
    }));
    await expect(selectOpenCodeLaunch({ ...params, requiredMajor: 2 })).rejects.toThrow('requires OpenCode 2');
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args])).toEqual([
      [params.candidates[0], ['--version']], [params.candidates[1], ['--version']],
      [params.candidates[1], ['api', '--standalone', 'GET', '/api/config']],
    ]);
  });
});
