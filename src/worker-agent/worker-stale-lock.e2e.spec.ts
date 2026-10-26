/**
 * End to end: a worker child respawned by the supervisor takes over a lock
 * left by the child that was force-killed before it.
 *
 * windows-pc, 2026-10-14: the dead child's pid read as alive by the time the
 * supervisor respawned it 1s later, so the respawn exited as a duplicate and
 * the supervisor took that as a deliberate stop. A live process that is not a
 * worker (this test process) stands in for the reused pid.
 *
 * Runs the real worker entrypoint (through tsx) against a stand-in coordinator
 * WebSocket. HOME is a temporary folder so the worker's logs, config and
 * report never touch the developer's own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { singleInstanceLockPath } from './single-instance-lock';
import { readWorkerConnectionStatus } from './worker-connection-status';
import { WORKER_PREVIOUS_CHILD_PID_ENV } from './worker-supervisor';

const REPO_ROOT = path.resolve(__dirname, '../..');
const WAIT_MS = 90_000;

interface Started {
  home: string;
  lockPath: string;
  child: ChildProcess;
  output: string[];
  server: WebSocketServer;
}

const started: Started[] = [];

async function startCoordinator(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      if (message.method === 'node.register') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { token: 'placeholder-node-pass', recoveryToken: 'placeholder-recovery-pass' },
        }));
      }
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

/** Starts a worker child whose node lock names this (live, non-worker) test process. */
async function startChildBehindStaleLock(previousChildPid: number | undefined): Promise<Started & { configPath: string }> {
  const { server, port } = await startCoordinator();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-stale-lock-'));
  const configPath = path.join(home, '.orchestrator', 'worker-node.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const id = `e2e-lock-${process.pid}-${started.length}`;
  fs.writeFileSync(configPath, JSON.stringify({
    nodeId: id,
    name: 'e2e-worker',
    coordinatorUrl: `ws://127.0.0.1:${port}`,
    authToken: 'placeholder-pairing-pass',
    namespace: id,
    maxConcurrentInstances: 1,
    workingDirectories: [home],
  }, null, 2));
  const lockPath = singleInstanceLockPath(`${id}:${id}`);
  fs.writeFileSync(lockPath, `${process.pid}\n`);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '--import tsx' };
  delete env[WORKER_PREVIOUS_CHILD_PID_ENV];
  if (previousChildPid !== undefined) env[WORKER_PREVIOUS_CHILD_PID_ENV] = String(previousChildPid);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src/worker-agent/index.ts'), '--config', configPath], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const entry = { home, lockPath, child, output, server };
  started.push(entry);
  return { ...entry, configPath };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

describe('worker child behind a stale lock, end to end', () => {
  afterEach(async () => {
    for (const entry of started.splice(0)) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill('SIGTERM');
        await exited(entry.child);
      }
      entry.server.close();
      fs.rmSync(entry.lockPath, { force: true });
      fs.rmSync(entry.home, { recursive: true, force: true });
    }
  });

  it('takes over a lock naming the child the supervisor saw exit, and connects', async () => {
    const { child, configPath, output } = await startChildBehindStaleLock(process.pid);

    const deadline = Date.now() + WAIT_MS;
    while (
      Date.now() < deadline
      && child.exitCode === null
      && readWorkerConnectionStatus(configPath)?.state !== 'connected'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(readWorkerConnectionStatus(configPath)?.state).toBe('connected');
    expect(output.join('')).not.toContain('Another worker is already running');
  }, WAIT_MS + 30_000);

  it('still exits as a duplicate when the live holder is not the child that exited', async () => {
    const { child, output } = await startChildBehindStaleLock(undefined);

    expect(await exited(child)).toBe(0);
    expect(output.join('')).toContain('Another worker is already running');
  }, WAIT_MS + 30_000);
});
