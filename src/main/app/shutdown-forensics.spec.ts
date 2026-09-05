import { describe, expect, it, vi } from 'vitest';

import {
  buildShutdownSignalRecord,
  installShutdownSignalProbes,
  likelyCauseOf,
  TRAPPED_SHUTDOWN_SIGNALS,
  type ShutdownSignal,
  type ShutdownSignalRecord,
} from './shutdown-forensics';

const probe = { pid: 123, ppid: 456, uptimeSeconds: 90.6 };

describe('buildShutdownSignalRecord (N7)', () => {
  it('records the signal, the pid and — crucially — the parent pid', () => {
    const record = buildShutdownSignalRecord('SIGTERM', probe, 1_000);
    expect(record).toMatchObject({ signal: 'SIGTERM', pid: 123, ppid: 456, observedAt: 1_000 });
  });

  it('rounds uptime rather than logging a float', () => {
    expect(buildShutdownSignalRecord('SIGINT', probe).uptimeSeconds).toBe(91);
  });

  it('includes a plain-language cause so a reader need not know Unix', () => {
    expect(buildShutdownSignalRecord('SIGINT', probe).likelyCause).toContain('Ctrl-C');
  });
});

describe('likelyCauseOf', () => {
  /**
   * A confident wrong attribution in a forensic log sends the next
   * investigation the wrong way, so every reading is hedged.
   */
  it('hedges every cause rather than asserting one', () => {
    for (const signal of TRAPPED_SHUTDOWN_SIGNALS) {
      expect(likelyCauseOf(signal), signal).toContain('usually');
    }
  });

  it('distinguishes the signals rather than giving one generic answer', () => {
    const causes = new Set(TRAPPED_SHUTDOWN_SIGNALS.map(likelyCauseOf));
    expect(causes.size).toBe(TRAPPED_SHUTDOWN_SIGNALS.length);
  });
});

describe('installShutdownSignalProbes', () => {
  function install(write: (r: ShutdownSignalRecord) => void) {
    const handlers = new Map<ShutdownSignal, () => void>();
    installShutdownSignalProbes({
      write,
      readProbe: () => probe,
      on: (signal, handler) => handlers.set(signal, handler),
    });
    return handlers;
  }

  it('registers a handler for every trapped signal', () => {
    const handlers = install(vi.fn());
    expect([...handlers.keys()].sort()).toEqual([...TRAPPED_SHUTDOWN_SIGNALS].sort());
  });

  /** SIGKILL cannot be trapped; pretending to handle it would be a lie. */
  it('does not claim to handle SIGKILL', () => {
    expect(TRAPPED_SHUTDOWN_SIGNALS).not.toContain('SIGKILL' as ShutdownSignal);
  });

  it('writes a record when a signal arrives', () => {
    const write = vi.fn();
    install(write).get('SIGTERM')!();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ signal: 'SIGTERM', ppid: 456 });
  });

  /** A forensic record must never be the reason a shutdown hangs. */
  it('swallows a writer failure rather than throwing during teardown', () => {
    const handlers = install(() => { throw new Error('disk full'); });
    expect(() => handlers.get('SIGINT')!()).not.toThrow();
  });
});
