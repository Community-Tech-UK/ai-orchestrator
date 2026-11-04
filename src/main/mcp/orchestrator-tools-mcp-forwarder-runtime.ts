/**
 * Stdio entry for the orchestrator-tools MCP forwarder. Kept out of the
 * tool-table module so that file stays under the 700-line hard cap.
 */

import { runStdioMcpForwarder } from './mcp-stdio-forwarder';
import { createDeferredOrchestratorTools, ORCHESTRATOR_TOOL_DEFERRAL_ENV } from './orchestrator-mcp-deferral';
import { createStableOrchestratorTools, ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import {
  createOrchestratorToolsForwarderTools,
  resolveOrchestratorToolsForwarderOptions,
} from './orchestrator-tools-mcp-forwarder';

export async function runOrchestratorToolsForwarder(
  client: OrchestratorToolsRpcClientLike = new OrchestratorToolsRpcClient(),
): Promise<void> {
  await runStdioMcpForwarder({
    loggerName: 'OrchestratorToolsMcpForwarder',
    tools: (server) => resolveOrchestratorForwarderTools(client, (names) => {
      server.revealTools(names);
    }),
  });
}

export function resolveOrchestratorForwarderTools(
  client: OrchestratorToolsRpcClientLike,
  onReveal: (names: string[]) => void,
) {
  const tools = createOrchestratorToolsForwarderTools(
    client,
    resolveOrchestratorToolsForwarderOptions(),
  );
  if (process.env['AI_ORCHESTRATOR_AUTOMATION_INVOCATION'] === '1') return tools.filter(tool => tool.name === 'automation_result');
  if (process.env[ORCHESTRATOR_TOOL_STABLE_ENV] === '1') {
    return createStableOrchestratorTools(tools);
  }
  if (process.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV] === '1') {
    return createDeferredOrchestratorTools(tools, { onReveal });
  }
  return tools;
}
