import { automationInvocations } from './automation-invocation-context';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { getOrchestratorToolsRpcInstanceCapability, getOrchestratorToolsRpcSocketPath } from '../mcp/orchestrator-tools-rpc-server';
import { resolveAioMcpCliPath } from '../util/aio-mcp-cli-path';
import { getSettingsManager } from '../core/config/settings-manager';

export function configureAutomationInvocationMcp(): void {
  automationInvocations.configure((instanceId, provider) => {
    const aioMcpCliPath = resolveAioMcpCliPath();
    const socketPath = getOrchestratorToolsRpcSocketPath();
    const capabilityToken = getOrchestratorToolsRpcInstanceCapability(instanceId);
    if (!aioMcpCliPath || !socketPath || !capabilityToken) throw new Error('Scheduled invocation result tools are unavailable');
    const config = buildOrchestratorToolsMcpConfig({ aioMcpCliPath, socketPath, instanceId, capabilityToken,
      provider, toolDeferral: getSettingsManager().getAll().orchestratorMcpToolDeferral, automationInvocation: true });
    if (!config) throw new Error('Scheduled invocation result tools are unavailable');
    return config;
  });
}
