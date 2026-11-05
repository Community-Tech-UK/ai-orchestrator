import { readFileSync } from 'node:fs';
// The repository intentionally has no @types/jsdom (see browser-extension-origin-bound-secret.spec.ts).
// @ts-expect-error No local declaration file is installed for jsdom.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  managedOneTimeCodeProbeExpression,
  ONE_TIME_CODE_FIELD_PROBE_SOURCE,
  parseOneTimeCodeEvidence,
} from './browser-one-time-code-field-probe';

const BACKGROUND = readFileSync('resources/browser-extension/background.js', 'utf-8');

interface Evidence { codeField: boolean; filled: boolean; targetIsCodeField: boolean }

/**
 * Run the real page function over an HTML fixture. JSDOM lays nothing out, so
 * every element gets a 100x20 box unless it (or an ancestor) is display:none,
 * or it carries data-zero-size (an element the page has collapsed).
 */
function probe(html: string, targetSelector?: string, decorate?: (document: Document) => void): Evidence {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const { window } = dom;
  const collapsed = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (window.getComputedStyle(node).display === 'none') return true;
    }
    return element.hasAttribute('data-zero-size');
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const hidden = collapsed(this);
    return { width: hidden ? 0 : 100, height: hidden ? 0 : 20 } as DOMRect;
  };
  decorate?.(window.document);
  const run = new Function(
    'document',
    'getComputedStyle',
    `return (${ONE_TIME_CODE_FIELD_PROBE_SOURCE})(${JSON.stringify(targetSelector ?? null)});`,
  ) as (document: Document, getComputedStyle: Window['getComputedStyle']) => Evidence;
  return run(window.document, window.getComputedStyle.bind(window));
}

const NONE: Evidence = { codeField: false, filled: false, targetIsCodeField: false };

describe('one-time code box page function', () => {
  it('finds the Report MI code box (id "code") and whether it holds a value', () => {
    expect(probe('<input id="code" type="text">')).toEqual({ codeField: true, filled: false, targetIsCodeField: false });
    // Made-up code.
    expect(probe('<input id="code" type="text" value="604213">', '#code'))
      .toEqual({ codeField: true, filled: true, targetIsCodeField: true });
    expect(probe('<input name="code">')).toMatchObject({ codeField: true });
  });

  it.each([
    ['the standard autocomplete hint', '<input autocomplete="one-time-code">'],
    ['an OTP label', '<label for="x">One-Time Password (OTP)</label><input id="x">'],
    ['an aria-labelledby heading', '<h2 id="h">Enter your verification code</h2><input aria-labelledby="h">'],
    ['a camelCase name', '<input name="mfaCode">'],
    ['an upper-case id', '<input id="OTPInput">'],
    ['a placeholder', '<input placeholder="6-digit authentication code">'],
    ['a 2FA aria-label', '<input aria-label="2FA code" type="tel">'],
    ['a masked passcode', '<input type="password" name="passcode">'],
    ['split digit boxes', `<form>${'<input maxlength="1">'.repeat(6)}</form>`],
    ['a code box whose label mentions the email it was sent to', '<label for="i7">Enter the verification code sent to your email</label><input id="i7">'],
    ['an emailed-code field named for both', '<input name="emailOtp">'],
    ['a labelled emailCode box', '<label for="ec">Verification code</label><input id="ec" name="emailCode">'],
    ['a labelled phoneCode box', '<label for="pc">Verification code</label><input id="pc" name="phoneCode">'],
    ['a labelled mobile_code box', '<label for="mc">Verification code</label><input id="mc" name="mobile_code">'],
    ['an email_code box with a code placeholder', '<input id="email_code" placeholder="One time code">'],
  ])('recognises %s', (_label, html) => {
    expect(probe(html).codeField).toBe(true);
  });

  it.each([
    ['a postcode', '<input id="postcode" name="postcode">'],
    ['a discount code', '<label for="d">Discount code</label><input id="d" name="promo_code">'],
    ['a procurement CPV code', '<input name="cpvCode" placeholder="CPV code">'],
    ['a SIC code', '<label for="s">SIC code</label><input id="s">'],
    ['a card security code', '<label for="c">Security code</label><input id="c" autocomplete="cc-csc">'],
    ['an ordinary password', '<input type="password" id="password">'],
    ['a split sort code (two-character boxes)', `<form>${'<input maxlength="2">'.repeat(3)}</form>`],
    ['three single-character boxes', `<form>${'<input maxlength="1">'.repeat(3)}</form>`],
    ['a hidden input named code', '<input type="hidden" name="code" value="x">'],
    ['a collapsed code box', '<input id="code" data-zero-size>'],
    ['a code box inside a hidden step', '<div style="display:none"><input id="code" value="1"></div>'],
    ['a code box hidden with visibility', '<input id="code" style="visibility:hidden">'],
    ['a disabled code box', '<input id="code" disabled value="1">'],
    ['an email field whose label mentions the code', '<label for="e">Email (we will send a verification code)</label><input id="e" name="email">'],
    ['a phone field with a code placeholder', '<input name="mobileNumber" placeholder="We text your one time code here">'],
    ['a username field with a code aria-label', '<input autocomplete="username" aria-label="Username for 2FA">'],
    ['a local phone field with a code label', '<label for="t">Phone (we text a one time code)</label><input id="t" autocomplete="tel-local">'],
  ])('ignores %s', (_label, html) => {
    expect(probe(html)).toEqual(NONE);
  });

  it('treats a whitespace-only value as empty, and any split box with a digit as filled', () => {
    expect(probe('<input id="code" value="   ">').filled).toBe(false);
    const boxes = `<form><input maxlength="1" value="6">${'<input maxlength="1">'.repeat(5)}</form>`;
    expect(probe(boxes).filled).toBe(true);
  });

  it('reports whether the typed or filled targets include the code box', () => {
    const page = '<input id="email"><input id="code">';
    expect(probe(page, '#email').targetIsCodeField).toBe(false);
    expect(probe(page, '#email, #code').targetIsCodeField).toBe(true);
    expect(probe(page, '#missing').targetIsCodeField).toBe(false);
  });

  it('fails closed on a selector the page cannot parse, but only while a code box is visible', () => {
    expect(probe('<input id="code">', 'text=Code').targetIsCodeField).toBe(true);
    expect(probe('<input id="email">', 'text=Code').targetIsCodeField).toBe(false);
  });

  it('sees a code box inside an open shadow root, and resolves targets there', () => {
    const result = probe('<div id="host"></div>', '#inner', (document) => {
      const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="inner" autocomplete="one-time-code" value="1">';
    });
    expect(result).toEqual({ codeField: true, filled: true, targetIsCodeField: true });
  });

  it('returns exactly three booleans, never a value', () => {
    const result = probe('<input id="code" value="604213">');
    expect(Object.keys(result).sort()).toEqual(['codeField', 'filled', 'targetIsCodeField']);
    expect(JSON.stringify(result)).not.toContain('604213');
  });
});

describe('parseOneTimeCodeEvidence', () => {
  it('accepts exactly three booleans and nothing else', () => {
    expect(parseOneTimeCodeEvidence({ codeField: true, filled: false, targetIsCodeField: true }))
      .toEqual({ codeField: true, filled: false, targetIsCodeField: true });
    for (const value of [
      null, undefined, 'x', [], {},
      { codeField: true, filled: false },
      { codeField: 'true', filled: false, targetIsCodeField: false },
      { codeField: true, filled: false, targetIsCodeField: false, value: '1' },
    ]) {
      expect(parseOneTimeCodeEvidence(value)).toBeUndefined();
    }
  });
});

describe('managed-profile expression', () => {
  it('calls the shared function with the target selector, or null', () => {
    expect(managedOneTimeCodeProbeExpression('#code')).toBe(`(${ONE_TIME_CODE_FIELD_PROBE_SOURCE})("#code")`);
    expect(managedOneTimeCodeProbeExpression(undefined)).toBe(`(${ONE_TIME_CODE_FIELD_PROBE_SOURCE})(null)`);
  });
});

describe('browser extension probe_one_time_code command', () => {
  it('ships a byte-identical copy of the page function', () => {
    expect(BACKGROUND).toContain(`\n${ONE_TIME_CODE_FIELD_PROBE_SOURCE}\n`);
  });

  it('is dispatched, and is not a secret-observation command (it must answer on a protected origin)', () => {
    expect(BACKGROUND).toContain("    case 'probe_one_time_code':\n      return probeOneTimeCodeFields(command);");
    const observation = /const SECRET_OBSERVATION_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(BACKGROUND)?.[1] ?? '';
    expect(observation).toContain("'read_control'");
    expect(observation).not.toContain('probe_one_time_code');
  });

  it('runs in every frame and merges the frames into three booleans', async () => {
    const source = /async function probeOneTimeCodeFields\(command\) \{[\s\S]*?\n\}/.exec(BACKGROUND)?.[0];
    expect(source).toBeTruthy();
    const executeScript = vi.fn(async () => [
      { result: { codeField: false, filled: false, targetIsCodeField: false } },
      { result: { codeField: true, filled: true, targetIsCodeField: false } },
      { result: null },
      {},
    ]);
    const chrome = { scripting: { executeScript } };
    const run = new Function(
      'chrome', 'requireTargetTabId', 'oneTimeCodeFieldProbe',
      `${source!}\nreturn probeOneTimeCodeFields;`,
    )(chrome, (command: { target: { tabId: number } }) => command.target.tabId, () => undefined) as (
      command: unknown,
    ) => Promise<unknown>;

    await expect(run({ target: { tabId: 7 }, payload: { selector: '#code' } }))
      .resolves.toEqual({ codeField: true, filled: true, targetIsCodeField: false });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7, allFrames: true },
      args: ['#code'],
    }));

    await run({ target: { tabId: 7 }, payload: {} });
    expect(executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: [null] }));
  });
});
