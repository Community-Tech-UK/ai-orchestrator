/** Stable orchestrator MCP surface for clients that snapshot tools/list. Electron-free. */

import type { McpServerToolDefinition } from './mcp-server-tools';
import { rankToolDocuments } from './tool-search-ranker';
import {
  ORCHESTRATOR_CORE_TOOL_NAMES,
  ORCHESTRATOR_TOOL_DESCRIBE_NAME,
  ORCHESTRATOR_TOOL_SEARCH_NAME,
} from './orchestrator-mcp-deferral';

export const ORCHESTRATOR_TOOL_STABLE_ENV = 'AI_ORCHESTRATOR_ORCHESTRATOR_TOOL_STABLE';
export const ORCHESTRATOR_TOOL_EXECUTE_NAME = 'orchestrator.tool_execute';

function objectArgs(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createStableOrchestratorTools(
  all: readonly McpServerToolDefinition[],
): McpServerToolDefinition[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  const core = new Set(ORCHESTRATOR_CORE_TOOL_NAMES);
  const documents = all.map((tool) => ({
    id: tool.name,
    text: `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`,
  }));
  const describe = (tool: McpServerToolDefinition) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    invocation: core.has(tool.name)
      ? { tool: tool.name }
      : { tool: ORCHESTRATOR_TOOL_EXECUTE_NAME, name: tool.name },
  });

  const search: McpServerToolDefinition = {
    name: ORCHESTRATOR_TOOL_SEARCH_NAME,
    description:
      'Search Harness orchestrator capabilities including file transfer, automations, '
      + 'calendar, release, evidence and settings writes. Returns matching schemas and '
      + 'invocation instructions. Non-core tools run via orchestrator.tool_execute; '
      + 'the callable tool list stays fixed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!objectArgs(args) || typeof args['query'] !== 'string'
        || Object.keys(args).some((key) => key !== 'query' && key !== 'limit')) {
        throw new Error('Invalid orchestrator tool search arguments');
      }
      const limit = args['limit'] ?? 5;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new Error('Invalid orchestrator tool search limit');
      }
      const matches = rankToolDocuments(args['query'], documents, limit)
        .map((match) => describe(byName.get(match.id)!));
      return {
        matches,
        ...(matches.length === 0 ? { availableTools: [...byName.keys()] } : {}),
      };
    },
  };

  const describeTool: McpServerToolDefinition = {
    name: ORCHESTRATOR_TOOL_DESCRIBE_NAME,
    description:
      'Describe one Harness orchestrator tool by exact name, with its argument schema '
      + 'and stable invocation instructions. No tool-list refresh is needed.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!objectArgs(args) || typeof args['name'] !== 'string'
        || Object.keys(args).some((key) => key !== 'name')) {
        throw new Error('Invalid orchestrator tool describe arguments');
      }
      const tool = byName.get(args['name']);
      if (!tool) {
        throw new Error('Unknown orchestrator tool');
      }
      return describe(tool);
    },
  };

  const execute: McpServerToolDefinition = {
    name: ORCHESTRATOR_TOOL_EXECUTE_NAME,
    description:
      'Execute a non-core Harness orchestrator tool found by tool_search/tool_describe. '
      + 'Pass its exact name and an arguments object matching its described schema. '
      + 'Core tools use their direct callable tool. Original instance and argument checks still apply.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!objectArgs(args) || typeof args['name'] !== 'string' || !objectArgs(args['arguments'])
        || Object.keys(args).some((key) => key !== 'name' && key !== 'arguments')) {
        throw new Error('Invalid orchestrator tool execute arguments');
      }
      const tool = byName.get(args['name']);
      if (!tool) {
        throw new Error('Unknown orchestrator tool');
      }
      if (core.has(tool.name)) {
        throw new Error('Use the directly registered core orchestrator tool');
      }
      return tool.handler(args['arguments']);
    },
  };

  return [search, describeTool, execute, ...all.filter((tool) => core.has(tool.name))];
}
