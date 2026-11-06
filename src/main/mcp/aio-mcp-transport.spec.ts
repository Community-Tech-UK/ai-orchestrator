import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotAccountCliOperations } from './copilot-account-cli-contracts';
import { dispatchCopilotAccountCliRpc, isCopilotAccountCliRpcMethod } from './orchestrator-tools-rpc-copilot-account';

const operations: CopilotAccountCliOperations = {
  list: async () => [],
  rules: async () => [],
  route: async (workingDirectory, origin) => ({
    ok: true, profileId: 'fixture', profileLabel: workingDirectory,
    source: 'default', detail: null, origin: origin ?? 'interactive',
  }),
  doctor: async () => ({
    aggregate: 'available', nodeId: 'fixture', legacyMigrationInUse: false,
    ambientTokenVariablesPresent: [], unreachableRuleIds: [], conflictingRuleIds: [], warnings: [],
  }),
};

const settings = {
  count: 1,
  settings: [{
    key: 'fixture', value: 'x'.repeat(512 * 1024), defaultValue: '', type: 'string',
    category: 'fixture', writable: false, restartRequired: false,
    description: 'Non-secret output backpressure fixture', policyTier: 'read-only',
  }],
};

describe('bundled aio-mcp CLI transport', () => {
  let buildDirectory: string;
  let socketDirectory: string;
  let socketPath: string;
  let entry: string;
  let server: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    await mkdir('_scratch', { recursive: true });
    buildDirectory = await mkdtemp(join(process.cwd(), '_scratch', 'aio-mcp-transport-'));
    // macOS Unix socket paths cannot fit beneath a queue checkout's long path.
    socketDirectory = await mkdtemp(join(tmpdir(), 'aio-r2-'));
    socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\aio-r2-${randomUUID()}`
      : join(socketDirectory, 'rpc.sock');
    entry = join(buildDirectory, 'cli.cjs');
    // Build outside jsdom: esbuild requires Node's matching typed-array globals.
    await promisify(execFile)(process.execPath, ['-e',
      'require("esbuild").buildSync(JSON.parse(process.argv[1]))', JSON.stringify({
        entryPoints: ['src/main/mcp/aio-mcp-dispatcher.ts'], outfile: entry,
        bundle: true, platform: 'node', target: 'node22', format: 'cjs',
        external: ['electron', 'better-sqlite3', '@sqlite.org/sqlite-wasm'],
        tsconfig: 'tsconfig.electron.json', logLevel: 'silent',
      }),
    ], { timeout: 20_000, killSignal: 'SIGKILL' });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        if (!input.includes('\n')) return;
        const line = input.slice(0, input.indexOf('\n'));
        input = '';
        void reply(line).then((response) => socket.end(`${JSON.stringify(response)}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  });

  async function reply(line: string) {
    const request = JSON.parse(line) as {
      id: number; method: string;
      params: { instanceId: string; capability: string; payload: Record<string, unknown> };
    };
    try {
      if (request.params.instanceId !== 'TEST_ONLY_INSTANCE'
        || request.params.capability !== 'TEST_ONLY_CAPABILITY') throw new Error('fixture authentication refused');
      const { method, params } = request;
      const result = isCopilotAccountCliRpcMethod(method)
        ? await dispatchCopilotAccountCliRpc(method, params.payload, operations)
        : method === 'orchestrator_tools.settings.privileged_list'
          ? settings
          : (() => { throw new Error('fixture RPC failure'); })();
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id: request.id, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function run(args: string[], slowReader = false) {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'TEST_ONLY_INSTANCE',
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'TEST_ONLY_CAPABILITY',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (slowReader) {
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 5);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('CLI did not exit'));
        else resolve(code);
      });
    });
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  }

  it.each(['list', 'rules', 'doctor', 'route'])('sends one payload envelope for copilot-account %s', async (command) => {
    const args = ['copilot-account', command, ...(command === 'route' ? ['/fixture', '--origin=automation'] : []), '--json'];
    const result = await run(args);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    if (command === 'route') expect(parsed).toMatchObject({ profileLabel: '/fixture', origin: 'automation' });
    else expect(parsed).toEqual(command === 'doctor' ? await operations.doctor() : []);
  });

  it.each([false, true])('drains large settings JSON to a pipe (slow reader: %s)', async (slowReader) => {
    const result = await run(['settings', 'list', '--json'], slowReader);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const expected = `${JSON.stringify(settings, null, 2)}\n`;
    expect(Buffer.byteLength(result.stdout)).toBe(Buffer.byteLength(expected));
    expect(JSON.parse(result.stdout)).toEqual(settings);
  });

  it('retains a nonzero exit and diagnostic for an RPC failure', async () => {
    const result = await run(['settings', 'get', 'fixture', '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('fixture RPC failure');
  });
});
