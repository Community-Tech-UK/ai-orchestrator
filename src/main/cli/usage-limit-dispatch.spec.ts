import { describe, expect, it } from 'vitest';
import { collectUsageLimitHandling, dispatchRateLimitTelemetry, reportUsageLimitHandling } from './usage-limit-dispatch';
import type { UsageLimitHandling } from './usage-limit-notice';

const parked: UsageLimitHandling = { kind: 'parked', autoResume: true, heldMessage: false, metadata: { providerLimitParked: true } };
const switching: UsageLimitHandling = { kind: 'switching', metadata: { accountFailover: true } };

describe('usage-limit dispatch hand-off', () => {
  it('lets whoever holds the session hand the announcement to the adapter that is dispatching the event', () => {
    let taken: boolean | undefined;
    const handling = dispatchRateLimitTelemetry('claude', true, () => { taken = reportUsageLimitHandling('claude', parked); });
    expect(taken).toBe(true);
    expect(handling).toBe(parked);
  });

  it('keeps the first report when several are made during one event', () => {
    const results: boolean[] = [];
    const handling = dispatchRateLimitTelemetry('claude', true, () => {
      results.push(reportUsageLimitHandling('claude', switching), reportUsageLimitHandling('claude', parked));
    });
    expect(results).toEqual([true, true]);
    expect(handling).toBe(switching);
  });

  it('refuses the hand-off when the adapter will not announce this event, so the reporter speaks for itself', () => {
    let taken: boolean | undefined;
    const handling = dispatchRateLimitTelemetry('claude', false, () => { taken = reportUsageLimitHandling('claude', parked); });
    expect(taken).toBe(false);
    expect(handling).toBeUndefined();
  });

  it('refuses a report for another provider, or from outside any event', () => {
    let other: boolean | undefined;
    dispatchRateLimitTelemetry('claude', true, () => { other = reportUsageLimitHandling('codex', parked); });
    expect(other).toBe(false);
    expect(reportUsageLimitHandling('claude', parked)).toBe(false);
  });

  it('closes the window when the event has been delivered, even if a listener throws', () => {
    expect(() => dispatchRateLimitTelemetry('claude', true, () => { throw new Error('listener failed'); })).toThrow('listener failed');
    expect(reportUsageLimitHandling('claude', parked)).toBe(false);
  });

  it('gives each event its own window', () => {
    dispatchRateLimitTelemetry('claude', true, () => { reportUsageLimitHandling('claude', parked); });
    let second: boolean | undefined;
    const handling = dispatchRateLimitTelemetry('claude', true, () => { second = reportUsageLimitHandling('claude', switching); });
    expect(second).toBe(true);
    expect(handling).toBe(switching);
  });

  it('restores an outer event if events nest', () => {
    let outerAfterInner: boolean | undefined;
    const handling = dispatchRateLimitTelemetry('claude', true, () => {
      dispatchRateLimitTelemetry('claude', false, () => undefined);
      outerAfterInner = reportUsageLimitHandling('claude', parked);
    });
    expect(outerAfterInner).toBe(true);
    expect(handling).toBe(parked);
  });
});

describe('collecting what a limit step did, for the caller who writes the one note', () => {
  it('returns the step\'s own result together with what it reported', () => {
    const collected = collectUsageLimitHandling('codex', () => {
      expect(reportUsageLimitHandling('codex', parked)).toBe(true);
      return 'parked' as const;
    });
    expect(collected).toEqual({ result: 'parked', handling: parked });
  });

  it('returns no handling when the step reported nothing, or reported for another provider', () => {
    expect(collectUsageLimitHandling('codex', () => 'skipped')).toEqual({ result: 'skipped' });
    const other = collectUsageLimitHandling('codex', () => reportUsageLimitHandling('claude', parked));
    expect(other).toEqual({ result: false });
  });

  it('keeps the first report, closes the window afterwards and restores one it was opened inside', () => {
    let outer: boolean | undefined;
    const handling = dispatchRateLimitTelemetry('claude', true, () => {
      const collected = collectUsageLimitHandling('claude', () => {
        reportUsageLimitHandling('claude', switching);
        reportUsageLimitHandling('claude', parked);
      });
      expect(collected.handling).toBe(switching);
      outer = reportUsageLimitHandling('claude', parked);
    });
    expect(outer).toBe(true);
    expect(handling).toBe(parked);
    expect(reportUsageLimitHandling('claude', parked)).toBe(false);
  });

  it('closes the window when the step throws', () => {
    expect(() => collectUsageLimitHandling('codex', () => { throw new Error('step failed'); })).toThrow('step failed');
    expect(reportUsageLimitHandling('codex', parked)).toBe(false);
  });
});
