import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProfile } from '@contracts/types/browser';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('puppeteer-core', () => ({
  default: {
    launch: mocks.launch,
  },
}));

import { BrowserProcessLauncher } from './browser-process-launcher';

function makeProfile(): BrowserProfile {
  return {
    id: 'profile-1',
    label: 'Local Test',
    mode: 'session',
    browser: 'chrome',
    userDataDir: '/tmp/browser-profile',
    allowedOrigins: [],
    status: 'stopped',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeIsolatedProfile(): BrowserProfile {
  return {
    ...makeProfile(),
    id: 'isolated-profile',
    mode: 'isolated',
    userDataDir: '/tmp/persistent-placeholder',
  };
}

describe('BrowserProcessLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches Google Chrome with a managed profile, loopback debug port, and default URL', async () => {
    const goto = vi.fn();
    const close = vi.fn();
    mocks.launch.mockResolvedValue({
      wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/test',
      process: () => ({ pid: 12345 }),
      pages: async () => [{ goto }],
      newPage: vi.fn(),
      close,
    });
    const runtimePatches: unknown[] = [];
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) =>
        candidate === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: (_id, patch) => {
          runtimePatches.push(patch);
          return makeProfile();
        },
      },
      registerCleanup: vi.fn(),
      env: {},
    });

    const runtime = await launcher.launchProfile({
      profile: makeProfile(),
      userDataDir: '/tmp/browser-profile',
      startUrl: 'http://localhost:4567',
    });

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: false,
        userDataDir: '/tmp/browser-profile',
        defaultViewport: null,
        args: expect.arrayContaining([
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=45678',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
        ]),
      }),
    );
    expect(goto).toHaveBeenCalledWith('http://localhost:4567', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(runtime).toMatchObject({
      debugPort: 45678,
      debugEndpoint: 'ws://127.0.0.1:45678/devtools/browser/test',
      processId: 12345,
    });
    expect(runtimePatches[0]).toMatchObject({
      status: 'running',
      debugPort: 45678,
      debugEndpoint: 'ws://127.0.0.1:45678/devtools/browser/test',
      processId: 12345,
    });
  });

  it('uses PUPPETEER_EXECUTABLE_PATH before searching known Chrome commands', async () => {
    mocks.launch.mockResolvedValue({
      wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/test',
      process: () => null,
      pages: async () => [],
      newPage: async () => ({ goto: vi.fn() }),
      close: vi.fn(),
    });
    const checked: string[] = [];
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => {
        checked.push(candidate);
        return candidate === '/custom/chrome';
      },
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: () => makeProfile(),
      },
      env: {
        PUPPETEER_EXECUTABLE_PATH: '/custom/chrome',
      },
    });

    await launcher.launchProfile({
      profile: makeProfile(),
      userDataDir: '/tmp/browser-profile',
    });

    expect(checked).toEqual(['/custom/chrome']);
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/custom/chrome' }),
    );
  });

  it('ignores Edge-only machines while the schema is chrome-only', async () => {
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => candidate === 'microsoft-edge',
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: () => makeProfile(),
      },
      env: {},
    });

    await expect(
      launcher.launchProfile({
        profile: makeProfile(),
        userDataDir: '/tmp/browser-profile',
      }),
    ).rejects.toThrow(/Google Chrome not found/);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('closes Chrome and clears runtime debug state before restart', async () => {
    const close = vi.fn();
    mocks.launch.mockResolvedValue({
      wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/test',
      process: () => ({ pid: 12345 }),
      pages: async () => [],
      newPage: vi.fn(),
      close,
    });
    const runtimePatches: unknown[] = [];
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => candidate === 'chrome',
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: (_id, patch) => {
          runtimePatches.push(patch);
          return makeProfile();
        },
      },
      env: {},
    });

    await launcher.launchProfile({
      profile: makeProfile(),
      userDataDir: '/tmp/browser-profile',
    });
    await launcher.closeProfile('profile-1');

    expect(close).toHaveBeenCalled();
    expect(runtimePatches.at(-1)).toEqual({
      status: 'stopped',
      debugPort: undefined,
      debugEndpoint: undefined,
      processId: undefined,
    });
  });

  it('closes an existing browser before relaunching the same profile', async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    mocks.launch
      .mockResolvedValueOnce({
        wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/first',
        process: () => ({ pid: 111 }),
        pages: async () => [],
        newPage: vi.fn(),
        close: firstClose,
      })
      .mockResolvedValueOnce({
        wsEndpoint: () => 'ws://127.0.0.1:45679/devtools/browser/second',
        process: () => ({ pid: 222 }),
        pages: async () => [],
        newPage: vi.fn(),
        close: secondClose,
      });
    const runtimePatches: unknown[] = [];
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => candidate === 'chrome',
      allocatePort: vi.fn().mockResolvedValueOnce(45678).mockResolvedValueOnce(45679),
      profileStore: {
        setRuntimeState: (_id, patch) => {
          runtimePatches.push(patch);
          return makeProfile();
        },
      },
      env: {},
    });

    await launcher.launchProfile({
      profile: makeProfile(),
      userDataDir: '/tmp/browser-profile',
    });
    await launcher.launchProfile({
      profile: makeProfile(),
      userDataDir: '/tmp/browser-profile',
    });

    expect(firstClose).toHaveBeenCalled();
    expect(launcher.getBrowser('profile-1')).toBeTruthy();
    expect(runtimePatches).toEqual(
      expect.arrayContaining([
        {
          status: 'stopped',
          debugPort: undefined,
          debugEndpoint: undefined,
          processId: undefined,
        },
        expect.objectContaining({
          status: 'running',
          debugPort: 45679,
          debugEndpoint: 'ws://127.0.0.1:45679/devtools/browser/second',
          processId: 222,
        }),
      ]),
    );
  });

  it('closes Chrome and clears runtime state when default URL navigation fails', async () => {
    const close = vi.fn();
    const goto = vi.fn().mockRejectedValue(new Error('start URL failed'));
    mocks.launch.mockResolvedValue({
      wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/test',
      process: () => ({ pid: 12345 }),
      pages: async () => [{ goto }],
      newPage: vi.fn(),
      close,
    });
    const runtimePatches: unknown[] = [];
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => candidate === 'chrome',
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: (_id, patch) => {
          runtimePatches.push(patch);
          return makeProfile();
        },
      },
      env: {},
    });

    await expect(
      launcher.launchProfile({
        profile: makeProfile(),
        userDataDir: '/tmp/browser-profile',
        startUrl: 'http://localhost:4567',
      }),
    ).rejects.toThrow(/start URL failed/);

    expect(close).toHaveBeenCalled();
    expect(launcher.getBrowser('profile-1')).toBeNull();
    expect(runtimePatches.at(-1)).toEqual({
      status: 'stopped',
      debugPort: undefined,
      debugEndpoint: undefined,
      processId: undefined,
    });
  });

  it('uses a disposable user data dir for isolated profiles and removes it on close', async () => {
    const close = vi.fn();
    mocks.launch.mockResolvedValue({
      wsEndpoint: () => 'ws://127.0.0.1:45678/devtools/browser/test',
      process: () => ({ pid: 12345 }),
      pages: async () => [],
      newPage: vi.fn(),
      close,
    });
    const removeDir = vi.fn(async () => undefined);
    const launcher = new BrowserProcessLauncher({
      exists: async (candidate) => candidate === 'chrome',
      allocatePort: async () => 45678,
      profileStore: {
        setRuntimeState: () => makeIsolatedProfile(),
      },
      createTempDir: vi.fn(async () => '/tmp/browser-gateway-isolated-abc123'),
      removeDir,
      env: {},
    });

    await launcher.launchProfile({
      profile: makeIsolatedProfile(),
      userDataDir: '/tmp/persistent-placeholder',
    });
    await launcher.closeProfile('isolated-profile');

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataDir: '/tmp/browser-gateway-isolated-abc123',
      }),
    );
    expect(removeDir).toHaveBeenCalledWith('/tmp/browser-gateway-isolated-abc123');
  });
});
