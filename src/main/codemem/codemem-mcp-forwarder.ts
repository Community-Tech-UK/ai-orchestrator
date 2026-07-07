/**
 * Codemem MCP Forwarder (stdio side, runs inside the `aio-mcp` SEA).
 *
 * Replaces the old `mcp-stdio-server.ts` that opened `codemem.sqlite`
 * directly. Registers the same 8 MCP tools but the handlers forward the
 * args to `CodememRpcServer` in the parent process via
 * `CodememRpcClient`. The forwarder has no `better-sqlite3` import path,
 * so it loads cleanly in a vanilla Node SEA — no native-module ABI
 * dependency, which is what unblocks re-disabling the `RunAsNode`
 * Electron fuse.
 */

import type { McpServerToolDefinition } from '../mcp/mcp-server-tools';
import { ensureObject, runStdioMcpForwarder, schema } from '../mcp/mcp-stdio-forwarder';
import { CodememRpcClient, type CodememRpcClientLike } from './codemem-rpc-client';

/**
 * Build the MCP tool definitions that proxy back to the parent process.
 * Exported (and built as a pure factory) so tests can exercise the
 * forward-and-proxy contract with a stub RPC client.
 */
export function createCodememForwarderTools(
  client: CodememRpcClientLike,
): McpServerToolDefinition[] {
  return [
    {
      name: 'find_symbol',
      description: 'Search the persistent codemem index for symbols by name and optional kind.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          limit: { type: 'number' },
        },
        ['name'],
      ),
      handler: async (args) =>
        client.call('codemem.find_symbol', ensureObject(args, 'find_symbol')),
    },
    {
      name: 'find_references',
      description: 'Resolve references for a codemem symbol identifier using the LSP worker.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
          limit: { type: 'number' },
        },
        ['symbolId'],
      ),
      handler: async (args) =>
        client.call('codemem.find_references', ensureObject(args, 'find_references')),
    },
    {
      name: 'document_symbols',
      description: 'Return document symbols for a single file through the codemem LSP worker.',
      inputSchema: schema(
        {
          path: { type: 'string' },
        },
        ['path'],
      ),
      handler: async (args) =>
        client.call('codemem.document_symbols', ensureObject(args, 'document_symbols')),
    },
    {
      name: 'workspace_symbols',
      description: 'Search workspace-wide symbols through the codemem index.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        ['query'],
      ),
      handler: async (args) =>
        client.call('codemem.workspace_symbols', ensureObject(args, 'workspace_symbols')),
    },
    {
      name: 'call_hierarchy',
      description: 'Traverse incoming or outgoing call hierarchy for a codemem symbol.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
          direction: { type: 'string', enum: ['incoming', 'outgoing'] },
          maxDepth: { type: 'number' },
        },
        ['symbolId', 'direction'],
      ),
      handler: async (args) =>
        client.call('codemem.call_hierarchy', ensureObject(args, 'call_hierarchy')),
    },
    {
      name: 'find_implementations',
      description: 'Find implementations for a codemem symbol through the LSP worker.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
        },
        ['symbolId'],
      ),
      handler: async (args) =>
        client.call('codemem.find_implementations', ensureObject(args, 'find_implementations')),
    },
    {
      name: 'hover',
      description: 'Return hover information for a codemem symbol.',
      inputSchema: schema(
        {
          workspacePath: { type: 'string' },
          symbolId: { type: 'string' },
        },
        ['symbolId'],
      ),
      handler: async (args) => client.call('codemem.hover', ensureObject(args, 'hover')),
    },
    {
      name: 'diagnostics',
      description: 'Return paginated diagnostics for a file through the codemem LSP worker.',
      inputSchema: schema(
        {
          path: { type: 'string' },
          page: { type: 'number' },
          pageSize: { type: 'number' },
        },
        ['path'],
      ),
      handler: async (args) => client.call('codemem.diagnostics', ensureObject(args, 'diagnostics')),
    },
  ];
}

export async function runCodememForwarder(
  client: CodememRpcClientLike = new CodememRpcClient(),
): Promise<void> {
  await runStdioMcpForwarder({
    loggerName: 'CodememMcpForwarder',
    tools: createCodememForwarderTools(client),
  });
}
