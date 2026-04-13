import { describe, expect, it } from 'vitest';
import { buildCodememMcpConfig, resolveCodememBridgeSpec } from '../mcp-config';

describe('codemem MCP config helpers', () => {
  it('resolves the dev bridge against the compiled dist entrypoint', () => {
    const bridge = resolveCodememBridgeSpec({
      currentDir: '/repo/dist/main/instance',
      dbPath: '/tmp/codemem.sqlite',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: (candidatePath) => candidatePath === '/repo/dist/main/codemem/mcp-stdio-server.js',
    });

    expect(bridge).toEqual({
      command: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      args: ['/repo/dist/main/codemem/mcp-stdio-server.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AI_ORCHESTRATOR_CODEMEM_DB_PATH: '/tmp/codemem.sqlite',
      },
    });
  });

  it('resolves the packaged bridge against app.asar', () => {
    const bridge = resolveCodememBridgeSpec({
      currentDir: '/ignored',
      dbPath: '/tmp/codemem.sqlite',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: true,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: (candidatePath) => candidatePath === '/Applications/AI Orchestrator.app/Contents/Resources/app.asar/dist/main/codemem/mcp-stdio-server.js',
    });

    expect(bridge?.args).toEqual([
      '/Applications/AI Orchestrator.app/Contents/Resources/app.asar/dist/main/codemem/mcp-stdio-server.js',
    ]);
  });

  it('returns inline JSON with a codemem server definition', () => {
    const config = buildCodememMcpConfig({
      currentDir: '/repo/dist/main/instance',
      dbPath: '/tmp/codemem.sqlite',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: () => true,
    });

    expect(config).not.toBeNull();
    expect(JSON.parse(config as string)).toEqual({
      mcpServers: {
        codemem: {
          command: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
          args: ['/repo/dist/main/codemem/mcp-stdio-server.js'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            AI_ORCHESTRATOR_CODEMEM_DB_PATH: '/tmp/codemem.sqlite',
          },
        },
      },
    });
  });

  it('returns null when the bridge entrypoint cannot be resolved', () => {
    const config = buildCodememMcpConfig({
      currentDir: '/repo/dist/main/instance',
      dbPath: '/tmp/codemem.sqlite',
      execPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
      isPackaged: false,
      resourcesPath: '/Applications/AI Orchestrator.app/Contents/Resources',
      exists: () => false,
    });

    expect(config).toBeNull();
  });
});
