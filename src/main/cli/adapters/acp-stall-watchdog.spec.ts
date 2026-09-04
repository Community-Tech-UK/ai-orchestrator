import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcpStallWatchdog,
  buildAcpStallOutputMessage,
  type AcpStallReport,
  type AcpStallWatchdogHooks,
} from './acp-stall-watchdog';
import type { AcpTurnWait } from './acp-prompt-timeout-policy';

function makeHooks(overrides: Partial<AcpStallWatchdogHooks> = {}): {
  hooks: AcpStallWatchdogHooks;
  reports: AcpStallReport[];
} {
  const reports: AcpStallReport[] = [];
  const hooks: AcpStallWatchdogHooks = {
    isTurnActive: () => true,
    turnStartedAt: () => Date.now(),
    classifyWait: (): AcpTurnWait => ({ kind: 'unowned' }),
    report: (report) => reports.push(report),
    ...overrides,
  };
  return { hooks, reports };
}

describe('AcpStallWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('repeats until the turn settles', () => {
    const { hooks, reports } = makeHooks();
    const watchdog = new AcpStallWatchdog(100, hooks);
    watchdog.arm();

    vi.advanceTimersByTime(350);

    expect(reports).toHaveLength(3);
    watchdog.clear();
  });

  it('stays down when disabled', () => {
    const { hooks, reports } = makeHooks();
    new AcpStallWatchdog(0, hooks).arm();

    vi.advanceTimersByTime(10_000);

    expect(reports).toHaveLength(0);
  });

  it('never reports when no turn is in flight', () => {
    const { hooks, reports } = makeHooks({ isTurnActive: () => false });
    new AcpStallWatchdog(100, hooks).arm();

    vi.advanceTimersByTime(1_000);

    expect(reports).toHaveLength(0);
  });

  it('stops once the turn settles between intervals', () => {
    let active = true;
    const { hooks, reports } = makeHooks({ isTurnActive: () => active });
    const watchdog = new AcpStallWatchdog(100, hooks);
    watchdog.arm();

    vi.advanceTimersByTime(150);
    expect(reports).toHaveLength(1);

    active = false;
    vi.advanceTimersByTime(1_000);
    expect(reports).toHaveLength(1);
  });

  it('does not re-arm when report() clears it synchronously', () => {
    // `report` runs EventEmitter listeners synchronously; one of them can
    // terminate the adapter, which calls clear(). Re-arming after that would
    // defeat the clear and leave a timer running past the turn.
    const reports: AcpStallReport[] = [];
    const ref: { current?: AcpStallWatchdog } = {};
    const { hooks } = makeHooks({
      report: (report) => {
        reports.push(report);
        ref.current?.clear();
      },
    });
    const watchdog = new AcpStallWatchdog(100, hooks);
    ref.current = watchdog;
    watchdog.arm();

    // Asserted immediately after the FIRST fire. At t=1000 a stale re-armed
    // timer has already fired and self-cancelled on the entry guard, so the end
    // state looks identical with or without the post-report generation check —
    // the window where the stale timer exists is the only place it is visible.
    vi.advanceTimersByTime(100);

    expect(reports).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(reports).toHaveLength(1);
  });

  it('re-arms from scratch on arm(), so a responsive agent never fires', () => {
    const { hooks, reports } = makeHooks();
    const watchdog = new AcpStallWatchdog(100, hooks);
    watchdog.arm();

    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(60);
      watchdog.arm();
    }

    expect(reports).toHaveLength(0);
    watchdog.clear();
  });

  it('falls back to the interval when the turn start is unknown', () => {
    const { hooks, reports } = makeHooks({ turnStartedAt: () => null });
    const watchdog = new AcpStallWatchdog(100, hooks);
    watchdog.arm();

    vi.advanceTimersByTime(150);

    expect(reports[0]?.durationMs).toBe(100);
    watchdog.clear();
  });
});

describe('buildAcpStallOutputMessage', () => {
  it('is a system notice, not a red error bubble', () => {
    const message = buildAcpStallOutputMessage(
      {
        timeoutMs: 300_000,
        durationMs: 900_000,
        inactiveMs: 300_000,
        wait: { kind: 'unowned' },
      },
      'cursor-acp',
      'msg-1',
    );

    expect(message.type).toBe('system');
    expect(message.metadata?.['watchdogWarning']).toBe(true);
    expect(message.metadata?.['source']).toBe('acp-stall-warning');
    expect(message.content).toContain('may be stuck');
  });
});
