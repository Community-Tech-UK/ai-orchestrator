import { describe, expect, it } from 'vitest';
import { buildCodememMcpConfig, resolveCodememBridgeSpec } from '../mcp-config';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const SOCKET = '/Users/u/Library/Application Support/harness/cm-abc123.sock';

describe('codemem MCP config helpers', () => {
  it('returns a bridge spec pointing at `aio-mcp codemem` when the SEA exists', () => {
    const bridge = resolveCodememBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-cm',
      exists: (candidate) => candidate === AIO_MCP,
    });

    expect(bridge).toEqual({
      command: AIO_MCP,
      args: ['codemem'],
      env: {
        AI_ORCHESTRATOR_CODEMEM_SOCKET: SOCKET,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-cm',
      },
    });
  });

  it('returns null when the SEA binary is missing', () => {
    expect(
      resolveCodememBridgeSpec({
        aioMcpCliPath: AIO_MCP,
        socketPath: SOCKET,
        instanceId: 'inst-cm',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('does not pass ELECTRON_RUN_AS_NODE — SEA is real Node', () => {
    const bridge = resolveCodememBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-cm',
      exists: () => true,
    });
    expect(bridge?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('produces inline mcpServers JSON the CLIs can read directly', () => {
    const config = buildCodememMcpConfig({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-cm',
      exists: () => true,
    });

    expect(config).not.toBeNull();
    expect(JSON.parse(config as string)).toEqual({
      mcpServers: {
        codemem: {
          command: AIO_MCP,
          args: ['codemem'],
          env: {
            AI_ORCHESTRATOR_CODEMEM_SOCKET: SOCKET,
            AI_ORCHESTRATOR_INSTANCE_ID: 'inst-cm',
          },
        },
      },
    });
  });
});
