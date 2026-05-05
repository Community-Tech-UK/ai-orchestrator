import * as fsp from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { BrowserProfile } from '@contracts/types/browser';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import {
  BrowserProfileStore,
  getBrowserProfileStore,
} from './browser-profile-store';

export interface BrowserProcessRuntime {
  debugPort: number;
  debugEndpoint: string;
  processId?: number;
}

export interface BrowserProcessLauncherOptions {
  exists?: (candidate: string) => boolean | Promise<boolean>;
  allocatePort?: () => Promise<number>;
  createTempDir?: (prefix: string) => Promise<string>;
  removeDir?: (dir: string) => Promise<void>;
  profileStore?: Pick<BrowserProfileStore, 'setRuntimeState'>;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  env?: Record<string, string | undefined>;
}

export interface BrowserLaunchProfileOptions {
  profile: BrowserProfile;
  userDataDir: string;
  startUrl?: string;
}

const CHROME_COMMANDS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
];

async function defaultExists(candidate: string): Promise<boolean> {
  if (candidate.startsWith('/')) {
    try {
      await fsp.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    const child = execFile(
      'which',
      [candidate],
      {
        encoding: 'utf-8',
        timeout: 3000,
      },
      (error) => {
        resolve(!error);
      },
    );
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already exited
      }
      resolve(false);
    }, 3500);
  });
}

async function defaultCreateTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(prefix);
}

async function defaultRemoveDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function allocateLocalhostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate localhost port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export class BrowserProcessLauncher {
  private readonly exists: (candidate: string) => boolean | Promise<boolean>;
  private readonly allocatePort: () => Promise<number>;
  private readonly createTempDir: (prefix: string) => Promise<string>;
  private readonly removeDir: (dir: string) => Promise<void>;
  private readonly profileStore: Pick<BrowserProfileStore, 'setRuntimeState'>;
  private readonly env: Record<string, string | undefined>;
  private readonly running = new Map<string, Browser>();
  private readonly isolatedUserDataDirs = new Map<string, string>();

  constructor(options: BrowserProcessLauncherOptions = {}) {
    this.exists = options.exists ?? defaultExists;
    this.allocatePort = options.allocatePort ?? allocateLocalhostPort;
    this.createTempDir = options.createTempDir ?? defaultCreateTempDir;
    this.removeDir = options.removeDir ?? defaultRemoveDir;
    this.profileStore = options.profileStore ?? getBrowserProfileStore();
    this.env = options.env ?? process.env;
    const register = options.registerCleanup ?? registerGlobalCleanup;
    register(() => this.closeAll());
  }

  async launchProfile(options: BrowserLaunchProfileOptions): Promise<BrowserProcessRuntime> {
    if (this.running.has(options.profile.id)) {
      await this.closeProfile(options.profile.id);
    }

    const executablePath = await this.findChromeExecutable();
    const debugPort = await this.allocatePort();
    const userDataDir = await this.userDataDirForLaunch(options.profile, options.userDataDir);
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: false,
        userDataDir,
        defaultViewport: null,
        args: [
          '--remote-debugging-address=127.0.0.1',
          `--remote-debugging-port=${debugPort}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
        ],
      });

      this.running.set(options.profile.id, browser);

      if (options.startUrl) {
        const pages = await browser.pages();
        const page = pages[0] ?? (await browser.newPage());
        await page.goto(options.startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }

      const runtime: BrowserProcessRuntime = {
        debugPort,
        debugEndpoint: browser.wsEndpoint(),
        processId: browser.process()?.pid,
      };
      const now = Date.now();
      this.profileStore.setRuntimeState(options.profile.id, {
        status: 'running',
        debugPort: runtime.debugPort,
        debugEndpoint: runtime.debugEndpoint,
        processId: runtime.processId,
        lastLaunchedAt: now,
        lastUsedAt: now,
      });

      return runtime;
    } catch (error) {
      if (browser) {
        this.running.delete(options.profile.id);
        try {
          await browser.close();
        } catch {
          // Preserve the launch failure; process cleanup is best-effort here.
        }
        try {
          this.clearRuntimeState(options.profile.id);
        } catch {
          // Preserve the launch failure; runtime cleanup is best-effort here.
        }
      }
      if (!browser || this.isProfileLockError(error)) {
        try {
          this.markLaunchFailure(options.profile.id, error);
        } catch {
          // Preserve the launch failure; runtime cleanup is best-effort here.
        }
      }
      try {
        await this.cleanupIsolatedProfile(options.profile.id);
      } catch {
        // Preserve the launch failure; temporary profile cleanup is best-effort here.
      }
      throw error;
    }
  }

  getBrowser(profileId: string): Browser | null {
    return this.running.get(profileId) ?? null;
  }

  async closeProfile(profileId: string): Promise<void> {
    const browser = this.running.get(profileId);
    this.running.delete(profileId);
    try {
      if (browser) {
        await browser.close();
      }
    } finally {
      try {
        this.clearRuntimeState(profileId);
      } finally {
        await this.cleanupIsolatedProfile(profileId);
      }
    }
  }

  private async userDataDirForLaunch(
    profile: BrowserProfile,
    fallbackUserDataDir: string,
  ): Promise<string> {
    if (profile.mode !== 'isolated') {
      return fallbackUserDataDir;
    }

    const prefix = path.join(os.tmpdir(), `ai-orchestrator-browser-${profile.id}-`);
    const tempDir = await this.createTempDir(prefix);
    this.isolatedUserDataDirs.set(profile.id, tempDir);
    return tempDir;
  }

  private async cleanupIsolatedProfile(profileId: string): Promise<void> {
    const isolatedDir = this.isolatedUserDataDirs.get(profileId);
    if (!isolatedDir) {
      return;
    }
    this.isolatedUserDataDirs.delete(profileId);
    await this.removeDir(isolatedDir);
  }

  private clearRuntimeState(profileId: string): void {
    this.profileStore.setRuntimeState(profileId, {
      status: 'stopped',
      debugPort: undefined,
      debugEndpoint: undefined,
      processId: undefined,
    });
  }

  private markLaunchFailure(profileId: string, error: unknown): void {
    this.profileStore.setRuntimeState(profileId, {
      status: this.isProfileLockError(error) ? 'locked' : 'error',
      debugPort: undefined,
      debugEndpoint: undefined,
      processId: undefined,
    });
  }

  private isProfileLockError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /profile/i.test(message) && /(lock|locked|in use|another process)/i.test(message);
  }

  async closeAll(): Promise<void> {
    const profileIds = Array.from(this.running.keys());
    await Promise.all(profileIds.map((profileId) => this.closeProfile(profileId)));
  }

  private async findChromeExecutable(): Promise<string> {
    const envPath = this.env['PUPPETEER_EXECUTABLE_PATH'];
    if (envPath) {
      if (await this.exists(envPath)) {
        return envPath;
      }
      throw new Error(`Configured Chrome executable not found: ${envPath}`);
    }

    for (const command of CHROME_COMMANDS) {
      if (await this.exists(command)) {
        return command;
      }
    }
    throw new Error('Google Chrome not found for Browser Gateway');
  }
}
