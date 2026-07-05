import { describe, expect, it, vi } from 'vitest';
import { formatRemoteNodesTable, runRemoteNodesCli } from './remote-nodes-cli';
import type { ListRemoteNodesResult } from './orchestrator-tools';

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

  it('formats an empty roster clearly', () => {
    expect(formatRemoteNodesTable({ connectedCount: 0, totalCount: 0, nodes: [] }))
      .toContain('No remote nodes registered');
  });
});
