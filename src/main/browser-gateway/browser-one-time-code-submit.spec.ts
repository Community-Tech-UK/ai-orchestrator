import { describe, expect, it, vi } from 'vitest';
import { classifyBrowserAction } from './browser-action-classifier';
import {
  BrowserOneTimeCodeFillLedger,
  classifyOneTimeCodeSubmit,
  ONE_TIME_CODE_SUBMIT_WINDOW_MS,
  type OneTimeCodeSubmitInput,
} from './browser-one-time-code-submit';

const TAB = { instanceId: 'i1', profileId: 'p1', targetId: 't1' };
const ORIGIN = 'https://tap.tcsapps.com';

describe('BrowserOneTimeCodeFillLedger', () => {
  it('matches the page origin without regard to case', () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ ...TAB, origin: 'https://TAP.tcsapps.com' });

    expect(ledger.has({ ...TAB, origin: ORIGIN })).toBe(true);
  });

  it('is live right at the end of the window and not after', () => {
    let now = 0;
    const ledger = new BrowserOneTimeCodeFillLedger(() => now);
    ledger.record({ ...TAB, origin: ORIGIN });
    now = ONE_TIME_CODE_SUBMIT_WINDOW_MS;
    expect(ledger.has({ ...TAB, origin: ORIGIN })).toBe(true);
    now += 1;
    expect(ledger.has({ ...TAB, origin: ORIGIN })).toBe(false);
  });

  it('belongs to the session that filled it', () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ ...TAB, origin: ORIGIN });

    expect(ledger.has({ ...TAB, instanceId: 'i2', origin: ORIGIN })).toBe(false);
  });

  it('keeps only the newest fill for a tab and is gone once consumed', () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ ...TAB, origin: 'https://first.example' });
    ledger.record({ ...TAB, origin: ORIGIN });

    expect(ledger.has({ ...TAB, origin: 'https://first.example' })).toBe(false);
    expect(ledger.has({ ...TAB, origin: ORIGIN })).toBe(true);
    ledger.consume({ ...TAB, origin: ORIGIN });
    expect(ledger.has({ ...TAB, origin: ORIGIN })).toBe(false);
  });
});

describe('classifyOneTimeCodeSubmit keeps the checks two-factor words would hide', () => {
  // Each of these classifies as a two-factor challenge first. After a gateway
  // fill they must still stop for the declaration or reset they carry.
  it.each([
    ['a legal declaration', 'Validate OTP', 'I declare that the information is true. Enter OTP'],
    ['a destructive action', 'Reset account', 'Enter verification code'],
  ])('keeps a click with %s parked', (_label, visibleText, nearbyText) => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ ...TAB, origin: ORIGIN });
    const elementContext = { visibleText, nearbyText };
    const input = { toolName: 'browser.click', elementContext, elementContextSource: 'inspected' as const };
    const classification = classifyBrowserAction(input);
    const result = vi.fn() as unknown as OneTimeCodeSubmitInput['result'];

    const checked = classifyOneTimeCodeSubmit({
      ledger, classification, result, request: { instanceId: 'i1' }, action: 'click', toolName: 'browser.click',
      scope: { profileId: 'p1', targetId: 't1', origin: ORIGIN, url: `${ORIGIN}/register` },
      classifyWithoutTwoFactor: () => classifyBrowserAction({ ...input, ignoreTwoFactor: true }),
    });

    expect(classification.reason).toBe('two_factor_challenge');
    expect(checked).toEqual({ classification });
    expect(result).not.toHaveBeenCalled();
  });
});
