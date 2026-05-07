import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorToolsMcpConfig,
  resolveOrchestratorToolsBridgeSpec,
} from '../orchestrator-tools-mcp-config';

describe('orchestrator tools MCP config helpers', () => {
  it('resolves the dev bridge against the compiled dist entrypoint', () => {
    const bridge = resolveOrchestratorToolsBridgeSpec({
      currentDir: '/repo/dist/main/instance',
      operatorDbPath: '/tmp/operator.db',
      conversationLedgerDbPath: '/tmp/conversation-ledger.db',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      instanceId: 'inst-1',
      exists: (candidatePath) => candidatePath === '/repo/dist/main/mcp/orchestrator-tools-mcp-server.js',
    });

    expect(bridge).toEqual({
      command: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      args: ['/repo/dist/main/mcp/orchestrator-tools-mcp-server.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AI_ORCHESTRATOR_OPERATOR_DB_PATH: '/tmp/operator.db',
        AI_ORCHESTRATOR_CONVERSATION_LEDGER_DB_PATH: '/tmp/conversation-ledger.db',
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-1',
      },
    });
  });

  it('resolves the packaged bridge against app.asar', () => {
    const bridge = resolveOrchestratorToolsBridgeSpec({
      currentDir: '/ignored',
      operatorDbPath: '/tmp/operator.db',
      conversationLedgerDbPath: '/tmp/conversation-ledger.db',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: true,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: (candidatePath) => candidatePath === '/Applications/AI Orchestrator.app/Contents/Resources/app.asar/dist/main/mcp/orchestrator-tools-mcp-server.js',
    });

    expect(bridge?.args).toEqual([
      '/Applications/AI Orchestrator.app/Contents/Resources/app.asar/dist/main/mcp/orchestrator-tools-mcp-server.js',
    ]);
  });

  it('returns inline JSON with the git batch MCP server definition', () => {
    const config = buildOrchestratorToolsMcpConfig({
      currentDir: '/repo/dist/main/instance',
      operatorDbPath: '/tmp/operator.db',
      conversationLedgerDbPath: '/tmp/conversation-ledger.db',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      instanceId: 'inst-1',
      exists: () => true,
    });

    expect(config).not.toBeNull();
    expect(JSON.parse(config as string)).toEqual({
      mcpServers: {
        orchestrator: {
          command: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
          args: ['/repo/dist/main/mcp/orchestrator-tools-mcp-server.js'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            AI_ORCHESTRATOR_OPERATOR_DB_PATH: '/tmp/operator.db',
            AI_ORCHESTRATOR_CONVERSATION_LEDGER_DB_PATH: '/tmp/conversation-ledger.db',
            AI_ORCHESTRATOR_INSTANCE_ID: 'inst-1',
          },
        },
      },
    });
  });

  it('returns null when the bridge entrypoint cannot be resolved', () => {
    const config = buildOrchestratorToolsMcpConfig({
      currentDir: '/repo/dist/main/instance',
      operatorDbPath: '/tmp/operator.db',
      conversationLedgerDbPath: '/tmp/conversation-ledger.db',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: () => false,
    });

    expect(config).toBeNull();
  });
});
