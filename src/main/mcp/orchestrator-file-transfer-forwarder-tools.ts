import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

const FILE_TRANSFER_FORWARDER_TOOLS: {
  name: string;
  description: string;
  inputSchema: McpServerToolDefinition['inputSchema'];
}[] = [
  {
    name: 'list_node_files',
    description:
      'Browse allowlisted file-transfer roots on a remote worker node, or list the roots when path is omitted. Common roots include browserDownloads, downloads, documents, desktop, and scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 3 },
        includeHidden: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        cursor: { type: 'string' },
      },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_node_files',
    description:
      'Find likely files under a worker node file-transfer root by name, root label, extension, age, and size. Use browserDownloads for managed Chrome profile downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        query: { type: 'string' },
        roots: { type: 'array', items: { type: 'string' } },
        extensions: { type: 'array', items: { type: 'string' } },
        modifiedWithinDays: { type: 'integer', minimum: 1 },
        minBytes: { type: 'integer', minimum: 0 },
        maxBytes: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        includeHash: { type: 'boolean' },
      },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_node_file_info',
    description:
      'Verify metadata, MIME type, safety classification, and optional SHA-256 for one allowlisted worker-node file.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        hash: { type: 'boolean' },
      },
      required: ['node', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'download_from_node',
    description:
      'Copy one allowlisted file from a worker node into the local workspace over the existing coordinator-worker connection.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        remotePath: { type: 'string' },
        localPath: { type: 'string' },
        expectedSha256: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['node', 'remotePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_to_node',
    description:
      'Copy one local workspace file to a worker node, defaulting to the node scratch transfer root.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        localPath: { type: 'string' },
        remotePath: { type: 'string' },
        expectedSha256: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['node', 'localPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_to_node',
    description:
      'Rsync-style sync of a local workspace folder onto a worker node: only new and changed files are sent (delta transfer for modified files). Use instead of many upload_to_node calls.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        localPath: { type: 'string' },
        remotePath: { type: 'string' },
        exclude: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        deleteExtraneous: { type: 'boolean' },
      },
      required: ['node', 'localPath', 'remotePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_from_node',
    description:
      'Rsync-style sync of a worker-node folder into the local workspace: only new and changed files are fetched (delta transfer for modified files). Use instead of many download_from_node calls.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        localPath: { type: 'string' },
        remotePath: { type: 'string' },
        exclude: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        deleteExtraneous: { type: 'boolean' },
      },
      required: ['node', 'localPath', 'remotePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'collect_browser_download',
    description:
      'Find a recent browser download on a worker node, preferring browserDownloads from the managed Chrome profile before user Downloads, and transfer it when exactly one strong candidate matches.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        profileId: { type: 'string' },
        browserTargetId: { type: 'string' },
        fileNameHint: { type: 'string' },
        extensions: { type: 'array', items: { type: 'string' } },
        modifiedWithinMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
        localPath: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['node'],
      additionalProperties: false,
    },
  },
];

export function createFileTransferForwarderTools(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition[] {
  return FILE_TRANSFER_FORWARDER_TOOLS.map((spec): McpServerToolDefinition => ({
    ...spec,
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`${spec.name} args must be an object`);
      }
      return client.call(`orchestrator_tools.${spec.name}`, args as Record<string, unknown>);
    },
  }));
}
