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
    throw new Error('better-sqlite3 should not be touched when facadeFactory is injected');
  }),
}));

vi.mock('./cas-schema', () => ({
  migrate: vi.fn(),
}));

vi.mock('../lsp-worker/gateway-rpc', () => ({
  LspWorkerGateway: vi.fn(() => ({ stop: vi.fn() })),
}));

import {
  CodememRpcServer,
  _resetCodememRpcServerForTesting,
  getCodememRpcServer,
  type CodememFacadeLike,
} from './codemem-rpc-server';

const KNOWN_INSTANCE = 'instance-known';

function stubFacade(overrides: Partial<CodememFacadeLike> = {}): CodememFacadeLike {
  const base: CodememFacadeLike = {
    findSymbol: vi.fn(async () => ({ status: 'ok', matches: [] })) as never,
    findReferences: vi.fn(async () => ({ status: 'ok', references: [] })) as never,
    documentSymbols: vi.fn(async () => ({ status: 'ok', symbols: [] })) as never,
    workspaceSymbols: vi.fn(async () => ({ status: 'ok', matches: [] })) as never,
    callHierarchy: vi.fn(async () => ({ status: 'ok', graph: [] })) as never,
    findImplementations: vi.fn(async () => ({ status: 'ok', implementations: [] })) as never,
    hover: vi.fn(async () => ({ status: 'ok', hover: null })) as never,
    diagnostics: vi.fn(async () => ({ status: 'ok', diagnostics: [] })) as never,
  };
  return { ...base, ...overrides };
}

function makeServer(facade: CodememFacadeLike = stubFacade()): CodememRpcServer {
  return new CodememRpcServer({
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rpc-test-')),
    isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
    facadeFactory: () => facade,
    registerCleanup: () => undefined,
  });
}

describe('CodememRpcServer.handleRequest dispatch', () => {
  afterEach(() => {
    _resetCodememRpcServerForTesting();
  });

  it('dispatches find_symbol with validated args', async () => {
    const facade = stubFacade();
    const server = makeServer(facade);

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'codemem.find_symbol',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { name: 'fooBar', workspacePath: '/repo', limit: 25 },
      },
    });

    expect(facade.findSymbol).toHaveBeenCalledWith('fooBar', expect.objectContaining({
      name: 'fooBar',
      workspacePath: '/repo',
      limit: 25,
    }));
    expect(result).toEqual({ status: 'ok', matches: [] });
  });

  it('dispatches each tool method to the matching facade method', async () => {
    const facade = stubFacade();
    const server = makeServer(facade);

    const cases: Array<{ method: string; payload: Record<string, unknown>; expectedMethod: keyof CodememFacadeLike }> = [
      { method: 'codemem.find_references', payload: { symbolId: 's:1', limit: 10 }, expectedMethod: 'findReferences' },
      { method: 'codemem.document_symbols', payload: { path: '/repo/x.ts' }, expectedMethod: 'documentSymbols' },
      { method: 'codemem.workspace_symbols', payload: { query: 'foo' }, expectedMethod: 'workspaceSymbols' },
      { method: 'codemem.call_hierarchy', payload: { symbolId: 's:1', direction: 'incoming' }, expectedMethod: 'callHierarchy' },
      { method: 'codemem.find_implementations', payload: { symbolId: 's:1' }, expectedMethod: 'findImplementations' },
      { method: 'codemem.hover', payload: { symbolId: 's:1' }, expectedMethod: 'hover' },
      { method: 'codemem.diagnostics', payload: { path: '/repo/x.ts' }, expectedMethod: 'diagnostics' },
    ];

    for (const c of cases) {
      await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: c.method,
        params: { instanceId: KNOWN_INSTANCE, payload: c.payload },
      });
      expect(facade[c.expectedMethod], `${c.method} -> ${c.expectedMethod}`).toHaveBeenCalled();
    }
  });

  it('rejects requests from unknown instances', async () => {
    const server = makeServer();
    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'codemem.find_symbol',
        params: { instanceId: 'instance-evil', payload: { name: 'x' } },
      }),
    ).rejects.toThrow(/unknown codemem instance/);
  });

  it('rejects unknown method names', async () => {
    const server = makeServer();
    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'codemem.delete_everything',
        params: { instanceId: KNOWN_INSTANCE, payload: {} },
      }),
    ).rejects.toThrow(/Unknown codemem RPC method/);
  });

  it('rejects payloads that fail Zod validation', async () => {
    const facade = stubFacade();
    const server = makeServer(facade);
    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'codemem.find_symbol',
        // missing required `name`
        params: { instanceId: KNOWN_INSTANCE, payload: {} },
      }),
    ).rejects.toThrow();
    expect(facade.findSymbol).not.toHaveBeenCalled();
  });
});

describe('CodememRpcServer socket roundtrip', () => {
  let tmpDir: string;
  let server: CodememRpcServer;
  let facade: CodememFacadeLike;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rpc-sock-'));
    facade = stubFacade({
      findSymbol: vi.fn(async () => ({ status: 'ok', matches: [{ id: 's:1' }] })) as never,
    });
    server = new CodememRpcServer({
      userDataPath: tmpDir,
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      facadeFactory: () => facade,
      registerCleanup: () => undefined,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetCodememRpcServerForTesting();
  });

  it('serves a real client request end-to-end', async () => {
    if (process.platform === 'win32') return;
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
            id: 7,
            method: 'codemem.find_symbol',
            params: {
              instanceId: KNOWN_INSTANCE,
              payload: { name: 'fooBar' },
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
      id: 7,
      result: { status: 'ok', matches: [{ id: 's:1' }] },
    });
  });
});

describe('CodememRpcServer singleton', () => {
  afterEach(() => {
    _resetCodememRpcServerForTesting();
  });

  it('returns the same instance from getCodememRpcServer', () => {
    const a = getCodememRpcServer({
      registerCleanup: () => undefined,
      facadeFactory: () => stubFacade(),
    });
    const b = getCodememRpcServer({
      registerCleanup: () => undefined,
      facadeFactory: () => stubFacade(),
    });
    expect(a).toBe(b);
  });
});
