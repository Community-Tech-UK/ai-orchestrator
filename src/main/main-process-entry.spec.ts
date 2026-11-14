import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const bootstrap = vi.hoisted(() => ({ loadMain: null as null | (() => Promise<unknown>) }));
const profile = vi.hoisted(() => ({ fails: false, packaged: true }));

vi.mock('electron', () => ({ app: { get isPackaged() { return profile.packaged; }, exit: vi.fn() } }));
vi.mock('./app/fatal-trap-signal-guard', () => ({
  installFatalTrapSignalGuard: () => calls.push('guard'),
}));
vi.mock('./app/startup-smoke-markers', () => ({
  writeStartupSmokePidMarker: ({ pid }: { pid: number }) => calls.push(`pid-marker:${pid}`),
}));
vi.mock('./app/user-data-path', () => ({
  initializeHarnessUserDataPath: () => { calls.push('profile'); if (profile.fails) throw new Error('Invalid test profile'); },
}));
vi.mock('./main-process-bootstrap', () => ({
  startHarnessMainProcess: (options: { loadMain: () => Promise<unknown> }) => {
    calls.push('bootstrap');
    bootstrap.loadMain = options.loadMain;
    return Promise.resolve();
  },
}));
describe('main-process entry', () => {
  beforeEach(() => {
    calls.length = 0;
    profile.fails = false;
    vi.resetModules();
    vi.doMock('./index', () => { calls.push('index'); return {}; });
  });

  it.each([true, false])('sets the profile before any app imports (packaged=%s)', async (packaged) => {
    profile.packaged = packaged;
    await import('./main-process-entry');

    expect(calls).toEqual(['guard', 'bootstrap']);

    await bootstrap.loadMain?.();

    // Only the process that runs main publishes its pid, and it does so before
    // the app code loads, so a crash while loading is still attributable.
    expect(calls).toEqual(['guard', 'bootstrap', 'profile', `pid-marker:${process.pid}`, 'index']);
  });

  it('does not import app services or write smoke markers when profile validation fails', async () => {
    await import('./main-process-entry');
    profile.fails = true;
    expect(() => bootstrap.loadMain?.()).toThrow('Invalid test profile');
    expect(calls).toEqual(['guard', 'bootstrap', 'profile']);
  });
});
