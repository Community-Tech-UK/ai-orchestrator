import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceUpdateService, type SourceUpdateCandidate, type SourceUpdateDriver } from './source-update-service';

const CURRENT = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const CANDIDATE: SourceUpdateCandidate = { commit: NEXT, appPath: '/tmp/Harness.next.app' };
const SESSION = { instanceId: 'SESSION_PLACEHOLDER', historyEntryId: 'HISTORY_PLACEHOLDER', workingDirectory: '/tmp/project' };

function make() {
  const activation = { commit: vi.fn(async () => undefined), abort: vi.fn() };
  const driver = {
    probe: vi.fn<SourceUpdateDriver['probe']>(async () => ({ available: true, commit: NEXT })),
    build: vi.fn<SourceUpdateDriver['build']>(async () => CANDIDATE),
    prepare: vi.fn<SourceUpdateDriver['prepare']>(async () => activation),
    ack: vi.fn<SourceUpdateDriver['ack']>(async () => ({ acknowledged: false, sessions: [] })),
  };
  const lease = { sessions: [SESSION], recheck: vi.fn(() => true), release: vi.fn() };
  const maintenance = {
    isIdle: vi.fn(() => true), tryAcquire: vi.fn(async () => lease),
    restore: vi.fn(async () => undefined), dispose: vi.fn(),
  };
  const quit = vi.fn();
  const service = new SourceUpdateService({
    currentCommit: CURRENT, currentVersion: '0.1.0', pid: 42, driver, maintenance, quit,
  });
  service.initialize({ enabled: true });
  return { service, driver, activation, maintenance, lease, quit };
}

describe('source updates for a packaged home base', () => {
  afterEach(() => vi.useRealTimers());

  it('does not build or activate before full application bootstrap completes', async () => {
    const { service, driver } = make();
    await service.checkForUpdates();
    expect(driver.probe).not.toHaveBeenCalled();
    expect(driver.build).not.toHaveBeenCalled();
    service.dispose();
  });

  it('checks automatically after readiness and stops polling on disposal', async () => {
    vi.useFakeTimers();
    const { service, driver } = make();
    driver.probe.mockResolvedValue({ available: false, commit: CURRENT });
    await service.markReady();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.probe).toHaveBeenCalledTimes(2);
    service.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.probe).toHaveBeenCalledTimes(2);
  });

  it('builds a pushed commit and commits the handoff only under the final maintenance lease', async () => {
    const { service, driver, lease, activation, quit } = make();
    await service.markReady();
    await service.checkForUpdates();
    expect(driver.probe).toHaveBeenCalledWith({ installedCommit: CURRENT }, expect.any(AbortSignal));
    expect(driver.build).toHaveBeenCalledWith({ commit: NEXT }, expect.any(AbortSignal));
    expect(driver.prepare).toHaveBeenCalledWith({ ...CANDIDATE, parentPid: 42, sessions: [SESSION] }, expect.any(AbortSignal));
    expect(lease.recheck).toHaveBeenCalled();
    expect(activation.commit).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(lease.release).not.toHaveBeenCalled();
    service.dispose();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('defers building while work is active and resumes automatically on a later idle check', async () => {
    const { service, driver, maintenance, quit } = make();
    maintenance.isIdle.mockReturnValue(false);
    await service.markReady();
    await service.checkForUpdates();
    expect(driver.build).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ source: 'git', state: 'waiting-idle' });
    maintenance.isIdle.mockReturnValue(true);
    await service.checkForUpdates();
    expect(driver.build).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('keeps the prepared build when new work arrives during the build', async () => {
    const { service, driver, maintenance, activation } = make();
    driver.build.mockImplementationOnce(async () => {
      maintenance.isIdle.mockReturnValue(false);
      return CANDIDATE;
    });
    await service.markReady();
    await service.checkForUpdates();
    expect(activation.commit).not.toHaveBeenCalled();
    expect(service.getStatus().state).toBe('waiting-idle');
    maintenance.isIdle.mockReturnValue(true);
    await service.checkForUpdates();
    expect(driver.build).toHaveBeenCalledOnce();
    expect(activation.commit).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('aborts a prepared handoff and releases its own lease when the final check detects work', async () => {
    const { service, driver, lease, activation, quit } = make();
    driver.prepare.mockImplementationOnce(async () => {
      lease.recheck.mockReturnValue(false);
      return activation;
    });
    await service.markReady();
    await service.checkForUpdates();
    expect(activation.abort).toHaveBeenCalledOnce();
    expect(activation.commit).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    service.dispose();
  });

  it('keeps the current app and exposes a build failure without leaking subprocess output', async () => {
    const { service, driver, quit } = make();
    driver.build.mockRejectedValueOnce(new Error('PRIVATE_PROCESS_OUTPUT_PLACEHOLDER'));
    await service.markReady();
    await service.checkForUpdates();
    expect(quit).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ state: 'error', source: 'git', errorContext: 'download' });
    expect(service.getStatus().error).not.toContain('PRIVATE_PROCESS_OUTPUT_PLACEHOLDER');
    service.dispose();
  });

  it('does not overlap concurrent checks or builds', async () => {
    const { service, driver } = make();
    let finish: ((candidate: SourceUpdateCandidate) => void) | undefined;
    driver.build.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await service.markReady();
    const first = service.checkForUpdates();
    await vi.waitFor(() => expect(driver.build).toHaveBeenCalledOnce());
    const second = service.checkForUpdates();
    finish!(CANDIDATE);
    await Promise.all([first, second]);
    expect(driver.probe).toHaveBeenCalledOnce();
    expect(driver.build).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('acknowledges only the running stamped commit and restores idle identities without replaying a prompt', async () => {
    const { service, driver, maintenance } = make();
    driver.ack.mockResolvedValue({ acknowledged: true, sessions: [SESSION] });
    await service.markReady();
    expect(driver.ack).toHaveBeenCalledWith({ commit: CURRENT, pid: 42 }, expect.any(AbortSignal));
    expect(maintenance.restore).toHaveBeenCalledWith([SESSION]);
    service.dispose();
  });

  it('retains pending restoration on failure and consumes it only after a successful retry', async () => {
    const { service, driver, maintenance } = make();
    driver.ack.mockResolvedValue({ acknowledged: true, sessions: [SESSION] });
    maintenance.restore.mockRejectedValueOnce(new Error('Remote computer not connected yet'));
    await service.markReady();
    expect(service.getStatus()).toMatchObject({ state: 'error', errorContext: 'install' });
    expect(driver.ack).toHaveBeenCalledTimes(1);
    expect(driver.probe).not.toHaveBeenCalled();
    await service.checkForUpdates();
    expect(maintenance.restore).toHaveBeenCalledTimes(2);
    expect(driver.ack).toHaveBeenLastCalledWith({ commit: CURRENT, pid: 42, restored: true }, expect.any(AbortSignal));
    expect(driver.probe).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('never retains or activates a candidate built from a different commit', async () => {
    const { service, driver, quit } = make();
    driver.build.mockResolvedValueOnce({ ...CANDIDATE, commit: 'c'.repeat(40) });
    await service.markReady();
    await service.checkForUpdates();
    expect(service.getStatus().state).toBe('error');
    expect(quit).not.toHaveBeenCalled();
    await service.checkForUpdates();
    expect(driver.build).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('cancels an unfinished build on dispose and cannot restart after its promise settles', async () => {
    const { service, driver, quit } = make();
    let finish: ((candidate: SourceUpdateCandidate) => void) | undefined;
    driver.build.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await service.markReady();
    const check = service.checkForUpdates();
    await vi.waitFor(() => expect(driver.build).toHaveBeenCalledOnce());
    const signal = driver.build.mock.calls[0]?.[1];
    service.dispose();
    expect(signal?.aborted).toBe(true);
    finish!(CANDIDATE);
    await check;
    expect(quit).not.toHaveBeenCalled();
  });
});
