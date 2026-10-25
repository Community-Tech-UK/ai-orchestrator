import { afterEach, describe, expect, it, vi } from 'vitest';
import { markAutomaticStartupInputDispatched, runAutomaticStartup } from './automatic-startup';
import { pauseConsults } from './consult-admission';
import { getWorkAdmission, WorkAdmission } from './work-admission';

afterEach(() => WorkAdmission._resetForTesting());
describe('automatic startup restart barrier', () => {
  it('records only actual input dispatch and refuses a dispatch after cancellation', async () => {
    await runAutomaticStartup(async startup => {
      expect(startup.wasDispatched('started')).toBe(false);
      markAutomaticStartupInputDispatched('started');
      expect(startup.wasDispatched('started')).toBe(true);
      expect(startup.wasDispatched('not-started')).toBe(false);
    });
    await expect(runAutomaticStartup(async startup => {
      getWorkAdmission().setGlobalPhase('collecting');
      try { markAutomaticStartupInputDispatched('cancelled'); }
      finally { expect(startup.wasDispatched('cancelled')).toBe(false); }
    })).rejects.toThrow('cancelled for restart');
  });

  it('waits for admitted creation and actual teardown before allowing restart', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let finishCreation!: () => void;
    const creation = new Promise<void>(resolve => { finishCreation = resolve; });
    let finishTeardown!: () => void;
    const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
    const terminate = vi.fn(() => teardown);
    const spawning = runAutomaticStartup(async startup => {
      markStarted(); await creation;
      startup.register({ id: 'late-helper' }, terminate);
    });
    const cancelled = expect(spawning).rejects.toThrow('cancelled for restart');
    await started; getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeCreation = stopped;
    finishCreation();
    await vi.waitFor(() => expect(terminate).toHaveBeenCalled());
    const stoppedBeforeTeardown = stopped;
    finishTeardown(); await cancelled; await pausing;
    expect(stoppedBeforeCreation).toBe(false);
    expect(stoppedBeforeTeardown).toBe(false);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('retains failed late teardown and retries it on the next Pause attempt', async () => {
    let release!: () => void;
    const creation = new Promise<void>(resolve => { release = resolve; });
    const terminate = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Still running'));
    const spawning = runAutomaticStartup(async startup => { await creation; startup.register({ id: 'helper' }, terminate); });
    const rejected = expect(spawning).rejects.toThrow('Still running');
    getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    release(); await rejected;
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedAfterFailure = stopped;
    terminate.mockResolvedValue(undefined);
    await pauseConsults(); await pausing;
    expect(stoppedAfterFailure).toBe(false);
    expect(terminate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
