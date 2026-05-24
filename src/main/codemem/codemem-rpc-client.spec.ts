import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodememRpcClient, CodememUnavailableError } from './codemem-rpc-client';

describe('CodememRpcClient', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('throws CodememUnavailableError when env vars are missing', async () => {
    const client = new CodememRpcClient({ env: {} });
    await expect(client.call('codemem.find_symbol', { name: 'x' })).rejects.toBeInstanceOf(
      CodememUnavailableError,
    );
  });

  it('round-trips a JSON-RPC request to a socket server', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-client-test-'));
    const socketPath = path.join(tmpDir, 'cm.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const received: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        received.push(buffer.slice(0, newline));
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { status: 'ok', matches: [] },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const client = new CodememRpcClient({
      env: {
        AI_ORCHESTRATOR_CODEMEM_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-cm',
      },
    });

    const result = await client.call('codemem.find_symbol', { name: 'foo' });
    expect(result).toEqual({ status: 'ok', matches: [] });
    expect(received).toHaveLength(1);
    const envelope = JSON.parse(received[0]!) as {
      method: string;
      params: { instanceId: string; payload: Record<string, unknown> };
    };
    expect(envelope.method).toBe('codemem.find_symbol');
    expect(envelope.params).toEqual({ instanceId: 'inst-cm', payload: { name: 'foo' } });
  });

  it('rejects when the parent returns an error envelope', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-client-err-'));
    const socketPath = path.join(tmpDir, 'cm.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'index not built' },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const client = new CodememRpcClient({
      env: {
        AI_ORCHESTRATOR_CODEMEM_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-err',
      },
    });

    await expect(client.call('codemem.find_symbol', { name: 'x' })).rejects.toThrow(/index not built/);
  });

  it('times out if the parent never replies', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-client-to-'));
    const socketPath = path.join(tmpDir, 'cm.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => {
      for (const s of accepted) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const client = new CodememRpcClient({
      env: {
        AI_ORCHESTRATOR_CODEMEM_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-slow',
      },
      timeoutMs: 50,
    });
    await expect(client.call('codemem.find_symbol', { name: 'x' })).rejects.toThrow(/timed out/);
  });
});
