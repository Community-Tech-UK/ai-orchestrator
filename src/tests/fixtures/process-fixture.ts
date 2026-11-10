import { spawn, ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** ESRCH proves absence; permission errors must not masquerade as death. */
export function isFixtureProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Invalid fixture PID: ${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * A PID receipt names exactly one process or names nothing. A writer killed
 * between creating and filling its receipt leaves empty or partial content;
 * parsing that as a PID (`Number('')` is 0) must not fail cleanup or an exit
 * assertion with `Invalid fixture PID` — the receipt cannot name a process to
 * wait on or kill, and failing the test would kill nothing.
 */
function parsePidReceipt(content: string): number | null {
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
  return pid;
}

async function waitForFixtureExit(pid: number, isAlive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive()) {
    if (Date.now() >= deadline) throw new Error(`Fixture process ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function waitForFixtureProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  return waitForFixtureExit(pid, () => isFixtureProcessAlive(pid), timeoutMs);
}

function waitForCapturedChildExit(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  return waitForFixtureExit(pid, () => (
    child.exitCode === null && child.signalCode === null && isFixtureProcessAlive(pid)
  ), 2_000);
}

/**
 * Fixture source: one statement that ends the fixture once process `pid` (by default the test process building
 * the source) is gone. A fixture that ignores signals or idles on a timer is normally stopped by the code under
 * test or by `cleanup()`; when a test worker is killed mid-run neither happens, and the child would idle for ever.
 * Run this on the fixture's own interval. While the test process is alive it does nothing, so what a test proves
 * (signals ignored, survivors, escalation) is unchanged. As in `isFixtureProcessAlive`, only ESRCH means gone.
 * The source uses single quotes only, so it fits inside a double-quoted nested `-e` string.
 */
export function exitOnceProcessGone(pid = process.pid): string {
  return `try{process.kill(${pid},0)}catch(e){if(e.code==='ESRCH')process.exit()}`;
}

/** Keeps a fixture alive until it is stopped, or until the test process that started it is gone. */
export const IDLE_UNTIL_TEST_PROCESS_GONE = `setInterval(()=>{${exitOnceProcessGone()}},1000)`;

/** Register before awaiting product execution so assertion/error paths cannot leak fixtures. */
export class ProcessFixtureRegistry {
  private readonly children = new Set<ChildProcess>();
  private readonly pidFiles = new Set<string>();

  readonly spawn: typeof spawn = ((...args: Parameters<typeof spawn>) => (
    this.track(spawn(...args))
  )) as typeof spawn;

  track<T extends ChildProcess>(child: T): T {
    this.children.add(child);
    return child;
  }

  trackPidFile(path: string): void {
    this.pidFiles.add(path);
  }

  /** Assert product cleanup before the safety net runs; never kills a process. */
  async waitForExit(): Promise<void> {
    const capturedRootPids = new Set<number>();
    for (const child of this.children) {
      if (child.pid) capturedRootPids.add(child.pid);
      await waitForCapturedChildExit(child);
    }
    for (const path of this.pidFiles) {
      const pid = parsePidReceipt(await readFile(path, 'utf8'));
      if (pid === null || capturedRootPids.has(pid)) continue;
      await waitForFixtureProcessExit(pid);
    }
  }

  async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    const capturedRootPids = new Set<number>();
    // Stop roots before reading descendant PID files: no root can create a late child.
    for (const child of this.children) {
      if (child.pid) capturedRootPids.add(child.pid);
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForCapturedChildExit(child);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    for (const path of this.pidFiles) {
      try {
        const pid = parsePidReceipt(await readFile(path, 'utf8'));
        // Receipts record a historical launch. Never let one override a
        // captured root's exit state or retry a root outside its live handle.
        if (pid === null || capturedRootPids.has(pid)) continue;
        if (isFixtureProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL');
          await waitForFixtureProcessExit(pid);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          && (error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error);
      }
    }
    this.children.clear();
    this.pidFiles.clear();
    if (failures.length) throw new AggregateError(failures, 'Fixture process cleanup failed');
  }
}

/**
 * Capture real launches even when product code already bound a builtin spawn or
 * execFile export. Export mocks miss those paths; both use this native method.
 * Install per test and restore after registry cleanup. Execution is unchanged.
 */
export function captureFixtureSpawns(
  registry: ProcessFixtureRegistry,
  onSpawn?: (child: ChildProcess) => void,
): () => void {
  // Node's internal spawn method exists at runtime but is not in @types/node.
  const prototype = ChildProcess.prototype as unknown as {
    spawn(this: ChildProcess, options: unknown): number;
  };
  const original = prototype.spawn;
  const capture = function(this: ChildProcess, options: unknown): number {
    registry.track(this);
    onSpawn?.(this);
    return original.call(this, options);
  };
  prototype.spawn = capture;
  let restored = false;
  return () => {
    if (restored) return;
    if (prototype.spawn !== capture) throw new Error('Fixture spawn capture was replaced before restoration');
    prototype.spawn = original;
    restored = true;
  };
}
