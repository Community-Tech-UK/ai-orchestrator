import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachUsageOverageStopGuard,
  configureUsageOverageStop,
  resetUsageOverageStopForTesting,
  type UsageOverageGuardAdapter,
} from './instance-usage-overage-wiring';
import type { CliRateLimitInfo } from '../../shared/types/cli.types';

function makeAdapter(): UsageOverageGuardAdapter & { emit: (info: CliRateLimitInfo) => void } {
  const listeners = new Set<(info: CliRateLimitInfo) => void>();
  return {
    on: (_event, listener) => {
      listeners.add(listener);
      return undefined;
    },
    off: (_event, listener) => {
      listeners.delete(listener);
      return undefined;
    },
    emit: (info) => {
      for (const listener of [...listeners]) listener(info);
    },
  };
}

describe('attachUsageOverageStopGuard', () => {
  let interrupt: ReturnType<typeof vi.fn>;
  let hold: ReturnType<typeof vi.fn>;
  let allowOverage: { value: boolean };

  beforeEach(() => {
    interrupt = vi.fn().mockReturnValue(true);
    hold = vi.fn();
    allowOverage = { value: false };
    configureUsageOverageStop({
      getAllowOverageSetting: () => allowOverage.value,
      interruptInstance: interrupt,
      holdOnUsageLimit: hold,
    });
  });

  afterEach(() => {
    resetUsageOverageStopForTesting();
  });

  it('interrupts the in-flight turn and holds the session on a rejected window', () => {
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    adapter.emit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 });

    expect(interrupt).toHaveBeenCalledWith('i1');
    expect(hold).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledWith('i1', expect.objectContaining({
      resetAtHint: expect.any(Number),
    }));
  });

  it('stops an overage-billed session even when its window status is allowed', () => {
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    adapter.emit({ status: 'allowed', isUsingOverage: true });
    expect(interrupt).toHaveBeenCalledWith('i1');
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('leaves steady-state telemetry alone', () => {
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    adapter.emit({ status: 'allowed', rateLimitType: 'five_hour' });
    adapter.emit({ status: 'allowed_warning', rateLimitType: 'five_hour' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it('does nothing when the overage opt-in is on', () => {
    allowOverage.value = true;
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    adapter.emit({ status: 'rejected', rateLimitType: 'five_hour' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it('still holds the session when the interrupt throws', () => {
    interrupt.mockImplementation(() => {
      throw new Error('interrupt machinery busy');
    });
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    adapter.emit({ status: 'rejected', rateLimitType: 'five_hour' });
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('never lets a hold failure escape the listener', () => {
    hold.mockImplementation(() => {
      throw new Error('no workspace');
    });
    const adapter = makeAdapter();
    attachUsageOverageStopGuard(adapter, 'i1');
    expect(() => adapter.emit({ status: 'rejected', rateLimitType: 'five_hour' })).not.toThrow();
  });

  it('stops listening after teardown', () => {
    const adapter = makeAdapter();
    const teardown = attachUsageOverageStopGuard(adapter, 'i1');
    teardown();
    adapter.emit({ status: 'rejected', rateLimitType: 'five_hour' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it('is a no-op without configured deps', () => {
    resetUsageOverageStopForTesting();
    const adapter = makeAdapter();
    expect(() => attachUsageOverageStopGuard(adapter, 'i1')).not.toThrow();
    adapter.emit({ status: 'rejected', rateLimitType: 'five_hour' });
    expect(hold).not.toHaveBeenCalled();
  });
});
