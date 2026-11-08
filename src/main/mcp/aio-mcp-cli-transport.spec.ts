// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { dispatchCopilotAccountCliRpc, isCopilotAccountCliRpcMethod } from './orchestrator-tools-rpc-copilot-account';
import type { CopilotAccountCliOperations } from './copilot-account-cli-contracts';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 30_000 });

describe('the built CLI over a real parent transport', () => {
  let directory: string;
  let entry: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'aio-cli-transport-'));
    entry = path.join(directory, 'dispatcher.cjs');
    await build({ entryPoints: ['src/main/mcp/aio-mcp-dispatcher.ts'], outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      tsconfig: 'tsconfig.electron.json',
      external: ['electron', 'better-sqlite3', '@sqlite.org/sqlite-wasm'] });
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function run(args: string[], respond: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\aio-cli-${randomUUID()}` : path.join(directory, `${randomUUID().slice(0, 8)}.sock`);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          id: number; method: string; params: { payload: Record<string, unknown> };
        };
        void respond(request.method, request.params.payload).then(
          (result) => socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`),
          (error: unknown) => socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env,
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
      AI_ORCHESTRATOR_INSTANCE_ID: 'placeholder-instance',
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'placeholder-capability',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Apply ordinary reader backpressure; no CPU stress or output discarding.
    child.stdout.pause();
    const resume = setTimeout(() => child.stdout.resume(), 100);
    const deadline = setTimeout(() => child.kill('SIGTERM'), 10_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
    } finally {
      clearTimeout(resume);
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  const operations: CopilotAccountCliOperations = {
    list: async () => [], rules: async () => [],
    route: async (workingDirectory, origin) => ({ ok: true, profileId: 'placeholder-profile',
      profileLabel: workingDirectory, source: 'default', detail: null, origin: origin ?? 'interactive' }),
    doctor: async () => ({ aggregate: 'available', nodeId: 'local', legacyMigrationInUse: false,
      ambientTokenVariablesPresent: [], unreachableRuleIds: [], conflictingRuleIds: [], warnings: [] }),
  };

  it.each([['list'], ['rules'], ['doctor'], ['route', '/placeholder', '--origin=automation']])(
    'accepts the %s command through the strict parent dispatcher', async (...args) => {
      const result = await run(['copilot-account', ...args, '--json'], async (method, payload) => {
        if (!isCopilotAccountCliRpcMethod(method)) throw new Error('Unexpected method');
        return dispatchCopilotAccountCliRpc(method, payload, operations);
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args[0] === 'route'
        ? await operations.route('/placeholder', 'automation')
        : await operations[args[0] as 'list' | 'rules' | 'doctor']());
    },
  );

  it('preserves a settings result larger than the pipe buffer before successful exit', async () => {
    const settings = [{ key: 'placeholder', value: 'harmless '.repeat(50_000),
      defaultValue: '', type: 'string',
      restartRequired: false, writable: false, description: 'Synthetic pipe fixture',
      policyTier: 'read-only', category: 'placeholder' }];
    const result = await run(['settings', 'list', '--json'], async () => ({ count: 1, settings }));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const expected = `${JSON.stringify({ count: 1, settings }, null, 2)}\n`;
    expect(Buffer.byteLength(result.stdout)).toBe(Buffer.byteLength(expected));
    expect(createHash('sha256').update(result.stdout).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
    expect(JSON.parse(result.stdout).count).toBe(1);
  });

  it('keeps a parent refusal nonzero and preserves its diagnostic', async () => {
    const result = await run(['settings', 'list', '--json'], async () => {
      throw new Error('placeholder parent refusal');
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('aio-mcp settings failed: placeholder parent refusal\n');
  });
});
