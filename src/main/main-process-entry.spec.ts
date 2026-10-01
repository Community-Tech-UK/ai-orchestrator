import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const bootstrap = vi.hoisted(() => ({ loadMain: null as null | (() => Promise<unknown>) }));

vi.mock('electron', () => ({ app: { isPackaged: true, exit: vi.fn() } }));
vi.mock('./app/fatal-trap-signal-guard', () => ({
  installFatalTrapSignalGuard: () => calls.push('guard'),
}));
vi.mock('./app/startup-smoke-markers', () => ({
  writeStartupSmokePidMarker: ({ pid }: { pid: number }) => calls.push(`pid-marker:${pid}`),
}));
vi.mock('./main-process-bootstrap', () => ({
  startHarnessMainProcess: (options: { loadMain: () => Promise<unknown> }) => {
    calls.push('bootstrap');
    bootstrap.loadMain = options.loadMain;
    return Promise.resolve();
  },
}));
vi.mock('./index', () => {
  calls.push('index');
  return {};
});

describe('main-process entry', () => {
  it('installs the SIGTRAP guard before the app code (and so electron-store) can load', async () => {
    await import('./main-process-entry');

    expect(calls).toEqual(['guard', 'bootstrap']);

    await bootstrap.loadMain?.();

    // Only the process that runs main publishes its pid, and it does so before
    // the app code loads, so a crash while loading is still attributable.
    expect(calls).toEqual(['guard', 'bootstrap', `pid-marker:${process.pid}`, 'index']);
  });
});
