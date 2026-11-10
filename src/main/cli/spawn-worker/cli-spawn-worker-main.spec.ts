import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnWorkerInboundMsg, SpawnWorkerOutboundMsg } from './cli-spawn-worker-protocol';

/** The compiled worker from `npm run build:main`; this spec needs a current dist/. */
const WORKER_ENTRY = resolve('dist/main/cli/spawn-worker/cli-spawn-worker-main.js');
/** `SHUTDOWN_GRACE_MS` in cli-spawn-worker-main.ts. */
const SHUTDOWN_GRACE_MS = 3000;

const workers: Worker[] = [];
const childPids: number[] = [];
const tempDirs: string[] = [];

async function startWorker() {
  const worker = new Worker(WORKER_ENTRY);
  workers.push(worker);
  const frames: SpawnWorkerOutboundMsg[] = [];
  worker.on('message', (frame: SpawnWorkerOutboundMsg) => frames.push(frame));
  const waitFor = (match: (frame: SpawnWorkerOutboundMsg) => boolean) =>
    vi.waitFor(() => {
      const frame = frames.find(match);
      expect(frame).toBeDefined();
      return frame!;
    }, { timeout: 5000, interval: 5 });
  const post = (msg: SpawnWorkerInboundMsg) => worker.postMessage(msg);
  await waitFor(frame => frame.type === 'ready');
  return { frames, waitFor, post };
}

type TestWorker = Awaited<ReturnType<typeof startWorker>>;

async function spawnChild(w: TestWorker, instanceId: string, script: string): Promise<number> {
  w.post({ type: 'spawn', id: 1, instanceId, command: process.execPath, args: ['-e', script], env: {}, cwd: process.cwd() });
  await w.waitFor(frame => frame.type === 'rpc-response' && frame.id === 1);
  const spawned = await w.waitFor(frame => frame.type === 'spawned' && frame.instanceId === instanceId);
  const pid = (spawned as Extract<SpawnWorkerOutboundMsg, { type: 'spawned' }>).pid;
  childPids.push(pid);
  await w.waitFor(frame => frame.type === 'stdout-chunk' && frame.instanceId === instanceId && frame.chunk.includes('armed'));
  return pid;
}

/** Posts `shutdown` and returns how long the worker took to answer it. */
async function timeShutdownAnswer(w: TestWorker): Promise<number> {
  const started = performance.now();
  w.post({ type: 'shutdown', id: 99 });
  await vi.waitFor(() => {
    expect(w.frames.some(frame => frame.type === 'rpc-response' && frame.id === 99)).toBe(true);
  }, { timeout: 2 * SHUTDOWN_GRACE_MS, interval: 5 });
  return performance.now() - started;
}

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cli spawn worker shutdown', () => {
  it('answers at once when it owns no child', async () => {
    const w = await startWorker();
    expect(await timeShutdownAnswer(w)).toBeLessThan(1000);
  });

  it('answers once its children have exited on SIGTERM, without waiting out the grace', async () => {
    const w = await startWorker();
    await spawnChild(w, 'polite', "process.stdout.write('armed'); setInterval(() => {}, 1000);");
    expect(await timeShutdownAnswer(w)).toBeLessThan(SHUTDOWN_GRACE_MS / 2);
    const answer = w.frames.findIndex(frame => frame.type === 'rpc-response' && frame.id === 99);
    const exited = w.frames.findIndex(frame => frame.type === 'exited' && frame.instanceId === 'polite');
    expect(exited).toBeGreaterThanOrEqual(0);
    expect(exited).toBeLessThan(answer);
  });

  it('escalates a child that ignores SIGTERM to SIGKILL after the grace', async () => {
    const w = await startWorker();
    const dir = mkdtempSync(join(tmpdir(), 'spawn-worker-shutdown-'));
    tempDirs.push(dir);
    // The child appends a beat every 20 ms; a killed child (even an unreaped zombie) stops beating.
    const beats = join(dir, 'beats');
    await spawnChild(w, 'stubborn', [
      "process.on('SIGTERM', () => {});",
      `setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(beats)}, '.'), 20);`,
      "process.stdout.write('armed');",
    ].join(' '));
    expect(await timeShutdownAnswer(w)).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 50);
    const pause = () => new Promise(done => setTimeout(done, 300));
    await pause();
    const settled = statSync(beats).size;
    await pause();
    expect(statSync(beats).size).toBe(settled);
  }, 15000);
});
