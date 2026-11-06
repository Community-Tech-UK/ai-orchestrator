/**
 * Deferred tool listing for the orchestrator-tools MCP forwarder.
 *
 * Registers every orchestrator tool for dispatch but only *lists* a small
 * always-loaded core plus search/describe. Search returns matching schemas and
 * reveals them via `McpServer.revealTools()`. Electron-free: bundled into aio-mcp.
 */

import type { McpServerToolDefinition } from './mcp-server-tools';
import { rankToolDocuments } from './tool-search-ranker';

export const ORCHESTRATOR_TOOL_DEFERRAL_ENV = 'AI_ORCHESTRATOR_ORCHESTRATOR_TOOL_DEFERRAL';
export const ORCHESTRATOR_TOOL_SEARCH_NAME = 'orchestrator.tool_search';
export const ORCHESTRATOR_TOOL_DESCRIBE_NAME = 'orchestrator.tool_describe';

/**
 * The core tools that drive remote worker nodes. They leave the always-visible
 * core while no worker is connected (see {@link RemoteWorkerListing}); search,
 * describe and execute still reach them.
 */
export const REMOTE_WORKER_CORE_TOOL_NAMES: readonly string[] = [
  'list_remote_nodes',
  'run_on_node',
  'read_node_output',
  'terminate_node_instance',
];

export const ORCHESTRATOR_CORE_TOOL_NAMES: readonly string[] = [
  'automation_result',
  ...REMOTE_WORKER_CORE_TOOL_NAMES,
  'list_settings',
  'get_setting',
];

/**
 * What the forwarder learned about connected workers before listing tools.
 * Only `false` hides anything: `true`, or `undefined` (roster not read, so
 * unknown), keeps every core tool listed. Hiding changes what is listed, never
 * what a session may call.
 */
export interface RemoteWorkerListing {
  remoteWorkersConnected?: boolean;
}

/** Names of the core tools to list directly. */
export function orchestratorCoreToolNames(listing: RemoteWorkerListing = {}): ReadonlySet<string> {
  return new Set(listing.remoteWorkersConnected === false
    ? ORCHESTRATOR_CORE_TOOL_NAMES.filter((name) => !REMOTE_WORKER_CORE_TOOL_NAMES.includes(name))
    : ORCHESTRATOR_CORE_TOOL_NAMES);
}

/** Tells the model where the unlisted remote-worker tools went; empty when they are listed. */
export function remoteWorkerSearchHint(listing: RemoteWorkerListing = {}): string {
  return listing.remoteWorkersConnected === false
    ? ` No worker node is connected now, so ${REMOTE_WORKER_CORE_TOOL_NAMES.join(', ')} are not listed; search "remote worker" to find them.`
    : '';
}

const SEARCH_RESULT_LIMIT_DEFAULT = 5;
const SEARCH_RESULT_LIMIT_MAX = 10;

export function measureOrchestratorToolSchemaBytes(
  tools: readonly Pick<McpServerToolDefinition, 'name' | 'description' | 'inputSchema' | 'annotations'>[],
): number {
  return tools.reduce(
    (total, tool) =>
      total
      + Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }),
        'utf-8',
      ),
    0,
  );
}

function toSearchDoc(tool: McpServerToolDefinition): { id: string; text: string } {
  return {
    id: tool.name,
    text: `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`,
  };
}

function describeMatch(tool: McpServerToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export interface DeferredOrchestratorToolsOptions extends RemoteWorkerListing {
  onReveal: (names: string[]) => void;
}

export function createDeferredOrchestratorTools(
  allTools: readonly McpServerToolDefinition[],
  options: DeferredOrchestratorToolsOptions,
): McpServerToolDefinition[] {
  const coreNames = orchestratorCoreToolNames(options);
  const byName = new Map<string, McpServerToolDefinition>();
  const tools = allTools.map((tool) => {
    const wrapped = coreNames.has(tool.name) ? tool : { ...tool, hidden: true };
    byName.set(wrapped.name, wrapped);
    return wrapped;
  });
  const deferredCount = tools.filter((tool) => tool.hidden).length;
  const searchDocs = tools.map(toSearchDoc);

  const searchTool: McpServerToolDefinition = {
    name: ORCHESTRATOR_TOOL_SEARCH_NAME,
    description:
      `Search the ${deferredCount} deferred Harness tools (file transfer, settings writes, `
      + 'automations, calendar, app-store release, evidence, node config, git_batch_pull, '
      + 'exec_on_node, doc review, host process CPU/memory listing and leftover-process cleanup). Returns names and short descriptions; use tool_describe for schemas. Matched tools become callable '
      + `immediately and are added to the visible tool list.${remoteWorkerSearchHint(options)}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to do, e.g. "upload a file" or "create a calendar event".',
        },
        limit: {
          type: 'number',
          description: `Max matches to return (default ${SEARCH_RESULT_LIMIT_DEFAULT}, max ${SEARCH_RESULT_LIMIT_MAX}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const rawLimit = typeof args['limit'] === 'number' ? args['limit'] : SEARCH_RESULT_LIMIT_DEFAULT;
      const limit = Math.min(SEARCH_RESULT_LIMIT_MAX, Math.max(1, Math.floor(rawLimit)));
      const matches = rankToolDocuments(query, searchDocs, limit)
        .map((result) => byName.get(result.id))
        .filter((tool): tool is McpServerToolDefinition => tool !== undefined);
      if (matches.length > 0) {
        options.onReveal(matches.map((tool) => tool.name));
      }
      return {
        matches: matches.map(tool => ({ name: tool.name, description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 500) })),
        note: matches.length > 0
          ? 'These tools are registered and callable now.'
          : 'No tools matched. Available tool names are listed in availableTools.',
        ...(matches.length === 0 ? { availableTools: tools.map((tool) => tool.name) } : {}),
      };
    },
  };

  const describeTool: McpServerToolDefinition = {
    name: ORCHESTRATOR_TOOL_DESCRIBE_NAME,
    description:
      'Load the full JSON schema of one Harness orchestrator tool by exact name '
      + '(e.g. "upload_to_node"). The tool becomes callable immediately and is '
      + 'added to the visible tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact tool name, e.g. "create_automation".',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      const tool = byName.get(name);
      if (!tool) {
        return {
          error: `Unknown orchestrator tool: ${name || '(missing name)'}`,
          availableTools: tools.map((candidate) => candidate.name),
        };
      }
      options.onReveal([tool.name]);
      return describeMatch(tool);
    },
  };

  return [searchTool, describeTool, ...tools];
}
