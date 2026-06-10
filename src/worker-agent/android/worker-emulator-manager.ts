import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AndroidDeviceInfo } from '../../shared/types/worker-node.types';
import type { WorkerAndroidAutomationConfig } from '../worker-config';

interface WorkerEmulatorManagerOptions {
  config: WorkerAndroidAutomationConfig;
  spawnProcess?: typeof spawn;
  execFileProcess?: typeof execFile;
  bootTimeoutMs?: number;
  statePath?: string;
  killProcess?: (pid: number) => boolean;
  readProcessCommandLine?: (pid: number) => Promise<string>;
  canListenPort?: (port: number) => Promise<boolean>;
}

interface ManagedEmulator {
  avd: string;
  port: number;
  serial: string;
  child: ChildProcess;
}

interface PersistedManagedEmulator {
  avd: string;
  port: number;
  serial: string;
  pid: number;
}

const FIRST_EMULATOR_PORT = 5554;
const LAST_EMULATOR_PORT = 5584;
const POLL_INTERVAL_MS = 1_000;

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(`[WorkerEmulatorManager] ${message}`, extra ? JSON.stringify(extra) : '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export class WorkerEmulatorManager {
  private config: WorkerAndroidAutomationConfig;
  private readonly spawnProcess: typeof spawn;
  private readonly execFileProcess: typeof execFile;
  private bootTimeoutMs: number;
  private readonly statePath: string;
  private readonly killProcess: (pid: number) => boolean;
  private readonly readProcessCommandLine: (pid: number) => Promise<string>;
  private readonly canListenPort: (port: number) => Promise<boolean>;
  private readonly managed = new Map<string, ManagedEmulator>();
  private readonly starts = new Map<string, Promise<AndroidDeviceInfo>>();
  private stateMutationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkerEmulatorManagerOptions) {
    this.config = options.config;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.execFileProcess = options.execFileProcess ?? execFile;
    this.bootTimeoutMs = options.bootTimeoutMs ?? options.config.bootTimeoutMs ?? 180_000;
    this.statePath = options.statePath ?? defaultStatePath();
    this.killProcess = options.killProcess ?? ((pid) => process.kill(pid));
    this.readProcessCommandLine = options.readProcessCommandLine ?? readProcessCommandLine;
    this.canListenPort = options.canListenPort ?? canListen;
  }

  async ensureRunning(
    avd = this.config.defaultAvd,
    excludedSerials: ReadonlySet<string> = new Set(),
  ): Promise<AndroidDeviceInfo> {
    if (!this.config.enabled) {
      throw new Error('Android automation is not enabled on this worker');
    }
    if (!avd) {
      throw new Error('No Android AVD configured for emulator automation');
    }

    const existing = this.runningEntries().find((entry) =>
      entry.avd === avd && !excludedSerials.has(entry.serial)
    );
    if (existing) {
      return { serial: existing.serial, kind: 'emulator', state: 'device' };
    }

    const running = this.runningEntries();
    const maxEmulators = this.config.maxEmulators ?? 1;
    if (running.length >= maxEmulators) {
      const warm = running.find((entry) => !excludedSerials.has(entry.serial));
      if (warm) {
        return { serial: warm.serial, kind: 'emulator', state: 'device' };
      }
      throw new Error(`No unleased Android emulator is available within maxEmulators=${maxEmulators}`);
    }

    const startKey = startKeyFor(avd, excludedSerials);
    const existingStart = this.starts.get(startKey);
    if (existingStart) {
      return existingStart;
    }

    const start = this.launch(avd).finally(() => this.starts.delete(startKey));
    this.starts.set(startKey, start);
    return start;
  }

  async reconfigure(next: WorkerAndroidAutomationConfig): Promise<void> {
    const prev = this.config;
    this.config = next;
    this.bootTimeoutMs = next.bootTimeoutMs ?? 180_000;
    const launchRelevantChanged =
      prev.sdkPath !== next.sdkPath ||
      prev.defaultAvd !== next.defaultAvd ||
      prev.headlessEmulator !== next.headlessEmulator ||
      prev.maxEmulators !== next.maxEmulators ||
      prev.bootTimeoutMs !== next.bootTimeoutMs;

    if (prev.enabled && (!next.enabled || launchRelevantChanged)) {
      await this.shutdownAll();
    }
  }

  async shutdownAll(): Promise<void> {
    for (const entry of this.managed.values()) {
      try {
        entry.child.kill();
      } catch {
        /* already exited */
      }
    }
    this.managed.clear();
    this.starts.clear();
    await this.clearPersistedState();
  }

  async cleanupOwnedOrphans(): Promise<void> {
    const entries = await this.readPersistedState();
    if (entries.length === 0) {
      return;
    }

    const remaining: PersistedManagedEmulator[] = [];
    for (const entry of entries) {
      if (!(await this.isPersistedProcessStillOurs(entry))) {
        log('skipping stale emulator ownership record', {
          serial: entry.serial,
          port: entry.port,
          pid: entry.pid,
        });
        continue;
      }
      try {
        this.killProcess(entry.pid);
        log('cleaned up owned orphan emulator', {
          serial: entry.serial,
          port: entry.port,
          pid: entry.pid,
        });
      } catch (error) {
        remaining.push(entry);
        log('failed to clean up owned orphan emulator', {
          serial: entry.serial,
          port: entry.port,
          pid: entry.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const originalKeys = new Set(entries.map(persistedManagedEmulatorKey));
    const remainingKeys = new Set(remaining.map(persistedManagedEmulatorKey));
    await this.mutatePersistedState((current) =>
      current.filter((entry) => {
        const key = persistedManagedEmulatorKey(entry);
        return !originalKeys.has(key) || remainingKeys.has(key);
      })
    );
  }

  getRunningSerials(): string[] {
    return this.runningEntries().map((entry) => entry.serial);
  }

  private async launch(avd: string): Promise<AndroidDeviceInfo> {
    try {
      return await this.launchOnce(avd, false);
    } catch (error) {
      log('emulator boot failed; retrying with cold boot', {
        avd,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.launchOnce(avd, true);
    }
  }

  private async launchOnce(avd: string, coldBoot: boolean): Promise<AndroidDeviceInfo> {
    const port = await findFreeEmulatorPort(this.usedPorts(), this.canListenPort);
    const serial = `emulator-${port}`;
    const emulatorPath = this.resolveEmulatorPath();
    const args = [
      '-avd',
      avd,
      '-port',
      String(port),
      '-no-audio',
      '-no-boot-anim',
      ...(coldBoot ? ['-no-snapshot-load'] : []),
      ...(this.config.headlessEmulator !== false ? ['-no-window'] : []),
    ];

    log('launching emulator', {
      avd,
      port,
      headless: this.config.headlessEmulator !== false,
      coldBoot,
    });
    const child = this.spawnProcess(emulatorPath, args, {
      stdio: 'ignore',
      detached: false,
    });
    const managed: ManagedEmulator = { avd, port, serial, child };
    this.managed.set(serial, managed);
    await this.recordPersistedState(managed);
    child.on('exit', (code, signal) => {
      log('emulator exited', { avd, serial, code, signal });
      if (this.managed.get(serial)?.child === child) {
        this.managed.delete(serial);
      }
      void this.removePersistedState(serial, child.pid);
    });

    try {
      await this.waitForBoot(serial);
      log('emulator ready', { avd, serial });
      return { serial, kind: 'emulator', state: 'device' };
    } catch (error) {
      this.managed.delete(serial);
      await this.removePersistedState(serial, child.pid);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      throw error;
    }
  }

  private async waitForBoot(serial: string): Promise<void> {
    const deadline = Date.now() + this.bootTimeoutMs;
    await this.exec(['-s', serial, 'wait-for-device'], Math.min(remainingMs(deadline), 60_000));
    while (remainingMs(deadline) > 0) {
      const booted = (await this.exec(
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        Math.min(remainingMs(deadline), 5_000),
      )).trim();
      if (booted === '1') {
        return;
      }
      const pauseMs = Math.min(remainingMs(deadline), POLL_INTERVAL_MS);
      if (pauseMs > 0) {
        await delay(pauseMs);
      }
    }
    throw new Error(`Android emulator ${serial} did not finish booting within ${this.bootTimeoutMs}ms`);
  }

  private exec(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.execFileProcess(this.resolveAdbPath(), args, { timeout, windowsHide: true }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : String(stdout));
      });
    });
  }

  private resolveAdbPath(): string {
    return this.config.sdkPath
      ? path.join(this.config.sdkPath, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
      : 'adb';
  }

  private resolveEmulatorPath(): string {
    return this.config.sdkPath
      ? path.join(this.config.sdkPath, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator')
      : 'emulator';
  }

  private runningEntries(): ManagedEmulator[] {
    return [...this.managed.values()].filter((entry) => entry.child.exitCode === null);
  }

  private usedPorts(): ReadonlySet<number> {
    return new Set([...this.managed.values()].map((entry) => entry.port));
  }

  private async isPersistedProcessStillOurs(entry: PersistedManagedEmulator): Promise<boolean> {
    try {
      const commandLine = await this.readProcessCommandLine(entry.pid);
      return commandLineMatchesEntry(commandLine, entry);
    } catch {
      return false;
    }
  }

  private async recordPersistedState(entry: ManagedEmulator): Promise<void> {
    if (typeof entry.child.pid !== 'number') {
      return;
    }
    const pid = entry.child.pid;
    await this.mutatePersistedState((entries) => {
      const next = entries.filter((item) =>
        item.serial !== entry.serial && item.pid !== pid
      );
      next.push({
        avd: entry.avd,
        port: entry.port,
        serial: entry.serial,
        pid,
      });
      return next;
    });
  }

  private async removePersistedState(serial: string, pid: number | undefined): Promise<void> {
    await this.mutatePersistedState((entries) =>
      entries.filter((entry) =>
        entry.serial !== serial && (pid === undefined || entry.pid !== pid)
      )
    );
  }

  private async readPersistedState(): Promise<PersistedManagedEmulator[]> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
        return [];
      }
      return (parsed as { entries: unknown[] }).entries.filter(isPersistedManagedEmulator);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      log('failed to read emulator ownership state', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async writePersistedState(entries: PersistedManagedEmulator[]): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify({ entries }, null, 2), 'utf-8');
  }

  private async clearPersistedState(): Promise<void> {
    try {
      await fs.unlink(this.statePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        log('failed to clear emulator ownership state', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async replacePersistedState(entries: PersistedManagedEmulator[]): Promise<void> {
    if (entries.length === 0) {
      await this.clearPersistedState();
      return;
    }
    await this.writePersistedState(entries);
  }

  private async mutatePersistedState(
    update: (entries: PersistedManagedEmulator[]) => PersistedManagedEmulator[],
  ): Promise<void> {
    const run = this.stateMutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = update(await this.readPersistedState());
        await this.replacePersistedState(next);
      });
    this.stateMutationQueue = run.then(() => undefined, () => undefined);
    await run;
  }
}

async function findFreeEmulatorPort(
  usedPorts: ReadonlySet<number> = new Set(),
  canListenPort: (port: number) => Promise<boolean> = canListen,
): Promise<number> {
  for (let port = FIRST_EMULATOR_PORT; port <= LAST_EMULATOR_PORT; port += 2) {
    if (usedPorts.has(port)) {
      continue;
    }
    if (await canListenPort(port) && await canListenPort(port + 1)) {
      return port;
    }
  }
  throw new Error(`No free Android emulator console port in ${FIRST_EMULATOR_PORT}-${LAST_EMULATOR_PORT}`);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function startKeyFor(avd: string, excludedSerials: ReadonlySet<string>): string {
  return `${avd}\0${[...excludedSerials].sort().join(',')}`;
}

function defaultStatePath(): string {
  return path.join(os.homedir(), '.orchestrator', 'worker-android-emulators.json');
}

function readProcessCommandLine(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CommandLine }`;
    return execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], 5_000);
  }
  return execFileText('ps', ['-p', String(pid), '-o', 'command='], 5_000);
}

function execFileText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : String(stdout));
    });
  });
}

function commandLineMatchesEntry(commandLine: string, entry: PersistedManagedEmulator): boolean {
  const normalized = commandLine.replace(/\s+/g, ' ').toLowerCase();
  const avd = entry.avd.toLowerCase();
  const hasEmulatorBinary = normalized.includes('emulator') || normalized.includes('qemu-system');
  const hasPort = hasOptionValue(normalized, 'port', String(entry.port));
  const hasAvd = hasOptionValue(normalized, 'avd', avd);
  return hasEmulatorBinary && hasPort && hasAvd;
}

function persistedManagedEmulatorKey(entry: PersistedManagedEmulator): string {
  return `${entry.serial}\0${entry.pid}`;
}

function hasOptionValue(commandLine: string, option: string, value: string): boolean {
  return new RegExp(`(?:^|\\s)-${option}(?:\\s+|=)${escapeRegExp(value)}(?:\\s|$)`).test(commandLine);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPersistedManagedEmulator(value: unknown): value is PersistedManagedEmulator {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PersistedManagedEmulator>;
  return (
    typeof candidate.avd === 'string' &&
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    typeof candidate.serial === 'string' &&
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
