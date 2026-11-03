import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the real entrypoint while isolating Electron and unrelated services.
// No native window, worker, provider or real user-data directory is opened.
async function start(failure: unknown, critical = true) {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const showErrorBox = vi.fn();
  const quit = vi.fn();
  const createMainWindow = vi.fn().mockResolvedValue(undefined);
  const step = vi.fn(() => { if (failure) throw failure; });
  let startup: Promise<void> | undefined;
  const app = {
    isPackaged: false,
    getPath: () => '/unused-startup-fixture',
    setPath: vi.fn(), setName: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: () => true,
    on: (event: string, fn: (...args: unknown[]) => unknown) => events.set(event, fn),
    whenReady: () => ({ then: (fn: () => Promise<void>) => {
      startup = Promise.resolve().then(fn);
      return { catch: (handler: (error: unknown) => void) => {
        startup = startup!.catch(handler);
        return startup;
      } };
    } }),
    quit,
  };
  const modules: Record<string, unknown> = {
    electron: { app, BrowserWindow: { getAllWindows: () => [] }, dialog: { showErrorBox } },
    fs: { mkdirSync: vi.fn(), appendFileSync: vi.fn() },
    path: createRequire(import.meta.url)('node:path'),
    './register-aliases': {},
    './window-manager': { WindowManager: class { createMainWindow = createMainWindow; } },
    './instance/instance-manager': { InstanceManager: class {} },
    './instance/context-worker-client': { getContextWorkerClient: () => ({ signalAppReady: vi.fn() }) },
    './logging/logger': { getLogger: () => logger },
    './providers/provider-adapter-registry': { providerAdapterRegistry: {} },
    './providers/register-built-in-providers': { registerBuiltInProviders: vi.fn() },
    './app/shutdown-forensics': { installShutdownSignalProbes: vi.fn() },
    './app/user-data-path': { resolveHarnessUserDataPath: () => '/unused-startup-fixture' },
    './process/harness-shutdown-operations': { createHarnessShutdownOperations: () => ({}) },
    './app/stateless-exec-provider': { createStatelessExecProviderPredicate: vi.fn() },
    './app/initialization-steps': {
      createInitializationSteps: () => [{ name: 'Work controls', critical, fn: step }],
      createWindowAndStartEvidenceMaintenance: async (create: () => Promise<void>, ready: () => void) => {
        await create(); ready();
      },
    },
    './app/startup-smoke-markers': { getStartupSmokeDirectory: () => null },
    './app/build-skew-watcher': { startBuildSkewWatcher: vi.fn() },
  };
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    require: (name: string) => {
      // Other imports only supply callbacks for shutdown or unused runtime paths.
      if (!(name in modules)) return {};
      return modules[name];
    },
    exports: {}, __dirname: '/unused-startup-fixture',
    process: { platform: 'linux', env: {}, argv: [], on: vi.fn() },
    setImmediate, Error,
  });
  // Attaching immediately also captures the old unhandled startup rejection.
  let rejected: unknown;
  await startup!.catch((error: unknown) => { rejected = error; });
  await Promise.resolve();
  return { events, logger, showErrorBox, quit, createMainWindow, step, rejected };
}

describe('application initialization failure', () => {
  it('explains critical startup failure before quitting, keeping diagnosis in the log', async () => {
    const failure = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const result = await start(failure);
    expect(result.showErrorBox).toHaveBeenCalledOnce();
    expect(result.showErrorBox).toHaveBeenCalledWith('Harness could not start', expect.stringContaining('Try opening Harness again'));
    expect(result.showErrorBox.mock.calls.flat().join(' ')).not.toMatch(/SQLITE|database is locked/);
    expect(result.logger.error).toHaveBeenCalledWith('Harness startup failed', failure);
    expect(result.quit).toHaveBeenCalledOnce();
    expect(result.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(result.quit.mock.invocationCallOrder[0]!);
    expect(result.createMainWindow).not.toHaveBeenCalled();
    expect(result.rejected).toBeUndefined();
  });

  it('continues after a noncritical failure without displaying a fatal error', async () => {
    const result = await start(new Error('optional service failed'), false);
    expect(result.createMainWindow).toHaveBeenCalledOnce();
    expect(result.showErrorBox).not.toHaveBeenCalled();
    expect(result.quit).not.toHaveBeenCalled();
    expect(result.rejected).toBeUndefined();
  });

  it('handles window recreation failure through the same visible failure path', async () => {
    const result = await start(undefined);
    result.createMainWindow.mockRejectedValueOnce(new Error('window load failed'));
    await result.events.get('activate')!();
    expect(result.showErrorBox).toHaveBeenCalledOnce();
    expect(result.quit).toHaveBeenCalledOnce();
  });
});
