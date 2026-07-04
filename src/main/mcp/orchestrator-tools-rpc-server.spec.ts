import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: vi.fn(() => {
    throw new Error('better-sqlite3 should not be touched when toolFactory is injected');
  }),
}));

vi.mock('../operator/operator-schema', () => ({
  createOperatorTables: vi.fn(),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/never-opened.db',
}));

import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
  getOrchestratorToolsRpcServer,
} from './orchestrator-tools-rpc-server';
import type { McpServerToolDefinition } from './mcp-server-tools';

const KNOWN_INSTANCE = 'instance-known';

function makeServer(overrides: Partial<ConstructorParameters<typeof OrchestratorToolsRpcServer>[0]> = {}): {
  server: OrchestratorToolsRpcServer;
  toolHandler: ReturnType<typeof vi.fn>;
} {
  const toolHandler = vi.fn(async (args: unknown) => ({ echoed: args }));
  const tools: McpServerToolDefinition[] = [
    {
      name: 'git_batch_pull',
      description: 'test tool',
      inputSchema: { type: 'object' },
      handler: toolHandler,
    },
  ];
  const server = new OrchestratorToolsRpcServer({
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ot-rpc-test-')),
    isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
    toolFactory: () => tools,
    registerCleanup: () => undefined,
    ...overrides,
  });
  return { server, toolHandler };
}

describe('OrchestratorToolsRpcServer.handleRequest', () => {
  afterEach(() => {
    _resetOrchestratorToolsRpcServerForTesting();
  });

  it('dispatches git_batch_pull to the matching tool handler with validated payload', async () => {
    const { server, toolHandler } = makeServer();

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'orchestrator_tools.git_batch_pull',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { root: '/repo', concurrency: 4 },
      },
    });

    expect(toolHandler).toHaveBeenCalledOnce();
    expect(toolHandler.mock.calls[0]?.[0]).toEqual({ root: '/repo', concurrency: 4 });
    expect(result).toEqual({ echoed: { root: '/repo', concurrency: 4 } });
  });

  it('rejects requests from unknown instances', async () => {
    const { server } = makeServer();

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'orchestrator_tools.git_batch_pull',
        params: {
          instanceId: 'instance-evil',
          payload: { root: '/repo' },
        },
      }),
    ).rejects.toThrow(/unknown orchestrator-tools instance/);
  });

  it('rejects unknown method names', async () => {
    const { server } = makeServer();

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'orchestrator_tools.evil_method',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { root: '/repo' },
        },
      }),
    ).rejects.toThrow(/Unknown orchestrator-tools RPC method/);
  });

  it('rejects payloads that fail the git_batch_pull schema', async () => {
    const { server, toolHandler } = makeServer();

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'orchestrator_tools.git_batch_pull',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { root: '' }, // min(1) violation
        },
      }),
    ).rejects.toThrow();
    expect(toolHandler).not.toHaveBeenCalled();
  });

  it('requires instanceId and payload in params', async () => {
    const { server } = makeServer();

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'orchestrator_tools.git_batch_pull',
        // @ts-expect-error intentionally malformed
        params: null,
      }),
    ).rejects.toThrow(/params are required/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'orchestrator_tools.git_batch_pull',
        params: { payload: { root: '/repo' } },
      }),
    ).rejects.toThrow(/instanceId is required/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'orchestrator_tools.git_batch_pull',
        params: { instanceId: KNOWN_INSTANCE },
      }),
    ).rejects.toThrow(/payload is required/);
  });

  it('dispatches delete_automation to the matching tool with validated payload', async () => {
    const deleteHandler = vi.fn(async (args: unknown) => ({ deleted: true, echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'delete_automation',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: deleteHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 30,
      method: 'orchestrator_tools.delete_automation',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { id: 'auto-1' },
      },
    });

    expect(deleteHandler).toHaveBeenCalledOnce();
    expect(deleteHandler.mock.calls[0]?.[0]).toEqual({ id: 'auto-1' });
    expect(result).toMatchObject({ deleted: true });
  });

  it('dispatches update_automation to the matching tool with validated payload', async () => {
    const updateHandler = vi.fn(async (args: unknown) => ({ echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'update_automation',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: updateHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 31,
      method: 'orchestrator_tools.update_automation',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { id: 'auto-1', enabled: false },
      },
    });

    expect(updateHandler).toHaveBeenCalledOnce();
    expect(updateHandler.mock.calls[0]?.[0]).toEqual({ id: 'auto-1', enabled: false });
    expect(result).toEqual({ echoed: { id: 'auto-1', enabled: false } });
  });

  it('dispatches postpone_automation to the matching tool with validated payload', async () => {
    const postponeHandler = vi.fn(async (args: unknown) => ({ echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'postpone_automation',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: postponeHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 32,
      method: 'orchestrator_tools.postpone_automation',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { id: 'auto-1', delayMinutes: 60 },
      },
    });

    expect(postponeHandler).toHaveBeenCalledOnce();
    expect(postponeHandler.mock.calls[0]?.[0]).toEqual({ id: 'auto-1', delayMinutes: 60 });
    expect(result).toEqual({ echoed: { id: 'auto-1', delayMinutes: 60 } });
  });

  it('rejects postpone_automation payloads that fail the schema (no delay/until)', async () => {
    const postponeHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'postpone_automation',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: postponeHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 33,
        method: 'orchestrator_tools.postpone_automation',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { id: 'auto-1' },
        },
      }),
    ).rejects.toThrow();
    expect(postponeHandler).not.toHaveBeenCalled();
  });

  it('dispatches run_on_node to the matching tool with validated payload', async () => {
    const runHandler = vi.fn(async (args: unknown) => ({ instanceId: 'inst-1', echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'run_on_node',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: runHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'orchestrator_tools.run_on_node',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: {
          node: 'windows-pc',
          prompt: 'run the tests',
          requiresAndroid: true,
          androidDeviceKind: 'emulator',
        },
      },
    });

    expect(runHandler).toHaveBeenCalledOnce();
    expect(runHandler.mock.calls[0]?.[0]).toEqual({
      node: 'windows-pc',
      prompt: 'run the tests',
      requiresAndroid: true,
      androidDeviceKind: 'emulator',
    });
    expect(result).toMatchObject({ instanceId: 'inst-1' });
  });

  it('rejects run_on_node payloads that fail the schema (missing prompt)', async () => {
    const runHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'run_on_node',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: runHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'orchestrator_tools.run_on_node',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { node: 'windows-pc' },
        },
      }),
    ).rejects.toThrow();
    expect(runHandler).not.toHaveBeenCalled();
  });

  it('dispatches read_node_output to the matching tool with validated payload', async () => {
    const readHandler = vi.fn(async (args: unknown) => ({ status: 'idle', done: true, echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'read_node_output',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: readHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'orchestrator_tools.read_node_output',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { instanceId: 'inst-1', limit: 20 },
      },
    });

    expect(readHandler).toHaveBeenCalledOnce();
    expect(readHandler.mock.calls[0]?.[0]).toEqual({ instanceId: 'inst-1', limit: 20 });
    expect(result).toMatchObject({ done: true });
  });

  it('dispatches list_remote_nodes to the matching tool with validated payload', async () => {
    const listHandler = vi.fn(async (args: unknown) => ({
      connectedCount: 1,
      totalCount: 1,
      nodes: [],
      echoed: args,
    }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'list_remote_nodes',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: listHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'orchestrator_tools.list_remote_nodes',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: {},
      },
    });

    expect(listHandler).toHaveBeenCalledOnce();
    expect(listHandler.mock.calls[0]?.[0]).toEqual({});
    expect(result).toMatchObject({ connectedCount: 1, totalCount: 1, nodes: [] });
  });

  it('rejects list_remote_nodes payloads with unexpected properties', async () => {
    const listHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'list_remote_nodes',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: listHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 15,
        method: 'orchestrator_tools.list_remote_nodes',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { includeSecrets: true },
        },
      }),
    ).rejects.toThrow();
    expect(listHandler).not.toHaveBeenCalled();
  });

  it('dispatches settings.set to the matching tool with validated payload', async () => {
    const setHandler = vi.fn(async (args: unknown) => ({ ok: true, echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'set_setting',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: setHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 40,
      method: 'orchestrator_tools.settings.set',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'theme', value: 'light' },
      },
    });

    expect(setHandler).toHaveBeenCalledOnce();
    expect(setHandler.mock.calls[0]?.[0]).toEqual({ key: 'theme', value: 'light' });
    expect(result).toEqual({ ok: true, echoed: { key: 'theme', value: 'light' } });
  });

  it('rejects settings.set payloads with an empty key', async () => {
    const setHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'set_setting',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: setHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 41,
        method: 'orchestrator_tools.settings.set',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { key: '', value: 'light' },
        },
      }),
    ).rejects.toThrow();
    expect(setHandler).not.toHaveBeenCalled();
  });

  it('rejects settings.set payloads with an omitted value before invoking the tool', async () => {
    const setHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'set_setting',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: setHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 43,
        method: 'orchestrator_tools.settings.set',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { key: 'theme' },
        },
      }),
    ).rejects.toThrow();
    expect(setHandler).not.toHaveBeenCalled();
  });

  it('dispatches node_config.update to the matching tool with validated payload', async () => {
    const updateHandler = vi.fn(async (args: unknown) => ({ ok: true, echoed: args }));
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'update_node_config',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: updateHandler,
        },
      ],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'orchestrator_tools.node_config.update',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { nodeId: 'windows-pc', extensionRelay: { enabled: true } },
      },
    });

    expect(updateHandler).toHaveBeenCalledOnce();
    expect(updateHandler.mock.calls[0]?.[0]).toEqual({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects read_node_output payloads that fail the schema (missing instanceId)', async () => {
    const readHandler = vi.fn();
    const { server } = makeServer({
      toolFactory: () => [
        {
          name: 'read_node_output',
          description: 'test tool',
          inputSchema: { type: 'object' },
          handler: readHandler,
        },
      ],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'orchestrator_tools.read_node_output',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { limit: 20 },
        },
      }),
    ).rejects.toThrow();
    expect(readHandler).not.toHaveBeenCalled();
  });

  it('rate-limits per instance', async () => {
    const { server } = makeServer({ rateLimit: { maxRequests: 2, windowMs: 60_000 } });

    const ok1 = server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'orchestrator_tools.git_batch_pull',
      params: { instanceId: KNOWN_INSTANCE, payload: { root: '/r1' } },
    });
    const ok2 = server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'orchestrator_tools.git_batch_pull',
      params: { instanceId: KNOWN_INSTANCE, payload: { root: '/r2' } },
    });
    await expect(ok1).resolves.toBeDefined();
    await expect(ok2).resolves.toBeDefined();

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'orchestrator_tools.git_batch_pull',
        params: { instanceId: KNOWN_INSTANCE, payload: { root: '/r3' } },
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });
});

describe('OrchestratorToolsRpcServer socket roundtrip', () => {
  let tmpDir: string;
  let server: OrchestratorToolsRpcServer;
  let toolHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-rpc-sock-'));
    toolHandler = vi.fn(async () => ({ ok: true, ran: 'in parent' }));
    server = new OrchestratorToolsRpcServer({
      userDataPath: tmpDir,
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      toolFactory: () => [
        {
          name: 'git_batch_pull',
          description: '',
          inputSchema: { type: 'object' },
          handler: toolHandler,
        },
      ],
      registerCleanup: () => undefined,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetOrchestratorToolsRpcServerForTesting();
  });

  it('handles an actual JSON-RPC roundtrip over a real socket', async () => {
    if (process.platform === 'win32') {
      // Skip on Windows — uses named pipes, the test connect path differs.
      return;
    }
    const socketPath = server.getSocketPath();
    expect(socketPath).toBeTruthy();

    const response = await new Promise<unknown>((resolve, reject) => {
      const client = net.connect(socketPath!);
      let buffer = '';
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('socket roundtrip timed out'));
      }, 3000);
      client.on('connect', () => {
        client.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 99,
            method: 'orchestrator_tools.git_batch_pull',
            params: {
              instanceId: KNOWN_INSTANCE,
              payload: { root: '/repo' },
            },
          })}\n`,
        );
      });
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { ok: true, ran: 'in parent' },
    });
    expect(toolHandler).toHaveBeenCalledOnce();
  });
});

describe('OrchestratorToolsRpcServer spawn-eligibility scoping (#18a/#19)', () => {
  afterEach(() => {
    _resetOrchestratorToolsRpcServerForTesting();
  });

  function threeToolServer(resolveSpawnEligibility?: (id: string) => boolean) {
    const tools: McpServerToolDefinition[] = ['git_batch_pull', 'list_remote_nodes', 'run_on_node', 'read_node_output'].map(
      (name) => ({
        name,
        description: `test ${name}`,
        inputSchema: { type: 'object' },
        handler: vi.fn(async (args: unknown) => ({ name, args })),
      }),
    );
    return new OrchestratorToolsRpcServer({
      userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ot-rpc-scope-')),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      toolFactory: () => tools,
      registerCleanup: () => undefined,
      resolveSpawnEligibility,
    });
  }

  it('strips run_on_node for an instance that is no longer spawn-eligible', async () => {
    const server = threeToolServer(() => false);
    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'orchestrator_tools.run_on_node',
        params: { instanceId: KNOWN_INSTANCE, payload: { prompt: 'do a thing' } },
      }),
    ).rejects.toThrow(/run_on_node tool unavailable/);
  });

  it('still exposes the non-spawn tools to an ineligible instance', async () => {
    const server = threeToolServer(() => false);
    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'orchestrator_tools.read_node_output',
      params: { instanceId: KNOWN_INSTANCE, payload: { instanceId: 'remote-1' } },
    });
    expect(result).toMatchObject({ name: 'read_node_output' });
  });

  it('still exposes list_remote_nodes to an ineligible instance', async () => {
    const server = threeToolServer(() => false);
    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'orchestrator_tools.list_remote_nodes',
      params: { instanceId: KNOWN_INSTANCE, payload: {} },
    });
    expect(result).toMatchObject({ name: 'list_remote_nodes' });
  });

  it('keeps run_on_node when the instance is still spawn-eligible', async () => {
    const server = threeToolServer(() => true);
    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'orchestrator_tools.run_on_node',
      params: { instanceId: KNOWN_INSTANCE, payload: { prompt: 'do a thing' } },
    });
    expect(result).toMatchObject({ name: 'run_on_node' });
  });

  it('keeps the full toolset when no eligibility resolver is wired', async () => {
    const server = threeToolServer(undefined);
    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'orchestrator_tools.run_on_node',
      params: { instanceId: KNOWN_INSTANCE, payload: { prompt: 'do a thing' } },
    });
    expect(result).toMatchObject({ name: 'run_on_node' });
  });
});

describe('OrchestratorToolsRpcServer singleton', () => {
  afterEach(() => {
    _resetOrchestratorToolsRpcServerForTesting();
  });

  it('returns the same instance from getOrchestratorToolsRpcServer', () => {
    const a = getOrchestratorToolsRpcServer({ registerCleanup: () => undefined });
    const b = getOrchestratorToolsRpcServer({ registerCleanup: () => undefined });
    expect(a).toBe(b);
  });
});
