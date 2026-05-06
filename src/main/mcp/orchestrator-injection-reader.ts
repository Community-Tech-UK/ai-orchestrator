import type { McpInjectionBundle } from '../../shared/types/mcp-orchestrator.types';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { OrchestratorMcpRepository } from './orchestrator-mcp-repository';

export class OrchestratorInjectionReader {
  constructor(private readonly repo: OrchestratorMcpRepository) {}

  buildBundle(provider: SupportedProvider): McpInjectionBundle {
    const inlineConfigs = this.repo
      .list()
      .filter((entry) => entry.injectInto.includes(provider))
      .map((entry) => JSON.stringify({
        mcpServers: {
          [entry.record.name]: {
            transport: entry.record.transport === 'stdio' ? undefined : entry.record.transport,
            command: entry.record.command,
            args: entry.record.args,
            url: entry.record.url,
            headers: entry.record.headers,
            env: entry.record.env,
          },
        },
      }));
    return {
      configPaths: [],
      inlineConfigs,
    };
  }
}
