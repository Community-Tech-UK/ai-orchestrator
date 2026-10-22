/**
 * End to end: the Worker Mode "Start Worker" path really starts a worker that
 * connects, and its report tells the page what happened.
 *
 * Runs the real worker entrypoint (through tsx) under the real supervisor,
 * started by the same WorkerModeRuntimeService the Start Worker button uses,
 * against a stand-in coordinator WebSocket. HOME is a temporary folder so the
 * worker's logs, config and report never touch the developer's own.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { WorkerModeRuntimeService } from '../main/remote-node/worker-mode-runtime-service';
import { readWorkerConnectionStatus, workerConnectionStatusPath } from './worker-connection-status';
import type { WorkerConnectionState } from '../shared/types/pair-both.types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const WAIT_MS = 90_000;

type CoordinatorReply = 'accept' | 'reject';

interface Harnessed {
  home: string;
  configPath: string;
  runtime: WorkerModeRuntimeService;
  server: WebSocketServer | null;
}

const started: Harnessed[] = [];

async function startCoordinator(reply: CoordinatorReply): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      if (message.method !== 'node.register') {
        return;
      }
      if (reply === 'reject') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'pairing pass placeholder-pairing-pass expired' } }));
        ws.close(4001, 'Unauthorized');
        return;
      }
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { token: 'placeholder-node-pass', recoveryToken: 'placeholder-recovery-pass' },
      }));
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

function startWorker(coordinatorUrl: string | undefined, server: WebSocketServer | null): Harnessed {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-start-'));
  const configPath = path.join(home, '.orchestrator', 'worker-node.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const id = `e2e-${process.pid}-${started.length}`;
  fs.writeFileSync(configPath, JSON.stringify({
    nodeId: id,
    name: 'e2e-worker',
    ...(coordinatorUrl ? { coordinatorUrl } : {}),
    authToken: 'placeholder-pairing-pass',
    namespace: id,
    maxConcurrentInstances: 1,
    workingDirectories: [home],
  }, null, 2));

  const runtime = new WorkerModeRuntimeService({
    resolveCommand: () => ({ command: process.execPath, args: [path.join(REPO_ROOT, 'src/worker-agent/index.ts')] }),
    // NODE_OPTIONS (not argv) so the supervisor's own child also loads tsx.
    spawn: (command, args, options) => spawn(command, args, {
      ...options,
      cwd: REPO_ROOT,
      env: { ...options.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '--import tsx' },
    }),
  });
  const harnessed = { home, configPath, runtime, server };
  started.push(harnessed);
  expect(runtime.start({ configPath }).state).toBe('running');
  return harnessed;
}

async function waitForState(configPath: string, want: WorkerConnectionState) {
  const deadline = Date.now() + WAIT_MS;
  let last = readWorkerConnectionStatus(configPath);
  while (Date.now() < deadline) {
    last = readWorkerConnectionStatus(configPath);
    if (last?.state === want) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`worker never reported "${want}"; last report: ${JSON.stringify(last)}`);
}

describe('Start Worker, end to end', () => {
  afterEach(async () => {
    for (const harnessed of started.splice(0)) {
      await harnessed.runtime.stopAndWait();
      harnessed.server?.close();
      fs.rmSync(harnessed.home, { recursive: true, force: true });
    }
  });

  it('connects to the main Harness and says so', async () => {
    const { server, port } = await startCoordinator('accept');
    const { configPath } = startWorker(`ws://127.0.0.1:${port}`, server);

    const report = await waitForState(configPath, 'connected');

    expect(report).toMatchObject({ coordinatorUrl: `ws://127.0.0.1:${port}`, alive: true, stale: false });
    const raw = fs.readFileSync(workerConnectionStatusPath(configPath), 'utf-8');
    expect(raw).not.toMatch(/placeholder-(node|recovery|pairing)-pass/);
  }, WAIT_MS + 30_000);

  it('says when the main Harness refuses this computer', async () => {
    const { server, port } = await startCoordinator('reject');
    const { configPath } = startWorker(`ws://127.0.0.1:${port}`, server);

    const report = await waitForState(configPath, 'rejected');

    // The main Harness quoted this worker's own credential: it must not reach the report.
    expect(report.message).toBe('pairing pass [hidden] expired');
    expect(fs.readFileSync(workerConnectionStatusPath(configPath), 'utf-8')).not.toContain('placeholder-pairing-pass');
  }, WAIT_MS + 30_000);

  it('says when the main Harness cannot be reached', async () => {
    const { configPath } = startWorker('ws://127.0.0.1:1', null);

    const report = await waitForState(configPath, 'unreachable');

    expect(report.message).toBe('No answer from 127.0.0.1:1.');
  }, WAIT_MS + 30_000);

  it('says why it could not start when the pairing has no address for the main Harness', async () => {
    const { configPath } = startWorker(undefined, null);

    const report = await waitForState(configPath, 'failed');

    expect(report.message).toBe('This computer has no address for the main Harness. Pair it again.');
  }, WAIT_MS + 30_000);
});
