import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import type { ListRemoteNodesResult, RemoteNodeToolInfo } from './orchestrator-tools';

export interface RemoteNodesCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

export async function runRemoteNodesCli(
  argv: readonly string[],
  deps: RemoteNodesCliDeps = {},
): Promise<void> {
  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  if (help) {
    stdout(formatRemoteNodesHelp());
    return;
  }
  const unknown = argv.find((arg) => arg.startsWith('--') && arg !== '--json');
  if (unknown) {
    throw new Error(`Unknown remote-nodes option: ${unknown}`);
  }

  const client = deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 10_000 });
  const result = await client.call('orchestrator_tools.list_remote_nodes', {});
  const roster = assertListRemoteNodesResult(result);
  stdout(json ? `${JSON.stringify(roster, null, 2)}\n` : formatRemoteNodesTable(roster));
}

export function formatRemoteNodesTable(result: ListRemoteNodesResult): string {
  if (result.nodes.length === 0) {
    return 'No remote nodes registered.\n';
  }
  const rows = result.nodes.map((node) => [
    node.name,
    node.status,
    node.platform || 'unknown',
    node.address || '-',
    `${node.activeInstances}/${node.maxConcurrentInstances}`,
    formatCapabilities(node),
    formatTimestamp(node.lastHeartbeat),
  ]);
  return [
    `Remote nodes: ${result.connectedCount}/${result.totalCount} connected`,
    formatTable(['Name', 'Status', 'Platform', 'Address', 'Capacity', 'Capabilities', 'Last heartbeat'], rows),
    '',
  ].join('\n');
}

function assertListRemoteNodesResult(value: unknown): ListRemoteNodesResult {
  if (!value || typeof value !== 'object') {
    throw new Error('list_remote_nodes returned an invalid result');
  }
  const result = value as Partial<ListRemoteNodesResult>;
  if (!Array.isArray(result.nodes)) {
    throw new Error('list_remote_nodes returned an invalid nodes list');
  }
  return {
    connectedCount: typeof result.connectedCount === 'number' ? result.connectedCount : 0,
    totalCount: typeof result.totalCount === 'number' ? result.totalCount : result.nodes.length,
    nodes: result.nodes as RemoteNodeToolInfo[],
  };
}

function formatRemoteNodesHelp(): string {
  return [
    'Usage: aio-mcp remote-nodes [--json]',
    '',
    'Print the safe remote worker roster from the running Harness app.',
    '',
  ].join('\n');
}

function formatCapabilities(node: RemoteNodeToolInfo): string {
  const parts = [
    ...node.supportedClis,
    ...(node.hasBrowserMcp ? ['browser'] : []),
    ...(node.hasAndroidMcp ? ['android'] : []),
    ...(node.hasDocker ? ['docker'] : []),
    ...(node.gpuName ? [`gpu:${node.gpuName}`] : []),
  ];
  return parts.length > 0 ? parts.join(',') : '-';
}

function formatTimestamp(value: number | undefined): string {
  return value ? new Date(value).toISOString() : '-';
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const lines = [
    formatRow(headers, widths),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) => formatRow(row, widths)),
  ];
  return lines.join('\n');
}

function formatRow(values: string[], widths: number[]): string {
  return values
    .map((value, index) => value.padEnd(widths[index] ?? value.length))
    .join('  ');
}
