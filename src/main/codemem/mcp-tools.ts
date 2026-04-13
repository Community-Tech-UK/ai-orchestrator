import type { McpServerToolDefinition } from '../mcp/mcp-server-tools';
import type { AgentLspFacade } from './agent-lsp-facade';
import {
  CodememCallHierarchyArgsSchema,
  CodememDiagnosticsArgsSchema,
  CodememDocumentSymbolsArgsSchema,
  CodememFindReferencesArgsSchema,
  CodememFindSymbolArgsSchema,
  CodememSymbolLookupArgsSchema,
  CodememWorkspaceSymbolsArgsSchema,
} from '../../shared/validation/codemem-schemas';

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
  };
}

export function createCodememMcpTools(resolveFacade: () => AgentLspFacade): McpServerToolDefinition[] {
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
      handler: async (args) => {
        const validated = CodememFindSymbolArgsSchema.parse(args);
        return resolveFacade().findSymbol(validated.name, validated);
      },
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
      handler: async (args) => {
        const validated = CodememFindReferencesArgsSchema.parse(args);
        return resolveFacade().findReferences(validated.symbolId, validated);
      },
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
      handler: async (args) => {
        const validated = CodememDocumentSymbolsArgsSchema.parse(args);
        return resolveFacade().documentSymbols(validated.path);
      },
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
      handler: async (args) => {
        const validated = CodememWorkspaceSymbolsArgsSchema.parse(args);
        return resolveFacade().workspaceSymbols(validated.query, validated);
      },
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
      handler: async (args) => {
        const validated = CodememCallHierarchyArgsSchema.parse(args);
        return resolveFacade().callHierarchy(validated.symbolId, validated);
      },
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
      handler: async (args) => {
        const validated = CodememSymbolLookupArgsSchema.parse(args);
        return resolveFacade().findImplementations(validated.symbolId, validated);
      },
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
      handler: async (args) => {
        const validated = CodememSymbolLookupArgsSchema.parse(args);
        return resolveFacade().hover(validated.symbolId, validated);
      },
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
      handler: async (args) => {
        const validated = CodememDiagnosticsArgsSchema.parse(args);
        return resolveFacade().diagnostics(validated.path, validated);
      },
    },
  ];
}
