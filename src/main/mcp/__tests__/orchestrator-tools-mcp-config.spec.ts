import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorToolsMcpConfig,
  resolveOrchestratorToolsBridgeSpec,
} from '../orchestrator-tools-mcp-config';

const AIO_MCP = '/Applications/AI Orchestrator.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const SOCKET = '/Users/u/Library/Application Support/ai-orchestrator/ot-abc123.sock';

describe('orchestrator tools MCP config helpers', () => {
  it('returns a bridge spec pointing at `aio-mcp orchestrator-tools` when the SEA exists', () => {
    const bridge = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      exists: (candidate) => candidate === AIO_MCP,
    });

    expect(bridge).toEqual({
      command: AIO_MCP,
      args: ['orchestrator-tools'],
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: SOCKET,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-1',
      },
    });
  });

  it('returns null when the aio-mcp SEA binary is missing', () => {
    expect(
      resolveOrchestratorToolsBridgeSpec({
        aioMcpCliPath: AIO_MCP,
        socketPath: SOCKET,
        instanceId: 'inst-1',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('omits ELECTRON_RUN_AS_NODE — the SEA is real Node so the env is irrelevant', () => {
    const bridge = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      exists: () => true,
    });

    expect(bridge?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('produces inline mcpServers JSON the CLIs can read directly', () => {
    const config = buildOrchestratorToolsMcpConfig({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      exists: () => true,
    });

    expect(config).not.toBeNull();
    expect(JSON.parse(config as string)).toEqual({
      mcpServers: {
        orchestrator: {
          command: AIO_MCP,
          args: ['orchestrator-tools'],
          env: {
            AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: SOCKET,
            AI_ORCHESTRATOR_INSTANCE_ID: 'inst-1',
          },
        },
      },
    });
  });

  it('returns null when the SEA binary is missing — caller logs and degrades gracefully', () => {
    expect(
      buildOrchestratorToolsMcpConfig({
        aioMcpCliPath: AIO_MCP,
        socketPath: SOCKET,
        instanceId: 'inst-1',
        exists: () => false,
      }),
    ).toBeNull();
  });
});
