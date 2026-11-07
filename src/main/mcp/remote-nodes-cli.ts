import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import type { ListRemoteNodesResult, RemoteNodeToolInfo } from './orchestrator-tools';
import {
  MAX_AGENT_PAIRING_TTL_MINUTES,
  type IssueRemoteNodePairingArgs,
  type IssueRemoteNodePairingResult,
} from './orchestrator-node-connection-tools';

export interface RemoteNodesCliDeps {
  client?: OrchestratorToolsRpcClientLike;
  stdout?: (text: string) => void;
}

export async function runRemoteNodesCli(
  argv: readonly string[],
  deps: RemoteNodesCliDeps = {},
): Promise<void> {
  if (argv[0] === 'pair') {
    await runPairCli(argv.slice(1), deps);
    return;
  }
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

async function runPairCli(argv: readonly string[], deps: RemoteNodesCliDeps): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout(formatPairHelp());
    return;
  }
  const options = parsePairArgs(argv);
  // Reading Tailscale status can take a few seconds when its CLI is slow.
  const client = deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 30_000 });
  const result = assertIssuePairingResult(
    await client.call('orchestrator_tools.issue_remote_node_pairing', options.args),
  );
  stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatPairingResult(result));
}

export function parsePairArgs(argv: readonly string[]): { args: IssueRemoteNodePairingArgs; json: boolean } {
  const args: IssueRemoteNodePairingArgs = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--label') {
      args.label = requireValue(argv, ++i, arg);
    } else if (arg === '--ttl-minutes') {
      const raw = requireValue(argv, ++i, arg);
      const minutes = Number(raw);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_AGENT_PAIRING_TTL_MINUTES) {
        throw new Error(`--ttl-minutes must be a whole number from 1 to ${MAX_AGENT_PAIRING_TTL_MINUTES}`);
      }
      args.ttlMinutes = minutes;
    } else {
      throw new Error(`Unknown remote-nodes pair argument: ${arg}`);
    }
  }
  return { args, json };
}

export function formatPairingResult(result: IssueRemoteNodePairingResult): string {
  const name = result.label ? ` for ${result.label}` : '';
  return [
    `Pairing command${name} (single use, expires ${new Date(result.expiresAt).toISOString()}):`,
    '',
    result.command,
    '',
    'Connection config:',
    JSON.stringify(result.connectionConfig, null, 2),
    '',
    'Run the command on the new computer only. It contains a one-time credential, so keep it out of chat, logs and other files.',
    '',
  ].join('\n');
}

function assertIssuePairingResult(value: unknown): IssueRemoteNodePairingResult {
  const result = (value ?? {}) as Partial<IssueRemoteNodePairingResult>;
  if (typeof result.command !== 'string' || typeof result.expiresAt !== 'number'
    || !result.connectionConfig || typeof result.connectionConfig !== 'object') {
    throw new Error('issue_remote_node_pairing returned an invalid result');
  }
  return result as IssueRemoteNodePairingResult;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
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
    '       aio-mcp remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]',
    '',
    'Print the safe remote worker roster from the running Harness app,',
    'or issue a one-time command that pairs a new worker computer (see remote-nodes pair --help).',
    '',
  ].join('\n');
}

function formatPairHelp(): string {
  return [
    'Usage: aio-mcp remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]',
    '',
    'Issue a single-use pairing credential through the running Harness app and print the',
    'ready-to-run worker command (aio-worker pair "<link>"), the connection config and the expiry.',
    '',
    'Options:',
    '  --label <name>       Name for the new computer, shown on the Other computers page.',
    `  --ttl-minutes <n>    Minutes the credential stays usable, 1 to ${MAX_AGENT_PAIRING_TTL_MINUTES}. Default ${MAX_AGENT_PAIRING_TTL_MINUTES}.`,
    '  --json               Print { command, link, connectionConfig, label, createdAt, expiresAt }.',
    '',
    'Run the printed command on the new computer, for example over SSH. It contains the credential:',
    'never paste it into chat, logs or files other than that computer\'s worker config.',
    'The pairing appears on the Other computers page with this session as the requester; revoke it there.',
    '',
  ].join('\n');
}

function formatCapabilities(node: RemoteNodeToolInfo): string {
  const parts = [
    ...node.supportedClis,
    ...(node.hasBrowserMcp ? ['browser'] : []),
    ...(node.hasAndroidMcp ? ['android'] : []),
    ...(node.iosAutomation?.ready ? ['ios'] : []),
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
