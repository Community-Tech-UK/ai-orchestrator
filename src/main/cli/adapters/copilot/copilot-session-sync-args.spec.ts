import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareCopilotSpawn,
  probeCopilotSessionSyncOffArgs,
  selectCopilotSessionSyncOffArgs,
} from './copilot-session-sync-args';
import { resolveWindowsSpawn } from '../windows-cli-spawn';

// Pass-through by default; one test stands in for the Windows shim resolution.
vi.mock('../windows-cli-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../windows-cli-spawn')>();
  return { ...actual, resolveWindowsSpawn: vi.fn(actual.resolveWindowsSpawn) };
});

// Option lines as printed by the real CLIs' `--help` (1.0.99-0 and 1.0.103).
const HELP_1_0_99 = [
  '      --remote',
  '          Enable remote access to this session',
  '      --remote-export',
  '      --no-remote',
  '      --no-remote-export',
].join('\n');
const HELP_1_0_103 = [
  '      --connect [<sessionId>]',
  '          Connect directly to a remote session (optionally specify',
  '      --sync-session[=<on|off>]',
  '          Enable or disable read-only account history sync for this',
].join('\n');

describe('selectCopilotSessionSyncOffArgs', () => {
  it.each([
    ['1.0.103 help', HELP_1_0_103, ['--sync-session=off']],
    ['1.0.99 help', HELP_1_0_99, ['--no-remote']],
    ['help naming only --no-remote-export', '      --no-remote-export', []],
    ['help naming neither flag', '      --connect [<sessionId>]', []],
  ])('selects from %s', (_label, help, expected) => {
    expect(selectCopilotSessionSyncOffArgs(help)).toEqual(expected);
  });
});

describe.skipIf(process.platform === 'win32')('Copilot help probe', () => {
  let dir = '';

  /** A stand-in `copilot` that records its argv and prints `help`. */
  function fakeCopilot(help: string, exitCode = 0): string {
    const command = join(dir, 'copilot');
    writeFileSync(join(dir, 'help.txt'), help);
    writeFileSync(command, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${join(dir, 'argv.txt')}'`,
      `cat '${join(dir, 'help.txt')}'`,
      `exit ${exitCode}`,
    ].join('\n'));
    chmodSync(command, 0o755);
    return command;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-sync-probe-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the installed CLI for help without letting it self-update', async () => {
    const command = fakeCopilot(HELP_1_0_103);

    await expect(probeCopilotSessionSyncOffArgs({ command, argsPrefix: ['copilot', '--'], displayCommand: 'copilot' }))
      .resolves.toEqual(['--sync-session=off']);
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8').trim().split('\n'))
      .toEqual(['copilot', '--', '--help', '--no-auto-update']);
  });

  it('keeps the legacy flag for a CLI that still advertises it', async () => {
    const command = fakeCopilot(HELP_1_0_99);

    await expect(probeCopilotSessionSyncOffArgs({ command, argsPrefix: [], displayCommand: 'copilot' }))
      .resolves.toEqual(['--no-remote']);
  });

  it('runs the launcher the Windows shim resolves to, shell-free', async () => {
    const command = fakeCopilot(HELP_1_0_103);
    vi.mocked(resolveWindowsSpawn).mockImplementationOnce((_command, args) => ({
      command, args: ['C:\\Program Files\\npm\\copilot\\index.js', ...args], shell: false, detached: false,
    }));

    await expect(probeCopilotSessionSyncOffArgs({ command: 'copilot', argsPrefix: [], displayCommand: 'copilot' }))
      .resolves.toEqual(['--sync-session=off']);
    expect(resolveWindowsSpawn).toHaveBeenCalledWith(
      'copilot', ['--help', '--no-auto-update'], expect.any(Boolean), expect.any(Object),
    );
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8').trim().split('\n'))
      .toEqual(['C:\\Program Files\\npm\\copilot\\index.js', '--help', '--no-auto-update']);
  });

  it('starts without a flag when the probe throws before spawning', async () => {
    await expect(probeCopilotSessionSyncOffArgs({ command: 'copilot\0', argsPrefix: [], displayCommand: 'copilot' }))
      .resolves.toEqual([]);
  });

  it('starts without a flag when the probe cannot run', async () => {
    await expect(probeCopilotSessionSyncOffArgs({
      command: join(dir, 'missing-copilot'),
      argsPrefix: [],
      displayCommand: 'copilot',
    })).resolves.toEqual([]);
  });

  it('replaces an earlier flag in place so a respawn picks up an updated CLI', async () => {
    const command = fakeCopilot(HELP_1_0_99);
    const launch = { command, argsPrefix: [], displayCommand: 'copilot' };
    const args = ['--acp', '--stdio'];
    const prepare = prepareCopilotSpawn(args, launch, true);

    await prepare();
    expect(args).toEqual(['--acp', '--stdio', '--no-remote']);

    // The CLI updates itself in place between spawns.
    writeFileSync(join(dir, 'help.txt'), HELP_1_0_103);
    await prepare();
    expect(args).toEqual(['--acp', '--stdio', '--sync-session=off']);
    await prepare();
    expect(args).toEqual(['--acp', '--stdio', '--sync-session=off']);
  });

  it('skips the probe when session sync is left to the CLI, and runs the MCP preparation', async () => {
    const command = fakeCopilot(HELP_1_0_103);
    const args = ['--acp', '--no-remote'];
    const cleanup = vi.fn();
    const prepareMcpConfig = vi.fn(() => cleanup);

    const result = await prepareCopilotSpawn(args, { command, argsPrefix: [], displayCommand: 'copilot' }, false, prepareMcpConfig)();

    expect(args).toEqual(['--acp']);
    expect(prepareMcpConfig).toHaveBeenCalledTimes(1);
    expect(result).toBe(cleanup);
    expect(() => readFileSync(join(dir, 'argv.txt'))).toThrow();
  });
});
