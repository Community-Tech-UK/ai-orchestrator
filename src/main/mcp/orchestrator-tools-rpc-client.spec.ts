import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OrchestratorToolsRpcClient,
  OrchestratorToolsUnavailableError,
} from './orchestrator-tools-rpc-client';

describe('OrchestratorToolsRpcClient', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('throws OrchestratorToolsUnavailableError when env vars are missing', async () => {
    const client = new OrchestratorToolsRpcClient({ env: {} });
    await expect(client.call('orchestrator_tools.git_batch_pull', { root: '/r' })).rejects.toBeInstanceOf(
      OrchestratorToolsUnavailableError,
    );
  });

  it('throws OrchestratorToolsUnavailableError when only one env var is set', async () => {
    const a = new OrchestratorToolsRpcClient({
      env: { AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: '/tmp/x.sock' },
    });
    await expect(a.call('orchestrator_tools.git_batch_pull', { root: '/r' })).rejects.toBeInstanceOf(
      OrchestratorToolsUnavailableError,
    );

    const b = new OrchestratorToolsRpcClient({
      env: { AI_ORCHESTRATOR_INSTANCE_ID: 'inst-1' },
    });
    await expect(b.call('orchestrator_tools.git_batch_pull', { root: '/r' })).rejects.toBeInstanceOf(
      OrchestratorToolsUnavailableError,
    );
  });

  it('sends a single line-delimited JSON-RPC envelope and resolves the parent reply', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-client-test-'));
    const socketPath = path.join(tmpDir, 'ot.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const receivedLines: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        receivedLines.push(buffer.slice(0, newline));
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { ok: true, called: 'parent' },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const client = new OrchestratorToolsRpcClient({
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-roundtrip',
      },
    });

    const result = await client.call('orchestrator_tools.git_batch_pull', { root: '/repo' });

    expect(result).toEqual({ ok: true, called: 'parent' });
    expect(receivedLines).toHaveLength(1);
    const envelope = JSON.parse(receivedLines[0]!) as {
      jsonrpc: string;
      method: string;
      params: { instanceId: string; payload: Record<string, unknown> };
    };
    expect(envelope.jsonrpc).toBe('2.0');
    expect(envelope.method).toBe('orchestrator_tools.git_batch_pull');
    expect(envelope.params).toEqual({ instanceId: 'inst-roundtrip', payload: { root: '/repo' } });
  });

  it('rejects with the parent\'s error message when the response carries an error envelope', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-client-err-'));
    const socketPath = path.join(tmpDir, 'ot.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'boom from parent' },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const client = new OrchestratorToolsRpcClient({
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-err',
      },
    });

    await expect(client.call('orchestrator_tools.git_batch_pull', { root: '/r' })).rejects.toThrow(
      /boom from parent/,
    );
  });

  it('times out if the parent never replies', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-client-to-'));
    const socketPath = path.join(tmpDir, 'ot.sock');
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Track every accepted socket so we can destroy them in cleanup —
    // otherwise server.close() blocks forever waiting for half-open
    // connections from the deliberately-unresponsive parent.
    const acceptedSockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      acceptedSockets.push(socket);
      /* accept but never reply */
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => {
      for (const socket of acceptedSockets) {
        socket.destroy();
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const client = new OrchestratorToolsRpcClient({
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'inst-slow',
      },
      timeoutMs: 50,
    });

    await expect(client.call('orchestrator_tools.git_batch_pull', { root: '/r' })).rejects.toThrow(
      /timed out/,
    );
  });
});
