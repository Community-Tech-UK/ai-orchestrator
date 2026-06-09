import { spawn, type ChildProcess } from 'node:child_process';
import { isMainThread, parentPort } from 'node:worker_threads';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { buildCliSpawnOptions } from '../cli-environment';
import { killProcessGroup } from '../adapters/base-cli-process-utils';
import { resolveWindowsSpawn } from '../adapters/windows-cli-spawn';
import type {
  SpawnWorkerInboundMsg,
  SpawnWorkerOutboundMsg,
  SpawnWorkerSignal,
} from './cli-spawn-worker-protocol';

if (isMainThread) {
  throw new Error('cli-spawn-worker-main must run in a worker thread');
}

const OUTPUT_FLUSH_INTERVAL_MS = 30;
const OUTPUT_FLUSH_MAX_CHARS = 16_384;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
const SHUTDOWN_GRACE_MS = 3000;

interface ManagedSpawn {
  process: ChildProcess;
  stdoutBuffer: string;
  stderrBuffer: string;
  stdoutTimer: ReturnType<typeof setTimeout> | null;
  stderrTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  processGeneration: number;
  alive: boolean;
}

const sessions = new Map<string, ManagedSpawn>();
let generationCounter = 0;

function post(msg: SpawnWorkerOutboundMsg): void {
  parentPort!.postMessage(msg);
}

function respond(id: number, result?: unknown, error?: string): void {
  post({ type: 'rpc-response', id, result, error });
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
}

function flush(instanceId: string, pipe: 'stdout' | 'stderr'): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  const key = pipe === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
  const timerKey = pipe === 'stdout' ? 'stdoutTimer' : 'stderrTimer';
  const chunk = session[key];
  if (!chunk) return;
  session[key] = '';
  clearTimer(session[timerKey]);
  session[timerKey] = null;
  post({
    type: pipe === 'stdout' ? 'stdout-chunk' : 'stderr-chunk',
    instanceId,
    chunk,
  });
}

function bufferOutput(instanceId: string, pipe: 'stdout' | 'stderr', chunk: string): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  const key = pipe === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
  const timerKey = pipe === 'stdout' ? 'stdoutTimer' : 'stderrTimer';
  session[key] += chunk;
  if (session[key].length >= OUTPUT_FLUSH_MAX_CHARS) {
    flush(instanceId, pipe);
    return;
  }
  if (!session[timerKey]) {
    session[timerKey] = setTimeout(() => flush(instanceId, pipe), OUTPUT_FLUSH_INTERVAL_MS);
    session[timerKey]?.unref?.();
  }
}

function resetIdleWatchdog(instanceId: string, generation: number): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  clearTimer(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    const current = sessions.get(instanceId);
    if (!current || !current.alive || current.processGeneration !== generation) return;
    post({ type: 'stream-idle', instanceId, timeoutMs: current.idleTimeoutMs });
  }, session.idleTimeoutMs);
  session.idleTimer.unref?.();
}

function closeSession(instanceId: string, code: number | null, signal: string | null): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  session.alive = false;
  flush(instanceId, 'stdout');
  flush(instanceId, 'stderr');
  clearTimer(session.stdoutTimer);
  clearTimer(session.stderrTimer);
  clearTimer(session.idleTimer);
  sessions.delete(instanceId);
  post({ type: 'exited', instanceId, code, signal });
}

function spawnInstance(msg: Extract<SpawnWorkerInboundMsg, { type: 'spawn' }>): void {
  if (sessions.has(msg.instanceId)) {
    throw new Error(`Spawn worker instance already exists: ${msg.instanceId}`);
  }
  const safeEnv = getSafeEnvForTrustedProcess();
  delete safeEnv['CLAUDECODE'];
  const mergedEnv = { ...safeEnv, ...msg.env };
  const spawnOptions = buildCliSpawnOptions(mergedEnv);

  // Mirror BaseCliAdapter.resolveSpawnTarget: on Windows, resolve the `<cli>.cmd`
  // shim to a directly-spawnable launcher and switch to shell:false so a proper
  // argv array survives cmd.exe (which otherwise mangles the inline
  // --system-prompt / --mcp-config built by buildWorkerArgs). Any resolution
  // failure leaves the original shell-shim spawn untouched, so it can't regress.
  const target = resolveWindowsSpawn(
    msg.command,
    msg.args,
    Boolean(spawnOptions.shell),
    spawnOptions.env ?? mergedEnv,
  );

  const proc = spawn(target.command, target.args, {
    cwd: msg.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions,
    shell: target.shell,
    detached: target.detached,
  });
  const generation = ++generationCounter;
  const session: ManagedSpawn = {
    process: proc,
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutTimer: null,
    stderrTimer: null,
    idleTimer: null,
    idleTimeoutMs: msg.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    processGeneration: generation,
    alive: true,
  };
  sessions.set(msg.instanceId, session);

  proc.stdout?.on('data', (chunk: Buffer) => {
    resetIdleWatchdog(msg.instanceId, generation);
    bufferOutput(msg.instanceId, 'stdout', chunk.toString());
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    resetIdleWatchdog(msg.instanceId, generation);
    bufferOutput(msg.instanceId, 'stderr', chunk.toString());
  });
  proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      post({ type: 'epipe', instanceId: msg.instanceId, pipe: 'stdin' });
      return;
    }
    respond(msg.id, undefined, err.message);
  });
  proc.stdout?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      post({ type: 'epipe', instanceId: msg.instanceId, pipe: 'stdout' });
    }
  });
  let spawnResponded = false;
  proc.once('spawn', () => {
    spawnResponded = true;
    if (proc.pid) {
      post({ type: 'spawned', instanceId: msg.instanceId, pid: proc.pid });
    }
    if (msg.closeStdin) {
      proc.stdin?.end();
    }
    respond(msg.id, { pid: proc.pid ?? null });
  });
  proc.on('error', (err) => {
    if (!spawnResponded) {
      sessions.delete(msg.instanceId);
      respond(msg.id, undefined, err.message);
      return;
    }
    bufferOutput(msg.instanceId, 'stderr', err.message);
  });
  proc.on('close', (code, signal) => {
    closeSession(msg.instanceId, code, signal);
  });
}

async function writeStdin(msg: Extract<SpawnWorkerInboundMsg, { type: 'stdin-write' }>): Promise<void> {
  const session = sessions.get(msg.instanceId);
  if (!session?.process.stdin?.writable || session.process.stdin.destroyed) {
    return;
  }
  const canContinue = session.process.stdin.write(msg.data);
  if (!canContinue) {
    await new Promise<void>((resolve) => {
      session.process.stdin!.once('drain', resolve);
    });
  }
  if (msg.closeAfterWrite) {
    session.process.stdin.end();
  }
}

async function terminateInstance(instanceId: string, graceful: boolean): Promise<void> {
  const session = sessions.get(instanceId);
  if (!session) return;
  const pid = session.process.pid;
  if (graceful) {
    killProcessGroup(pid, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      session.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } else {
    killProcessGroup(pid, 'SIGKILL');
  }
}

async function shutdown(): Promise<void> {
  const ids = Array.from(sessions.keys());
  for (const instanceId of ids) {
    killProcessGroup(sessions.get(instanceId)?.process.pid, 'SIGTERM');
  }
  await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  for (const instanceId of ids) {
    const session = sessions.get(instanceId);
    if (session?.alive) killProcessGroup(session.process.pid, 'SIGKILL');
  }
}

function sendSignal(instanceId: string, signal: SpawnWorkerSignal): void {
  killProcessGroup(sessions.get(instanceId)?.process.pid, signal);
}

process.on('uncaughtException', (err) => {
  for (const session of sessions.values()) {
    killProcessGroup(session.process.pid, 'SIGTERM');
  }
  throw err;
});

parentPort!.on('message', (msg: SpawnWorkerInboundMsg) => {
  void (async () => {
    try {
      switch (msg.type) {
        case 'spawn':
          spawnInstance(msg);
          break;
        case 'stdin-write':
          await writeStdin(msg);
          respond(msg.id);
          break;
        case 'signal':
          sendSignal(msg.instanceId, msg.signal);
          break;
        case 'terminate':
          await terminateInstance(msg.instanceId, msg.graceful);
          respond(msg.id);
          break;
        case 'shutdown':
          await shutdown();
          respond(msg.id);
          process.exit(0);
      }
    } catch (err) {
      if ('id' in msg) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
    }
  })();
});

post({ type: 'ready' });
