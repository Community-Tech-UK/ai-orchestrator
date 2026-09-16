import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorToolsMcpConfig,
  resolveOrchestratorToolMode,
  resolveOrchestratorToolsBridgeSpec,
} from '../orchestrator-tools-mcp-config';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV } from '../orchestrator-mcp-deferral';
import { ORCHESTRATOR_TOOL_STABLE_ENV } from '../orchestrator-mcp-stable-tools';
import { INTER_SESSION_MESSAGING_ENABLED_ENV } from '../orchestrator-session-messaging-tools';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const SOCKET = '/Users/u/Library/Application Support/harness/ot-abc123.sock';

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

  it('resolves Codex to stable, Cursor to eager, and other clients to deferred', () => {
    expect(resolveOrchestratorToolMode('claude', true)).toBe('deferred');
    expect(resolveOrchestratorToolMode('codex', true)).toBe('stable');
    expect(resolveOrchestratorToolMode('cursor', true)).toBe('eager');
    expect(resolveOrchestratorToolMode('claude', false)).toBe('eager');
  });

  it('sets deferral env for Claude and stable env for Codex when requested', () => {
    const claude = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      provider: 'claude',
      toolDeferral: true,
      exists: () => true,
    });
    expect(claude?.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBe('1');
    expect(claude?.env[ORCHESTRATOR_TOOL_STABLE_ENV]).toBeUndefined();

    const codex = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      provider: 'codex',
      toolDeferral: true,
      exists: () => true,
    });
    expect(codex?.env[ORCHESTRATOR_TOOL_STABLE_ENV]).toBe('1');
    expect(codex?.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBeUndefined();

    const cursor = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      provider: 'cursor',
      toolDeferral: true,
      exists: () => true,
    });
    expect(cursor?.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBeUndefined();
    expect(cursor?.env[ORCHESTRATOR_TOOL_STABLE_ENV]).toBeUndefined();
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

  it('passes the cross-session messaging visibility flag only when enabled', () => {
    const enabled = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      sessionMessagingEnabled: true,
      exists: () => true,
    });
    expect(enabled?.env[INTER_SESSION_MESSAGING_ENABLED_ENV]).toBe('1');

    const disabled = resolveOrchestratorToolsBridgeSpec({
      aioMcpCliPath: AIO_MCP,
      socketPath: SOCKET,
      instanceId: 'inst-1',
      exists: () => true,
    });
    expect(disabled?.env[INTER_SESSION_MESSAGING_ENABLED_ENV]).toBeUndefined();
  });
});
