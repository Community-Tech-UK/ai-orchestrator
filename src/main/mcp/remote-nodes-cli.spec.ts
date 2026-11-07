import { describe, expect, it, vi } from 'vitest';
import { formatRemoteNodesTable, parsePairArgs, runRemoteNodesCli } from './remote-nodes-cli';
import type { ListRemoteNodesResult } from './orchestrator-tools';
import type { IssueRemoteNodePairingResult } from './orchestrator-node-connection-tools';
import { OrchestratorToolsRpcClient, OrchestratorToolsUnavailableError } from './orchestrator-tools-rpc-client';

const sampleResult: ListRemoteNodesResult = {
  connectedCount: 1,
  totalCount: 2,
  nodes: [
    {
      id: 'node-1',
      name: 'noah3900x',
      status: 'connected',
      connected: true,
      platform: 'win32',
      arch: 'x64',
      address: '100.64.1.2',
      supportedClis: ['claude', 'codex'],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: true,
      activeInstances: 1,
      maxConcurrentInstances: 4,
      workingDirectories: ['C:\\work'],
      lastHeartbeat: Date.UTC(2026, 6, 4, 12, 0, 0),
    },
    {
      id: 'node-2',
      name: 'noahlaptop',
      status: 'disconnected',
      connected: false,
      platform: 'darwin',
      arch: 'arm64',
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      activeInstances: 0,
      maxConcurrentInstances: 10,
      workingDirectories: [],
    },
  ],
};

describe('remote-nodes-cli', () => {
  it('prints an operator-readable roster table without token fields', async () => {
    const stdout = vi.fn();
    const client = {
      call: vi.fn(async () => sampleResult),
    };

    await runRemoteNodesCli([], { client, stdout });

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(client.call).toHaveBeenCalledWith('orchestrator_tools.list_remote_nodes', {});
    expect(output).toContain('noah3900x');
    expect(output).toContain('100.64.1.2');
    expect(output).toContain('1/4');
    expect(output).not.toMatch(/token/i);
  });

  it('prints the full safe roster result as JSON when requested', async () => {
    const stdout = vi.fn();

    await runRemoteNodesCli(['--json'], {
      client: { call: vi.fn(async () => sampleResult) },
      stdout,
    });

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output) as ListRemoteNodesResult;
    expect(parsed).toMatchObject({
      connectedCount: 1,
      totalCount: 2,
    });
    expect(parsed.nodes[0]).toMatchObject({ name: 'noah3900x' });
    expect(output).not.toMatch(/token/i);
  });

  describe('pair', () => {
    const pairing: IssueRemoteNodePairingResult = {
      command: 'aio-worker pair "ai-orchestrator://remote-node/pair?host=mac&port=4878&namespace=default&token=EXAMPLE_PAIRING&requireTls=false"',
      link: 'ai-orchestrator://remote-node/pair?host=mac&port=4878&namespace=default&token=EXAMPLE_PAIRING&requireTls=false',
      connectionConfig: { name: 'ct-test-mac', authToken: 'EXAMPLE_PAIRING', coordinatorUrl: 'ws://mac:4878' },
      label: 'ct-test-mac',
      createdAt: Date.UTC(2026, 10, 7, 12, 0, 0),
      expiresAt: Date.UTC(2026, 10, 7, 13, 0, 0),
    };

    it('parses label, lifetime and --json', () => {
      expect(parsePairArgs(['--label', 'ct-test-mac', '--ttl-minutes', '15', '--json'])).toEqual({
        args: { label: 'ct-test-mac', ttlMinutes: 15 },
        json: true,
      });
      expect(parsePairArgs([])).toEqual({ args: {}, json: false });
    });

    it.each([
      [['--ttl-minutes', '61'], '--ttl-minutes must be a whole number from 1 to 60'],
      [['--ttl-minutes', '0'], '--ttl-minutes must be a whole number from 1 to 60'],
      [['--ttl-minutes', '1.5'], '--ttl-minutes must be a whole number from 1 to 60'],
      [['--label'], '--label needs a value'],
      [['--label', '--json'], '--label needs a value'],
      [['--nonsense'], 'Unknown remote-nodes pair argument: --nonsense'],
      [['extra'], 'Unknown remote-nodes pair argument: extra'],
    ])('rejects %j', (argv, message) => {
      expect(() => parsePairArgs(argv)).toThrow(message);
    });

    it('issues through the parent app and prints the command, config and expiry', async () => {
      const stdout = vi.fn();
      const client = { call: vi.fn(async () => pairing) };

      await runRemoteNodesCli(['pair', '--label', 'ct-test-mac'], { client, stdout });

      expect(client.call).toHaveBeenCalledWith('orchestrator_tools.issue_remote_node_pairing', { label: 'ct-test-mac' });
      const output = stdout.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('Pairing command for ct-test-mac (single use, expires 2026-11-07T13:00:00.000Z):');
      expect(output).toContain(`\n${pairing.command}\n`);
      expect(output).toContain('"coordinatorUrl": "ws://mac:4878"');
      expect(output).toContain('keep it out of chat, logs and other files');
    });

    it('prints the result as JSON when requested', async () => {
      const stdout = vi.fn();
      await runRemoteNodesCli(['pair', '--json'], { client: { call: vi.fn(async () => pairing) }, stdout });
      expect(JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(''))).toEqual(pairing);
    });

    it('prints help without calling the app', async () => {
      const stdout = vi.fn();
      const client = { call: vi.fn() };
      await runRemoteNodesCli(['pair', '--help'], { client, stdout });
      expect(client.call).not.toHaveBeenCalled();
      expect(stdout.mock.calls.join('')).toContain('Usage: aio-mcp remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]');
    });

    it('issues nothing outside a Harness session', async () => {
      await expect(runRemoteNodesCli(['pair'], {
        client: new OrchestratorToolsRpcClient({ env: {} }),
        stdout: vi.fn(),
      })).rejects.toBeInstanceOf(OrchestratorToolsUnavailableError);
    });

    it('rejects a malformed result', async () => {
      await expect(runRemoteNodesCli(['pair'], { client: { call: vi.fn(async () => ({})) }, stdout: vi.fn() }))
        .rejects.toThrow('issue_remote_node_pairing returned an invalid result');
    });
  });

  it('tags a node ios only when its iOS block is ready', () => {
    const ios = (ready: boolean) => ({
      ...sampleResult.nodes[0]!, iosAutomation: {
  xcodePath: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '27.2', xcodeBuild: '27B52', licenceAccepted: true,
  runtimes: [{ name: 'iOS 27.2', version: '27.2', isAvailable: true }], devices: [],
  signing: { appleAccountPresent: true }, problems: [], checkedAt: 1_700_000_000_000, ready: ready,
},
    });
    expect(formatRemoteNodesTable({ ...sampleResult, nodes: [ios(true)] })).toContain('browser,ios,docker');
    expect(formatRemoteNodesTable({ ...sampleResult, nodes: [ios(false)] })).not.toContain(',ios');
  });

  it('formats an empty roster clearly', () => {
    expect(formatRemoteNodesTable({ connectedCount: 0, totalCount: 0, nodes: [] }))
      .toContain('No remote nodes registered');
  });
});
