import { describe, expect, it, vi } from 'vitest';

const dispatcherMocks = vi.hoisted(() => ({
  runOrchestratorToolsForwarder: vi.fn(async () => undefined),
  runCodememForwarder: vi.fn(async () => undefined),
  runBrowserMcpForwarder: vi.fn(async () => undefined),
  runBrowserExtensionNativeHost: vi.fn(async () => undefined),
  runRemoteNodesCli: vi.fn(async () => undefined),
  runReleaseReadinessCli: vi.fn(async () => undefined),
}));

vi.mock('./orchestrator-tools-mcp-forwarder', () => ({
  runOrchestratorToolsForwarder: dispatcherMocks.runOrchestratorToolsForwarder,
}));
vi.mock('../codemem/codemem-mcp-forwarder', () => ({
  runCodememForwarder: dispatcherMocks.runCodememForwarder,
}));
vi.mock('../browser-gateway/browser-mcp-stdio-server', () => ({
  runBrowserMcpForwarder: dispatcherMocks.runBrowserMcpForwarder,
}));
vi.mock('../browser-gateway/browser-extension-native-host', () => ({
  runBrowserExtensionNativeHost: dispatcherMocks.runBrowserExtensionNativeHost,
}));
vi.mock('./remote-nodes-cli', () => ({
  runRemoteNodesCli: dispatcherMocks.runRemoteNodesCli,
}));
vi.mock('./release-readiness-cli', () => ({
  runReleaseReadinessCli: dispatcherMocks.runReleaseReadinessCli,
}));

import { isAioMcpSubcommand, runAioMcpDispatcher } from './aio-mcp-dispatcher';

function argv(...rest: string[]): string[] {
  // Match what Node hands to the SEA: [binary, scriptOrSeaPath, ...args]
  return ['/path/to/aio-mcp', '/path/to/aio-mcp', ...rest];
}

describe('aio-mcp-dispatcher', () => {
  it('isAioMcpSubcommand recognises the known subcommands', () => {
    expect(isAioMcpSubcommand('orchestrator-tools')).toBe(true);
    expect(isAioMcpSubcommand('codemem')).toBe(true);
    expect(isAioMcpSubcommand('browser-gateway')).toBe(true);
    expect(isAioMcpSubcommand('native-host')).toBe(true);
    expect(isAioMcpSubcommand('remote-nodes')).toBe(true);
    expect(isAioMcpSubcommand('release-readiness')).toBe(true);
    expect(isAioMcpSubcommand('something-else')).toBe(false);
    expect(isAioMcpSubcommand(null)).toBe(false);
    expect(isAioMcpSubcommand(undefined)).toBe(false);
  });

  it('routes "orchestrator-tools" to runOrchestratorToolsForwarder', async () => {
    const code = await runAioMcpDispatcher(argv('orchestrator-tools'));
    expect(dispatcherMocks.runOrchestratorToolsForwarder).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });

  it('routes "codemem" to runCodememForwarder', async () => {
    const code = await runAioMcpDispatcher(argv('codemem'));
    expect(dispatcherMocks.runCodememForwarder).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });

  it('routes "browser-gateway" to runBrowserMcpForwarder', async () => {
    const code = await runAioMcpDispatcher(argv('browser-gateway'));
    expect(dispatcherMocks.runBrowserMcpForwarder).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });

  it('routes "native-host" to runBrowserExtensionNativeHost', async () => {
    const code = await runAioMcpDispatcher(argv('native-host'));
    expect(dispatcherMocks.runBrowserExtensionNativeHost).toHaveBeenCalledOnce();
    expect(code).toBe(0);
  });

  it('routes "remote-nodes" to runRemoteNodesCli with remaining args', async () => {
    const code = await runAioMcpDispatcher(argv('remote-nodes', '--json'));
    expect(dispatcherMocks.runRemoteNodesCli).toHaveBeenCalledWith(['--json']);
    expect(code).toBe(0);
  });

  it('routes "release-readiness" to runReleaseReadinessCli with remaining args', async () => {
    const code = await runAioMcpDispatcher(argv('release-readiness', '--evidence', 'release.json'));
    expect(dispatcherMocks.runReleaseReadinessCli).toHaveBeenCalledWith(['--evidence', 'release.json']);
    expect(code).toBe(0);
  });

  it('exits with code 2 and prints help on unknown subcommand', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAioMcpDispatcher(argv('rm-rf'));
    expect(code).toBe(2);
    const message = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(message).toMatch(/unknown subcommand/);
    expect(message).toMatch(/orchestrator-tools/);
    stderr.mockRestore();
  });

  it('exits with code 0 when --help is passed', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAioMcpDispatcher(argv('--help'));
    expect(code).toBe(0);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('exits with code 1 and prints help when no subcommand given', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAioMcpDispatcher(['/path/to/aio-mcp', '/path/to/aio-mcp']);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('returns code 1 and writes a diagnostic when the chosen forwarder throws', async () => {
    dispatcherMocks.runCodememForwarder.mockRejectedValueOnce(new Error('boom'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAioMcpDispatcher(argv('codemem'));
    expect(code).toBe(1);
    const message = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(message).toMatch(/aio-mcp codemem failed: boom/);
    stderr.mockRestore();
  });
});
