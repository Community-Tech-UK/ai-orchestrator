import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface OrchestratorToolsMcpConfigOptions {
  currentDir: string;
  operatorDbPath: string;
  conversationLedgerDbPath: string;
  execPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  instanceId?: string;
  exists?: (candidatePath: string) => boolean;
}

interface OrchestratorToolsBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveOrchestratorToolsBridgeSpec(
  options: OrchestratorToolsMcpConfigOptions,
): OrchestratorToolsBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  const scriptPath = options.isPackaged
    ? path.join(options.resourcesPath, 'app.asar', 'dist', 'main', 'mcp', 'orchestrator-tools-mcp-server.js')
    : path.resolve(options.currentDir, '../mcp/orchestrator-tools-mcp-server.js');

  if (!exists(scriptPath)) {
    return null;
  }

  return {
    command: options.execPath,
    args: [scriptPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AI_ORCHESTRATOR_OPERATOR_DB_PATH: options.operatorDbPath,
      AI_ORCHESTRATOR_CONVERSATION_LEDGER_DB_PATH: options.conversationLedgerDbPath,
      ...(options.instanceId ? { AI_ORCHESTRATOR_INSTANCE_ID: options.instanceId } : {}),
    },
  };
}

export function buildOrchestratorToolsMcpConfig(
  options: OrchestratorToolsMcpConfigOptions,
): string | null {
  const bridge = resolveOrchestratorToolsBridgeSpec(options);
  if (!bridge) {
    return null;
  }

  return JSON.stringify({
    mcpServers: {
      orchestrator: bridge,
    },
  });
}
