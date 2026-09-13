import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { NodeExecParams } from '../main/remote-node/node-control-rpc-schemas';
import { RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import { WorkerNodeExecutor } from './worker-node-executor';
import {
  createPosixDescendantTracker,
  NODE_EXEC_MAX_TRACKED_PROCESSES,
  NODE_EXEC_OWNERSHIP_MARKER_ENV,
  terminatePosixProcessTree,
} from './worker-node-process-tree';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import type { RpcMessage } from './worker-rpc-types';

async function prepareUncheckedForLifecycleTest(params: NodeExecParams) {
  return { executable: params.executable, args: [...params.args], env: { ...process.env } };
}

const resolveTrustedTaskkill = async (): Promise<string> => (
  'C:\\Windows\\System32\\taskkill.exe'
);

function makeDispatcher(
  recoverExtensionRelay = vi.fn(async () => ({
    before: { enabled: true, running: true, lastExtensionContactAt: 100 },
    after: { enabled: true, running: true, lastExtensionContactAt: 100 },
  })),
  workingDirectories = [process.cwd()],
  executeNodeCommand?: WorkerNodeExecutor['execute'],
) {
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const lifecycleExecutor = new WorkerNodeExecutor(
    workingDirectories,
    undefined,
    Date.now,
    undefined,
    prepareUncheckedForLifecycleTest,
  );
  const resolvedExecuteNodeCommand = executeNodeCommand
    ?? lifecycleExecutor.execute.bind(lifecycleExecutor);
  const dispatcher = new WorkerRpcDispatcher({
    config: { workingDirectories },
    instanceManager: {},
    getFilesystemHandler: () => ({}),
    getSyncHandler: () => ({}),
    getTerminalHandler: () => ({}),
    applyConfigUpdate: vi.fn(),
    getCdpTunnel: () => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }),
    stopManagedBrowser: vi.fn(async () => undefined),
    recoverExtensionRelay,
    executeNodeCommand: resolvedExecuteNodeCommand,
    sendResult,
    sendError,
  } as never);
  return { dispatcher, recoverExtensionRelay, sendResult, sendError };
}

function request(method: string, params: unknown, scope?: 'instance' | 'service'): RpcMessage {
  return { jsonrpc: '2.0', id: 73, method, params, scope };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function execFileReturning(stdout: string): typeof execFile {
  return ((...values: unknown[]) => {
    const callback = values[3] as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(null, stdout, ''));
    return { unref: vi.fn() };
  }) as unknown as typeof execFile;
}

function makeFakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WorkerRpcDispatcher node.exec', () => {
  it('passes shell metacharacters as a literal argv element', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();
    const literal = '$(echo injected); touch should-not-exist';

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', literal],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: 0,
      stdout: literal,
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: expect.any(Number),
    }));
  });

  it('bounds both output streams and the serialized RPC result below 256 KiB', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write("\\0".repeat(120000)); process.stderr.write("\\0".repeat(120000))',
      ],
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    const result = sendResult.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(result['stdoutTruncated']).toBe(true);
    expect(result['stderrTruncated']).toBe(true);
    expect(Buffer.byteLength(result['stdout'] as string, 'utf8')).toBeLessThanOrEqual(96 * 1024);
    expect(Buffer.byteLength(result['stderr'] as string, 'utf8')).toBeLessThanOrEqual(96 * 1024);
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 73, result }), 'utf8'))
      .toBeLessThan(256 * 1024);
  });

  it('returns non-zero exit details instead of converting them into an RPC failure', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: ['-e', 'process.stderr.write("expected failure"); process.exit(7)'],
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: 7,
      stdout: '',
      stderr: 'expected failure',
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
  });

  it('force-kills a child that handles SIGTERM and preserves timeout failure status', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();
    const startedAt = Date.now();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM",()=>setTimeout(()=>{process.stdout.write("late success");process.exit(0)},800));setInterval(()=>{},1000)',
      ],
      timeoutMs: 150,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: null,
      stdout: '',
    }));
    const result = sendResult.mock.calls[0]?.[1] as { durationMs: number };
    expect(result.durationMs).toBeLessThan(2_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('settles after timeout grace when a descendant holds inherited output pipes open', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();
    const startedAt = Date.now();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [
        '-e',
        'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),1000)"],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)',
      ],
      timeoutMs: 150,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: null,
    }));
    const result = sendResult.mock.calls[0]?.[1] as { durationMs: number };
    expect(result.durationMs).toBeLessThan(2_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('terminates a detached descendant instead of leaving it alive after timeout', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'aio-node-exec-tree-'));
    const descendantPidPath = join(fixtureDir, 'descendant.pid');
    const heartbeatPath = join(fixtureDir, 'descendant.heartbeat');
    const { dispatcher, sendError } = makeDispatcher();
    let descendantPid: number | undefined;

    try {
      await dispatcher.handleRpcRequest(request('node.exec', {
        executable: process.execPath,
        args: [
          '-e',
          'const {spawn}=require("node:child_process");const fs=require("node:fs");'
            + 'const child=spawn(process.execPath,["-e",'
            + '"const fs=require(\\"node:fs\\");let n=0;const p=process.argv[1];fs.writeFileSync(p,String(n));setInterval(()=>fs.writeFileSync(p,String(++n)),25)",'
            + 'process.argv[2]],{detached:true,stdio:"ignore"});'
            + 'fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000)',
          descendantPidPath,
          heartbeatPath,
        ],
        timeoutMs: 150,
      }, 'service'));

      descendantPid = Number.parseInt(await readFile(descendantPidPath, 'utf8'), 10);
      expect(sendError).not.toHaveBeenCalled();
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const heartbeatAfterTermination = await readFile(heartbeatPath, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readFile(heartbeatPath, 'utf8')).toBe(heartbeatAfterTermination);
    } finally {
      if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The process exited between the liveness check and cleanup.
        }
      }
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('terminates immediate-orphan detached inherited-pipe descendants in three trials', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'aio-node-exec-early-parent-exit-'));
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    try {
      for (let trial = 0; trial < 3; trial += 1) {
        const descendantPidPath = join(fixtureDir, `descendant-${trial}.pid`);
        const heartbeatPath = join(fixtureDir, `descendant-${trial}.heartbeat`);
        let descendantPid: number | undefined;
        try {
          await dispatcher.handleRpcRequest(request('node.exec', {
            executable: process.execPath,
            args: [
              '-e',
              'const {spawn}=require("node:child_process");const fs=require("node:fs");'
                + 'const child=spawn(process.execPath,["-e",'
                + '"const fs=require(\\"node:fs\\");let n=0;const p=process.argv[1];fs.writeFileSync(p,String(n));setInterval(()=>fs.writeFileSync(p,String(++n)),25)",'
                + 'process.argv[2]],{detached:true,stdio:["ignore","inherit","inherit"]});'
                + 'fs.writeFileSync(process.argv[1],String(child.pid));setTimeout(()=>process.exit(0),0)',
              descendantPidPath,
              heartbeatPath,
            ],
            timeoutMs: 300,
          }, 'service'));

          descendantPid = Number.parseInt(await readFile(descendantPidPath, 'utf8'), 10);
          expect(sendError).not.toHaveBeenCalled();
          expect(sendResult).toHaveBeenLastCalledWith(73, expect.objectContaining({ exitCode: null }));
          await new Promise((resolve) => setTimeout(resolve, 250));
          const heartbeatAfterTermination = await readFile(heartbeatPath, 'utf8');
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(await readFile(heartbeatPath, 'utf8')).toBe(heartbeatAfterTermination);
        } finally {
          if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
            try {
              process.kill(descendantPid, 'SIGKILL');
            } catch {
              // The process exited between the liveness check and cleanup.
            }
          }
        }
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('serializes and stops descendant sampling after an ordinary successful command', async () => {
    let activePsCalls = 0;
    let maxActivePsCalls = 0;
    let psCalls = 0;
    const execFileProcess = ((...values: unknown[]) => {
      const [file, args, options, callback] = values;
      if (file !== 'ps') {
        return (execFile as unknown as (...args: unknown[]) => unknown)(...values);
      }
      psCalls += 1;
      activePsCalls += 1;
      maxActivePsCalls = Math.max(maxActivePsCalls, activePsCalls);
      return (execFile as unknown as (...args: unknown[]) => unknown)(
        file,
        args,
        options,
        (error: Error | null, stdout: string, stderr: string) => {
          activePsCalls -= 1;
          (callback as (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void)(error, stdout, stderr);
        },
      );
    }) as unknown as typeof execFile;
    const executor = new WorkerNodeExecutor([process.cwd()], undefined, Date.now, {
      platform: process.platform,
      spawnProcess: spawn,
      execFileProcess,
      killProcess: (pid, signal) => process.kill(pid, signal),
    }, prepareUncheckedForLifecycleTest);
    const { dispatcher, sendResult, sendError } = makeDispatcher(
      undefined,
      [process.cwd()],
      (params) => executor.execute(params),
    );

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: ['-e', 'setTimeout(()=>process.stdout.write("ordinary success"),100)'],
      timeoutMs: 1_000,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: 0,
      stdout: 'ordinary success',
      stderr: '',
    }));
    expect(psCalls).toBeGreaterThan(0);
    expect(maxActivePsCalls).toBe(1);
    await waitForCondition(() => activePsCalls === 0);
    const callsAfterSettlement = psCalls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(psCalls).toBe(callsAfterSettlement);
  }, 10_000);

  it('does not direct-signal an exited root PID even when that PID is reused with the marker', async () => {
    const marker = 'a'.repeat(32);
    const rootPid = 41_001;
    const markerAssignment = `${NODE_EXEC_OWNERSHIP_MARKER_ENV}=${marker}`;
    const killProcess = vi.fn(() => true);
    const runtime = {
      execFileProcess: execFileReturning(`${rootPid} 1 ${rootPid} node ${markerAssignment}\n`),
      killProcess,
    };

    const result = await terminatePosixProcessTree({
      rootPid,
      rootExited: true,
      targets: [{ pid: rootPid, ppid: 1, pgid: rootPid, depth: 0 }],
    }, marker, 'SIGKILL', runtime);

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.identityProven).toBe(false);
    expect(result.failures.join('\n')).toContain('cleanupIncomplete');
  });

  it('does not signal a stale descendant PID or PGID without current marker identity', async () => {
    const marker = 'a'.repeat(32);
    const rootPid = 42_001;
    const descendantPid = 42_002;
    const killProcess = vi.fn(() => true);
    const runtime = {
      execFileProcess: execFileReturning(
        `${rootPid} 1 ${rootPid} node ${NODE_EXEC_OWNERSHIP_MARKER_ENV}=${marker}\n`
          + `${descendantPid} ${rootPid} ${rootPid} node ${NODE_EXEC_OWNERSHIP_MARKER_ENV}=${'b'.repeat(32)}\n`,
      ),
      killProcess,
    };

    const result = await terminatePosixProcessTree({
      rootPid,
      rootExited: false,
      targets: [
        { pid: rootPid, ppid: 1, pgid: rootPid, depth: 0 },
        { pid: descendantPid, ppid: rootPid, pgid: rootPid, depth: 1 },
      ],
    }, marker, 'SIGTERM', runtime);

    expect(killProcess).toHaveBeenCalledWith(rootPid, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(-rootPid, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(descendantPid, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(-descendantPid, 'SIGTERM');
    expect(result.failures.join('\n')).toContain('cleanupIncomplete');
  });

  it('caps the accumulated descendant union across seven 2,000-process samples', async () => {
    const rootPid = 50_001;
    let batch = 0;
    const execFileProcess = ((...values: unknown[]) => {
      const callback = values[3] as (error: Error | null, stdout: string, stderr: string) => void;
      const firstPid = 60_000 + (batch * 2_000);
      const descendants = Array.from({ length: 2_000 }, (_, index) => {
        const pid = firstPid + index;
        return `${pid} ${rootPid} ${pid}`;
      });
      batch += 1;
      queueMicrotask(() => callback(null, [`${rootPid} 1 ${rootPid}`, ...descendants].join('\n'), ''));
      return { unref: vi.fn() };
    }) as unknown as typeof execFile;
    const tracker = createPosixDescendantTracker(rootPid, {
      execFileProcess,
      killProcess: vi.fn(() => true),
    });
    tracker.pause();

    try {
      for (let sample = 0; sample < 7; sample += 1) await tracker.sample();
      const snapshot = tracker.snapshot();
      expect(batch).toBe(7);
      expect(snapshot.targets).toHaveLength(NODE_EXEC_MAX_TRACKED_PROCESSES);
      expect(snapshot.failure).toContain('cleanupIncomplete');
    } finally {
      tracker.dispose();
    }
  });

  it('falls back when Windows taskkill is unavailable and reports both cleanup failures', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'aio-node-exec-windows-cleanup-'));
    const childPidPath = join(fixtureDir, 'child.pid');
    const originalKill = process.kill.bind(process);
    const killProcess = vi.fn((pid: number, signal?: string | number) => originalKill(pid, signal));
    const taskkillCalls: { file: unknown; args: unknown }[] = [];
    let childPid: number | undefined;

    const execFileStub = ((...values: unknown[]) => {
      const [file, args, , callback] = values;
      taskkillCalls.push({ file, args });
      queueMicrotask(() => {
        const error = Object.assign(new Error('fixture taskkill unavailable'), { code: 'ENOENT' });
        (callback as (error: Error, stdout: string, stderr: string) => void)(error, '', '');
      });
      return { unref: vi.fn() };
    }) as unknown as typeof execFile;

    try {
      const executor = new WorkerNodeExecutor([process.cwd()], undefined, Date.now, {
        platform: 'win32',
        spawnProcess: spawn,
        execFileProcess: execFileStub,
        killProcess,
        resolveTrustedExecutable: resolveTrustedTaskkill,
      }, prepareUncheckedForLifecycleTest);
      const { dispatcher, sendResult, sendError } = makeDispatcher(
        undefined,
        [process.cwd()],
        (params) => executor.execute(params),
      );
      await dispatcher.handleRpcRequest(request('node.exec', {
        executable: process.execPath,
        args: [
          '-e',
          'process.stdout.write("o".repeat(150000));process.stderr.write("e".repeat(150000));'
            + 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));'
            + 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
          childPidPath,
        ],
        timeoutMs: 300,
      }, 'service'));

      childPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
      expect(sendError).not.toHaveBeenCalled();
      expect(taskkillCalls).toEqual([
        {
          file: 'C:\\Windows\\System32\\taskkill.exe',
          args: ['/PID', String(childPid), '/T'],
        },
        {
          file: 'C:\\Windows\\System32\\taskkill.exe',
          args: ['/PID', String(childPid), '/T', '/F'],
        },
      ]);
      expect(killProcess).toHaveBeenCalledWith(childPid, 'SIGTERM');
      expect(killProcess).toHaveBeenCalledWith(childPid, 'SIGKILL');
      const result = sendResult.mock.calls[0]?.[1] as {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
      };
      expect(result.exitCode).toBeNull();
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(96 * 1024);
      expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(96 * 1024);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      expect(result.stderr).toMatch(/^\[node\.exec cleanup: taskkill SIGTERM failed \(ENOENT\); direct-child fallback sent\]\n\[node\.exec cleanup: taskkill SIGKILL failed \(ENOENT\); direct-child fallback sent\]\n/u);
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) {
        try {
          originalKill(childPid, 'SIGKILL');
        } catch {
          // The process exited between the liveness check and cleanup.
        }
      }
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('bounds Windows taskkill callbacks that never settle before using fallback', async () => {
    const childPid = 43_001;
    const killProcess = vi.fn(() => true);
    const taskkillProcesses: { kill: ReturnType<typeof vi.fn> }[] = [];
    const spawnProcess = vi.fn(() => makeFakeChild(childPid)) as unknown as typeof spawn;

    const execFileStub = (() => {
      const processHandle = { kill: vi.fn(), unref: vi.fn() };
      taskkillProcesses.push(processHandle);
      return processHandle;
    }) as unknown as typeof execFile;

    const executor = new WorkerNodeExecutor([process.cwd()], undefined, Date.now, {
      platform: 'win32',
      spawnProcess,
      execFileProcess: execFileStub,
      killProcess,
      resolveTrustedExecutable: resolveTrustedTaskkill,
    }, prepareUncheckedForLifecycleTest);
    const { dispatcher, sendResult, sendError } = makeDispatcher(
      undefined,
      [process.cwd()],
      (params) => executor.execute(params),
    );
    const startedAt = Date.now();
    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [],
      timeoutMs: 50,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(1_200);
    expect(taskkillProcesses).toHaveLength(2);
    expect(taskkillProcesses[0]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(taskkillProcesses[1]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killProcess).toHaveBeenCalledWith(childPid, 'SIGTERM');
    expect(killProcess).toHaveBeenCalledWith(childPid, 'SIGKILL');
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: null,
      durationMs: expect.any(Number),
      stderr: '[node.exec cleanup: taskkill SIGTERM failed (TIMEOUT); direct-child fallback sent]\n'
        + '[node.exec cleanup: taskkill SIGKILL failed (TIMEOUT); direct-child fallback sent]',
    }));
    const result = sendResult.mock.calls[0]?.[1] as { durationMs: number };
    expect(result.durationMs).toBeLessThan(1_200);
  }, 10_000);

  it('does not signal a reused Windows root after it exits during TERM fallback', async () => {
    const childPid = 43_101;
    const child = makeFakeChild(childPid);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const taskkillArgs: string[][] = [];
    const execFileStub = ((...values: unknown[]) => {
      taskkillArgs.push(values[1] as string[]);
      const callback = values[3] as (error: Error, stdout: string, stderr: string) => void;
      queueMicrotask(() => {
        callback(Object.assign(new Error('fixture taskkill unavailable'), { code: 'ENOENT' }), '', '');
      });
      return { unref: vi.fn() };
    }) as unknown as typeof execFile;
    const killProcess = vi.fn((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') child.emit('exit', 0, 'SIGTERM');
      return true;
    });
    const executor = new WorkerNodeExecutor([process.cwd()], undefined, Date.now, {
      platform: 'win32',
      spawnProcess,
      execFileProcess: execFileStub,
      killProcess,
      resolveTrustedExecutable: resolveTrustedTaskkill,
    }, prepareUncheckedForLifecycleTest);
    const { dispatcher, sendResult, sendError } = makeDispatcher(
      undefined,
      [process.cwd()],
      (params) => executor.execute(params),
    );

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [],
      timeoutMs: 50,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    expect(taskkillArgs).toEqual([['/PID', String(childPid), '/T']]);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(childPid, 'SIGTERM');
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({
      exitCode: null,
      stderr: '[node.exec cleanup: taskkill SIGTERM failed (ENOENT); direct-child fallback sent]\n'
        + '[node.exec cleanupIncomplete: Windows root exited before SIGKILL; descendant ownership could not be proven]',
    }));
  }, 10_000);

  it('preserves truncation evidence when forced timeout capture overflows both streams', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write("o".repeat(150000));process.stderr.write("e".repeat(150000));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      ],
      timeoutMs: 150,
    }, 'service'));

    expect(sendError).not.toHaveBeenCalled();
    const result = sendResult.mock.calls[0]?.[1] as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    };
    expect(result.exitCode).toBeNull();
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(96 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(96 * 1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('rejects node.exec outside service scope before spawning', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: 'definitely-must-not-run',
      args: [],
    }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73,
      RPC_ERROR_CODES.UNAUTHORIZED,
      expect.stringContaining('scope=service'),
    );
  });

  it('rejects an out-of-allowlist cwd before spawning', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: [],
      cwd: '/outside-worker-allowlist',
    }, 'service'));

    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.any(String),
    );
  });

  it('rejects oversized argv before spawning', async () => {
    const { dispatcher, sendResult, sendError } = makeDispatcher();

    await dispatcher.handleRpcRequest(request('node.exec', {
      executable: process.execPath,
      args: ['x'.repeat(4_097)],
    }, 'service'));

    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.any(String),
    );
  });

  it('resolves cwd before enforcing the worker allowlist so symlinks cannot escape', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'aio-node-exec-'));
    const allowedRoot = join(parent, 'allowed');
    const outsideRoot = join(parent, 'outside');
    await mkdir(allowedRoot);
    await mkdir(outsideRoot);
    await symlink(outsideRoot, join(allowedRoot, 'escape'));
    const { dispatcher, sendResult, sendError } = makeDispatcher(undefined, [allowedRoot]);

    try {
      await dispatcher.handleRpcRequest(request('node.exec', {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: join(allowedRoot, 'escape'),
      }, 'service'));

      expect(sendResult).not.toHaveBeenCalled();
      expect(sendError).toHaveBeenCalledWith(
        73,
        RPC_ERROR_CODES.INVALID_PARAMS,
        expect.stringContaining('outside configured worker working directories'),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('WorkerRpcDispatcher browser.extension.recover', () => {
  it('requires service scope and delegates recovery without any browser dependency', async () => {
    const recoverExtensionRelay = vi.fn(async () => ({
      before: { enabled: true, running: true, lastExtensionContactAt: 100 },
      after: { enabled: true, running: true, lastExtensionContactAt: 100 },
    }));
    const { dispatcher, sendResult, sendError } = makeDispatcher(recoverExtensionRelay);

    await dispatcher.handleRpcRequest(request('browser.extension.recover', {}));
    expect(recoverExtensionRelay).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenLastCalledWith(
      73,
      RPC_ERROR_CODES.UNAUTHORIZED,
      expect.stringContaining('scope=service'),
    );

    sendError.mockClear();
    await dispatcher.handleRpcRequest(request('browser.extension.recover', {}, 'service'));

    expect(recoverExtensionRelay).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenLastCalledWith(73, {
      before: { enabled: true, running: true, lastExtensionContactAt: 100 },
      after: { enabled: true, running: true, lastExtensionContactAt: 100 },
    });
    expect(sendError).not.toHaveBeenCalled();
  });
});
