import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { WindowsCliLauncher } from './windows-cli-spawn';

let launcher: WindowsCliLauncher | null = {
  command: 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  prefixArgs: [],
};
const resolveMock = vi.fn(() => launcher);
vi.mock('./windows-cli-spawn', () => ({
  resolveWindowsCliLauncher: (...args: unknown[]) => resolveMock(...args),
  // Real behavior so target-shape assertions remain meaningful.
  buildWindowsShellFreeTarget: (l: WindowsCliLauncher, args: string[]) => ({
    command: l.command,
    args: [...l.prefixArgs, ...args],
    shell: false,
    detached: false,
  }),
  logWindowsLauncherResolution: () => {},
}));

// ClaudeCliAdapter is a concrete subclass that inherits the base
// resolveSpawnTarget unchanged — used here as a vehicle to exercise it.
import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { SpawnTarget } from './base-cli-adapter';

interface SpawnOpts {
  shell?: boolean | string;
  env?: NodeJS.ProcessEnv;
}
function resolveTarget(
  adapter: ClaudeCliAdapter,
  command: string,
  args: string[],
  opts: SpawnOpts,
): SpawnTarget {
  return (
    adapter as unknown as {
      resolveSpawnTarget: (c: string, a: string[], o: SpawnOpts) => SpawnTarget;
    }
  ).resolveSpawnTarget(command, args, opts);
}

describe('BaseCliAdapter.resolveSpawnTarget (Windows launcher routing)', () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });

  afterEach(() => {
    setPlatform(originalPlatform);
    launcher = {
      command: 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      prefixArgs: [],
    };
    resolveMock.mockClear();
  });

  it('on win32 with shell:true, spawns a native-exe launcher directly with shell:false', () => {
    setPlatform('win32');
    const adapter = new ClaudeCliAdapter();
    const target = resolveTarget(adapter, 'claude', ['--mcp-config', 'cfg'], { shell: true });
    expect(target).toEqual({
      command: launcher!.command,
      args: ['--mcp-config', 'cfg'],
      shell: false,
      detached: false,
    });
  });

  it('on win32, prepends prefixArgs for a node-script launcher (codex/copilot)', () => {
    setPlatform('win32');
    launcher = { command: 'C:\\nvm4w\\nodejs\\node.exe', prefixArgs: ['C:\\path\\codex.js'] };
    const adapter = new ClaudeCliAdapter();
    const target = resolveTarget(adapter, 'codex', ['--foo', 'bar'], { shell: true });
    expect(target).toEqual({
      command: 'C:\\nvm4w\\nodejs\\node.exe',
      args: ['C:\\path\\codex.js', '--foo', 'bar'],
      shell: false,
      detached: false,
    });
  });

  it('on win32, falls back to the shell shim when the launcher cannot be resolved', () => {
    setPlatform('win32');
    launcher = null;
    const adapter = new ClaudeCliAdapter();
    const target = resolveTarget(adapter, 'claude', ['--mcp-config', 'cfg'], { shell: true });
    expect(target).toEqual({ command: 'claude', args: ['--mcp-config', 'cfg'], shell: true });
  });

  it('caches the resolution — resolver is invoked at most once per adapter', () => {
    setPlatform('win32');
    const adapter = new ClaudeCliAdapter();
    resolveTarget(adapter, 'claude', ['--version'], { shell: true });
    resolveTarget(adapter, 'claude', ['--help'], { shell: true });
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it('off win32, returns the base target unchanged and never resolves a launcher', () => {
    setPlatform('darwin');
    const adapter = new ClaudeCliAdapter();
    const target = resolveTarget(adapter, 'claude', ['--version'], { shell: false });
    expect(target).toEqual({ command: 'claude', args: ['--version'], shell: false });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('on win32 with shell already false, leaves the target untouched', () => {
    setPlatform('win32');
    const adapter = new ClaudeCliAdapter();
    const target = resolveTarget(adapter, 'claude', ['--version'], { shell: false });
    expect(target).toEqual({ command: 'claude', args: ['--version'], shell: false });
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
