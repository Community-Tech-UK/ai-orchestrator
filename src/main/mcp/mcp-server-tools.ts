import { getLogger } from '../logging/logger';

const logger = getLogger('McpServerTools');

export interface McpServerToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createOrchestratorTools(deps: {
  listInstances: () => Promise<unknown[]>;
  spawnInstance: (config: Record<string, unknown>) => Promise<unknown>;
  verify: (request: Record<string, unknown>) => Promise<unknown>;
  debate: (topic: string, options?: Record<string, unknown>) => Promise<unknown>;
  consensus: (question: string, options?: Record<string, unknown>) => Promise<unknown>;
}): McpServerToolDefinition[] {
  logger.debug('Creating orchestrator MCP tools');
  return [
    {
      name: 'orchestrator.list_instances',
      description: 'List all running AI instances',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => deps.listInstances(),
    },
    {
      name: 'orchestrator.spawn_instance',
      description: 'Spawn a new AI instance with the specified provider and configuration',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'AI provider (claude, gemini, codex, copilot)' },
          workingDirectory: { type: 'string', description: 'Working directory for the instance' },
          model: { type: 'string', description: 'Model to use (optional)' },
          prompt: { type: 'string', description: 'Initial prompt (optional)' },
        },
        required: ['provider', 'workingDirectory'],
      },
      handler: async (args) => deps.spawnInstance(args),
    },
    {
      name: 'orchestrator.verify',
      description: 'Run multi-agent verification on a code change or question',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The question or code to verify' },
          instanceId: { type: 'string', description: 'Instance to verify against (optional)' },
          agentCount: { type: 'number', description: 'Number of verification agents (default: 3)' },
        },
        required: ['query'],
      },
      handler: async (args) => deps.verify(args),
    },
    {
      name: 'orchestrator.debate',
      description: 'Start a multi-agent debate on a topic',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic to debate' },
          rounds: { type: 'number', description: 'Number of debate rounds (default: 4)' },
          agents: { type: 'number', description: 'Number of agents (default: 3)' },
        },
        required: ['topic'],
      },
      handler: async (args) => deps.debate(args['topic'] as string, args),
    },
    {
      name: 'orchestrator.consensus',
      description: 'Run consensus voting on a question',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to reach consensus on' },
          voters: { type: 'number', description: 'Number of voting agents (default: 5)' },
        },
        required: ['question'],
      },
      handler: async (args) => deps.consensus(args['question'] as string, args),
    },
  ];
}
