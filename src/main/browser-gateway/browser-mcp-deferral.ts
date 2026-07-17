/**
 * WS9 tool-schema economy: deferred tool loading for the browser-gateway
 * MCP forwarder.
 *
 * With deferral enabled the forwarder registers every browser tool for
 * dispatch but only *lists* a small always-loaded core set plus two discovery
 * tools (`browser.tool_search` / `browser.tool_describe`). A search returns
 * the matching tools' full JSON schemas, reveals them via
 * `McpServer.revealTools()`, and the transport pushes
 * `notifications/tools/list_changed` so the client re-fetches `tools/list`.
 *
 * No permission-model change: every call still routes through the existing
 * RPC client → parent `BrowserGatewayRpcServer`, whose instance auth,
 * payload validation, rate limits, and grant checks are untouched.
 *
 * This module is bundled into the aio-mcp SEA binary — keep it free of
 * Electron and main-process singleton imports.
 */

import type { McpServerToolDefinition } from '../mcp/mcp-server-tools';
import { rankToolDocuments } from '../mcp/tool-search-ranker';
import type { BrowserGatewayRpcClientLike } from './browser-gateway-rpc-client';
import { createBrowserMcpTools } from './browser-mcp-tools';

/** Env flag (set by the parent's MCP config writer) that enables deferral. */
export const BROWSER_TOOL_DEFERRAL_ENV = 'AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL';

export const BROWSER_TOOL_SEARCH_NAME = 'browser.tool_search';
export const BROWSER_TOOL_DESCRIBE_NAME = 'browser.tool_describe';

/**
 * Always-loaded core set (WS9): the highest-frequency read/navigate/act tools
 * a session almost always needs. Everything else loads via search/describe.
 */
export const BROWSER_CORE_TOOL_NAMES: readonly string[] = [
  'browser.list_targets',
  'browser.find_or_open',
  'browser.navigate',
  'browser.snapshot',
  'browser.screenshot',
  'browser.click',
];

const SEARCH_RESULT_LIMIT_DEFAULT = 5;
const SEARCH_RESULT_LIMIT_MAX = 10;

/**
 * Injected-schema telemetry (WS9/WS8 shared measurement): serialized bytes of
 * what a client actually receives from `tools/list` for these definitions.
 */
export function measureToolSchemaBytes(
  tools: readonly Pick<McpServerToolDefinition, 'name' | 'description' | 'inputSchema'>[],
): number {
  return tools.reduce(
    (total, tool) =>
      total
      + Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        'utf-8',
      ),
    0,
  );
}

function toSearchDoc(tool: McpServerToolDefinition): { id: string; text: string } {
  // Schema JSON carries the real signal (property names + descriptions);
  // tool descriptions are boilerplate.
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

export interface DeferredBrowserToolsOptions {
  /**
   * Called with the names of tools a search/describe surfaced, so the
   * transport can unhide them and notify the client. Matched tools are
   * callable immediately either way — reveal only affects `tools/list`.
   */
  onReveal: (names: string[]) => void;
}

/**
 * Build the deferred registration set: all browser tools (non-core hidden)
 * plus the two discovery tools. Tool names and schemas of the underlying
 * tools are byte-identical to the eager `createBrowserMcpTools()` output, so
 * transcripts stay comparable across deferral modes.
 */
export function createDeferredBrowserMcpTools(
  client: BrowserGatewayRpcClientLike,
  options: DeferredBrowserToolsOptions,
): McpServerToolDefinition[] {
  const allTools = createBrowserMcpTools(client);
  const coreNames = new Set(BROWSER_CORE_TOOL_NAMES);
  const byName = new Map<string, McpServerToolDefinition>();

  const tools: McpServerToolDefinition[] = allTools.map((tool) => {
    const wrapped = coreNames.has(tool.name) ? tool : { ...tool, hidden: true };
    byName.set(wrapped.name, wrapped);
    return wrapped;
  });

  const deferredCount = tools.filter((tool) => tool.hidden).length;
  const searchDocs = tools.map(toSearchDoc);

  const searchTool: McpServerToolDefinition = {
    name: BROWSER_TOOL_SEARCH_NAME,
    description:
      `Search the ${deferredCount} deferred Browser Gateway tools (forms, typing/select, `
      + 'credential/secret fill, uploads/downloads, grants/approvals, campaigns, '
      + 'accessibility snapshots, element queries, waits, session checks, checkpoints, '
      + 'audit log, escalations) and load their schemas. Matched tools become callable '
      + 'immediately and are added to the visible tool list. Use this before assuming a '
      + 'browser capability is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to do, e.g. "type into a form" or "download a file".',
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
      const ranked = rankToolDocuments(query, searchDocs, limit);
      const matches = ranked
        .map((result) => byName.get(result.id))
        .filter((tool): tool is McpServerToolDefinition => tool !== undefined);
      if (matches.length > 0) {
        options.onReveal(matches.map((tool) => tool.name));
      }
      return {
        matches: matches.map(describeMatch),
        note: matches.length > 0
          ? 'These tools are registered and callable now.'
          : 'No tools matched. Available tool names are listed in availableTools.',
        ...(matches.length === 0
          ? { availableTools: tools.map((tool) => tool.name) }
          : {}),
      };
    },
  };

  const describeTool: McpServerToolDefinition = {
    name: BROWSER_TOOL_DESCRIBE_NAME,
    description:
      'Load the full JSON schema of one Browser Gateway tool by exact name '
      + '(e.g. "browser.fill_form"). The tool becomes callable immediately and is '
      + 'added to the visible tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact tool name, e.g. "browser.wait_for".',
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
          error: `Unknown browser tool: ${name || '(missing name)'}`,
          availableTools: tools.map((candidate) => candidate.name),
        };
      }
      options.onReveal([tool.name]);
      return describeMatch(tool);
    },
  };

  return [searchTool, describeTool, ...tools];
}
