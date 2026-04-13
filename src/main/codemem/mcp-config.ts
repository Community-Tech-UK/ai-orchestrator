import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface CodememMcpConfigOptions {
  currentDir: string;
  dbPath: string;
  execPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  exists?: (candidatePath: string) => boolean;
}

interface CodememBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveCodememBridgeSpec(options: CodememMcpConfigOptions): CodememBridgeSpec | null {
  const exists = options.exists ?? existsSync;
  const scriptPath = options.isPackaged
    ? path.join(options.resourcesPath, 'app.asar', 'dist', 'main', 'codemem', 'mcp-stdio-server.js')
    : path.resolve(options.currentDir, '../codemem/mcp-stdio-server.js');

  if (!exists(scriptPath)) {
    return null;
  }

  return {
    command: options.execPath,
    args: [scriptPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AI_ORCHESTRATOR_CODEMEM_DB_PATH: options.dbPath,
    },
  };
}

export function buildCodememMcpConfig(options: CodememMcpConfigOptions): string | null {
  const bridge = resolveCodememBridgeSpec(options);
  if (!bridge) {
    return null;
  }

  return JSON.stringify({
    mcpServers: {
      codemem: bridge,
    },
  });
}
