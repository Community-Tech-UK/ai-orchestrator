import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { workerBrowserExtensionFolder } from './browser-extension-folder';
import { isDefaultWorkerHome } from './worker-home';
import {
  EXTENSION_TEST_RELOAD_WAIT_MS,
  ExtensionTestRefusal,
  assertTestManifestAllowed,
  decodeExtensionTestBundle,
  isSafeExtensionFileName,
  parseExtensionManifest,
  type BrowserExtensionTestParams,
  type BrowserExtensionTestResult,
} from '../main/remote-node/extension-test-install-rpc';

const STATE_FILE = 'state.json';
const ORIGINAL_DIR = 'original';
const TEMP_SUFFIX = '.aio-tmp';
const POLL_MS = 1_000;
const RESTORE_RETRY_MS = 60_000;

interface Lease {
  leaseId: string;
  ownerId: string;
  testVersion: string;
  originalVersion: string;
  expiresAt: number;
  /** Top-level files the folder held before the install; everything else is removed on restore. */
  originalFiles: string[];
  /** Access and modification times (ms) of each original file, put back on restore so the folder looks untouched. */
  originalTimes?: Record<string, { atimeMs: number; mtimeMs: number }>;
}

export interface WorkerExtensionTestInstallDeps {
  /** The unpacked extension folder Chrome loads, or undefined when this worker has none it owns. */
  folder: string | undefined;
  /** Lease records and the byte-for-byte backup live here, outside the checkout. */
  stateRoot: string;
  relay: {
    /** What the worker tells an idle extension to reload onto. */
    setExpectedExtensionVersion(version: string): void;
    getSummary(): { extensionVersion?: string } | undefined;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  reloadWaitMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Installs a branch's extension build into the folder Chrome loads, for one leased test
 * run, and puts the original back afterwards. Reload reuses the existing
 * worker-tells-extension-its-version path; the extension itself is not modified.
 * Operations are serialised so an expiry restore cannot interleave with an install.
 */
export class WorkerExtensionTestInstall {
  private lease: Lease | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reloadWaitMs: number;
  private readonly logger: Pick<Console, 'info' | 'warn'>;

  constructor(private readonly deps: WorkerExtensionTestInstallDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.reloadWaitMs = deps.reloadWaitMs ?? EXTENSION_TEST_RELOAD_WAIT_MS;
    this.logger = deps.logger ?? console;
  }

  /** True while a test build is installed; the self-updater must not touch the folder then. */
  isActive(): boolean {
    return this.lease !== null;
  }

  handle(params: BrowserExtensionTestParams): Promise<BrowserExtensionTestResult> {
    const run = this.chain.then(() => this.dispatch(params));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Worker start: a lease left by a previous process is restored at once; nothing survives a restart. */
  recoverOnStart(): Promise<void> {
    const run = this.chain.then(async () => {
      const lease = await this.readLease();
      if (!lease) return;
      this.logger.warn('[ExtensionTestInstall] Restoring the extension left by a previous worker run');
      this.lease = lease;
      await this.restoreFiles(false);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async dispatch(params: BrowserExtensionTestParams): Promise<BrowserExtensionTestResult> {
    if (!this.deps.folder) {
      throw new ExtensionTestRefusal('no_extension_folder', 'This worker has no unpacked extension folder it owns');
    }
    switch (params.action) {
      case 'restore': {
        if (!this.lease) return { state: 'idle', restored: false };
        if (this.lease.ownerId !== params.ownerId && this.now() < this.lease.expiresAt) {
          throw new ExtensionTestRefusal('not_lease_owner', 'The test extension belongs to another session until its lease ends');
        }
        const reloadObserved = await this.restoreFiles(true);
        return { state: 'idle', restored: true, reloadObserved };
      }
      case 'install':
        return this.install(params);
    }
  }

  private async install(params: Extract<BrowserExtensionTestParams, { action: 'install' }>): Promise<BrowserExtensionTestResult> {
    const folder = this.deps.folder!;
    if (this.lease) {
      if (this.now() < this.lease.expiresAt) {
        throw new ExtensionTestRefusal('lease_active', 'A test extension is already installed here; restore it first');
      }
      await this.restoreFiles(true);
    }
    const bundle = decodeExtensionTestBundle(params.files);
    const manifestFile = bundle.find((file) => file.name === 'manifest.json')!;
    const installed = parseExtensionManifest(await fs.readFile(path.join(folder, 'manifest.json')));
    const { testVersion, originalVersion } = assertTestManifestAllowed(parseExtensionManifest(manifestFile.content), installed);

    const { names: originalFiles, times: originalTimes } = await this.backUpFolder();
    const lease: Lease = {
      leaseId: randomUUID(),
      ownerId: params.ownerId,
      testVersion,
      originalVersion,
      expiresAt: this.now() + params.ttlMs,
      originalFiles,
      originalTimes,
    };
    await this.writeLease(lease);
    this.lease = lease;
    try {
      await this.replaceFolder(bundle.map((file) => file.name), bundle);
    } catch (error) {
      await this.restoreFiles(false);
      throw error;
    }
    this.deps.relay.setExpectedExtensionVersion(testVersion);
    this.armExpiry(lease);
    const reloadObserved = await this.waitForVersion(testVersion);
    return { ...this.summary(), reloadObserved };
  }

  private summary(): BrowserExtensionTestResult {
    const running = this.deps.relay.getSummary()?.extensionVersion;
    if (!this.lease) return { state: 'idle', ...(running ? { runningExtensionVersion: running } : {}) };
    return {
      state: 'active',
      leaseId: this.lease.leaseId,
      ownerId: this.lease.ownerId,
      testVersion: this.lease.testVersion,
      originalVersion: this.lease.originalVersion,
      expiresAt: this.lease.expiresAt,
      ...(running ? { runningExtensionVersion: running } : {}),
    };
  }

  private armExpiry(lease: Lease): void {
    this.dispose();
    const timer = setTimeout(() => {
      this.timer = null;
      const run = this.chain.then(async () => {
        if (this.lease?.leaseId !== lease.leaseId) return;
        this.logger.info('[ExtensionTestInstall] Lease ended; restoring the original extension');
        await this.restoreFiles(false);
      });
      this.chain = run.catch((error) => {
        this.logger.warn('[ExtensionTestInstall] Lease-end restore failed; retrying in one minute', error);
        if (this.lease?.leaseId === lease.leaseId) {
          this.lease.expiresAt = this.now() + RESTORE_RETRY_MS;
          this.armExpiry(this.lease);
        }
      });
    }, Math.max(0, lease.expiresAt - this.now()));
    timer.unref?.();
    this.timer = timer;
  }

  /** Puts the originals back, tells the extension to reload onto them, then forgets the lease. */
  private async restoreFiles(waitForReload: boolean): Promise<boolean> {
    const lease = this.lease!;
    const folder = this.deps.folder!;
    this.dispose();
    const originalDir = path.join(this.deps.stateRoot, ORIGINAL_DIR);
    const originals = lease.originalFiles.filter(isSafeExtensionFileName);
    const content = await Promise.all(originals.map(async (name) => ({ name, content: await fs.readFile(path.join(originalDir, name)) })));
    await this.replaceFolder(originals, content);
    for (const name of originals) {
      const times = lease.originalTimes?.[name];
      if (times) await fs.utimes(path.join(folder, name), times.atimeMs / 1000, times.mtimeMs / 1000);
    }
    this.deps.relay.setExpectedExtensionVersion(lease.originalVersion);
    this.lease = null;
    const reloadObserved = waitForReload ? await this.waitForVersion(lease.originalVersion) : false;
    await fs.rm(this.deps.stateRoot, { recursive: true, force: true });
    this.logger.info(`[ExtensionTestInstall] Restored ${folder} to ${lease.originalVersion}`);
    return reloadObserved;
  }

  /** Makes the folder hold exactly `keep`: writes each file, then removes any other top-level file. */
  private async replaceFolder(keep: string[], files: ReadonlyArray<{ name: string; content: Buffer }>): Promise<void> {
    const folder = this.deps.folder!;
    for (const file of files) {
      const target = path.join(folder, file.name);
      const temp = `${target}${TEMP_SUFFIX}`;
      // Never write through a link: clear any leftover at the temp path (rm removes a link itself), create it
      // exclusively, and let rename replace whatever sits at the target rather than follow it.
      await fs.rm(temp, { force: true });
      await fs.writeFile(temp, file.content, { flag: 'wx' });
      await fs.rename(temp, target);
    }
    const wanted = new Set(keep);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      // Only extension files and this class's own temporary files; anything else (a Finder .DS_Store) is left alone.
      const ours = isSafeExtensionFileName(entry.name) || entry.name.endsWith(TEMP_SUFFIX);
      // A link that appeared during the lease is removed as a link (rm never follows it), not left in the folder.
      if ((entry.isFile() || entry.isSymbolicLink()) && ours && !wanted.has(entry.name)) await fs.rm(path.join(folder, entry.name), { force: true });
    }
  }

  private async backUpFolder(): Promise<{ names: string[]; times: NonNullable<Lease['originalTimes']> }> {
    const folder = this.deps.folder!;
    const originalDir = path.join(this.deps.stateRoot, ORIGINAL_DIR);
    await fs.rm(this.deps.stateRoot, { recursive: true, force: true });
    await fs.mkdir(originalDir, { recursive: true });
    const names: string[] = [];
    const times: NonNullable<Lease['originalTimes']> = {};
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!isSafeExtensionFileName(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        throw new ExtensionTestRefusal('folder_has_link', `The extension folder holds a symbolic link (${entry.name}); a test build is not installed over it`);
      }
      if (!entry.isFile()) continue;
      const source = path.join(folder, entry.name);
      const { atimeMs, mtimeMs } = await fs.stat(source);
      await fs.copyFile(source, path.join(originalDir, entry.name));
      names.push(entry.name);
      times[entry.name] = { atimeMs, mtimeMs };
    }
    return { names, times };
  }

  private async writeLease(lease: Lease): Promise<void> {
    const file = path.join(this.deps.stateRoot, STATE_FILE);
    await fs.writeFile(`${file}${TEMP_SUFFIX}`, JSON.stringify(lease));
    await fs.rename(`${file}${TEMP_SUFFIX}`, file);
  }

  private async readLease(): Promise<Lease | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.deps.stateRoot, STATE_FILE), 'utf-8')) as Partial<Lease>;
      if (
        typeof parsed.leaseId !== 'string' || typeof parsed.originalVersion !== 'string'
        || !Array.isArray(parsed.originalFiles) || !parsed.originalFiles.every((name) => typeof name === 'string')
      ) {
        throw new Error('The extension test lease record is damaged; restore the extension folder from git');
      }
      return parsed as Lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async waitForVersion(version: string): Promise<boolean> {
    const deadline = this.now() + this.reloadWaitMs;
    for (;;) {
      if (this.deps.relay.getSummary()?.extensionVersion === version) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }
}

/** The worker's instance: leaves a lease from a previous run restored before anything else can use the folder. */
export function createWorkerExtensionTestInstall(
  workerHome: string,
  relay: WorkerExtensionTestInstallDeps['relay'],
): WorkerExtensionTestInstall {
  const install = new WorkerExtensionTestInstall({
    // Only the default worker home owns the unpacked extension (see WorkerExtensionRelay `ownsExtension`).
    folder: isDefaultWorkerHome(workerHome) ? workerBrowserExtensionFolder() : undefined,
    stateRoot: path.join(workerHome, 'extension-test-install'),
    relay,
  });
  install.recoverOnStart().catch((error) => {
    console.warn('[WorkerAgent] Restoring a leftover test extension failed', error instanceof Error ? error.message : String(error));
  });
  return install;
}
