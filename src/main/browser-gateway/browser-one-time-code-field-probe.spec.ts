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

interface Evidence { codeField: boolean; filled: boolean; targetIsCodeField: boolean; targetIsPasswordField: boolean }

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

const NONE: Evidence = { codeField: false, filled: false, targetIsCodeField: false, targetIsPasswordField: false };

describe('one-time code box page function', () => {
  it('finds the Report MI code box (id "code") and whether it holds a value', () => {
    expect(probe('<input id="code" type="text">')).toEqual({ ...NONE, codeField: true });
    // Made-up code.
    expect(probe('<input id="code" type="text" value="604213">', '#code'))
      .toEqual({ ...NONE, codeField: true, filled: true, targetIsCodeField: true });
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
    // A contact word beside a code word in the name (emailCode, phoneCode, mobile_code) takes one path.
    ['a labelled emailCode box', '<label for="ec">Verification code</label><input id="ec" name="emailCode">'],
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
    expect(result).toEqual({ ...NONE, codeField: true, filled: true, targetIsCodeField: true });
  });

  it('returns exactly four booleans, never a value', () => {
    const result = probe('<input id="code" value="604213"><input type="password" id="p" value="placeholder-pass">', '#p');
    expect(Object.keys(result).sort()).toEqual(['codeField', 'filled', 'targetIsCodeField', 'targetIsPasswordField']);
    expect(JSON.stringify(result)).not.toContain('604213');
    expect(JSON.stringify(result)).not.toContain('placeholder-pass');
  });
});

// The same boxes are also run through the extension's uid check below, so
// both copies of the rule are held to one list.
const PASSWORD_BOXES: Array<[string, string]> = [
  ['a masked box', '<input id="t" type="password">'],
  ['an upper-case type', '<input id="t" type="PASSWORD">'],
  ['a box marked for a new password', '<input id="t" type="text" autocomplete="new-password">'],
  ['a box marked for the saved password', '<input id="t" autocomplete="section-login current-password">'],
  ['a hidden masked box the agent is writing to', '<input id="t" type="password" style="display:none">'],
];
const NOT_PASSWORD_BOXES: Array<[string, string]> = [
  ['a username box beside "Forgot password?"', '<input id="t" name="username"><a href="/reset">Forgot password?</a>'],
  ['a "Client secret" text box', '<label for="t">Client secret</label><input id="t" name="clientSecret">'],
  ['a "Token name" box', '<label for="t">Token name</label><input id="t">'],
  ['a password-reset email box', '<label for="t">Email for password reset</label><input id="t" type="email">'],
  ['a box whose autocomplete only mentions passwords in passing', '<input id="t" autocomplete="password-hint">'],
  ['a password-named text area', '<textarea id="t" name="password"></textarea>'],
];

describe('password box answer', () => {
  it.each(PASSWORD_BOXES)('says yes for %s', (_label, html) => {
    expect(probe(html, '#t').targetIsPasswordField).toBe(true);
  });

  it.each(NOT_PASSWORD_BOXES)('says no for %s', (_label, html) => {
    expect(probe(html, '#t').targetIsPasswordField).toBe(false);
  });

  it('answers for the targets only: a password box elsewhere on the page does not count', () => {
    const page = '<input id="user"><input id="pass" type="password">';
    expect(probe(page, '#user').targetIsPasswordField).toBe(false);
    expect(probe(page, '#user, #pass').targetIsPasswordField).toBe(true);
    expect(probe(page).targetIsPasswordField).toBe(false);
  });

  it('fails closed on a selector the page cannot parse, but only while a password box is visible', () => {
    expect(probe('<input type="password">', 'text=Password').targetIsPasswordField).toBe(true);
    expect(probe('<input type="password" style="display:none"><input id="e">', 'text=Password').targetIsPasswordField).toBe(false);
  });

  it('resolves a target inside an open shadow root', () => {
    const result = probe('<div id="host"></div>', '#inner', (document) => {
      const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="inner" type="password">';
    });
    expect(result.targetIsPasswordField).toBe(true);
  });

  it('marks a masked code box as both, so the two-factor rule can take precedence', () => {
    expect(probe('<input id="t" type="password" name="passcode">', '#t'))
      .toMatchObject({ targetIsCodeField: true, targetIsPasswordField: true });
  });
});

describe('parseOneTimeCodeEvidence', () => {
  it('accepts the three code box booleans, with or without the password box boolean, and nothing else', () => {
    // An 0.2.50 extension answers three keys: the password box is then unknown.
    expect(parseOneTimeCodeEvidence({ codeField: true, filled: false, targetIsCodeField: true }))
      .toEqual({ codeField: true, filled: false, targetIsCodeField: true });
    expect(parseOneTimeCodeEvidence({ codeField: false, filled: false, targetIsCodeField: false, targetIsPasswordField: true }))
      .toEqual({ codeField: false, filled: false, targetIsCodeField: false, targetIsPasswordField: true });
    for (const value of [
      null, undefined, 'x', [], {},
      { codeField: true, filled: false },
      { codeField: 'true', filled: false, targetIsCodeField: false },
      { codeField: true, filled: false, targetIsCodeField: false, value: '1' },
      { codeField: true, filled: false, targetIsCodeField: false, targetIsPasswordField: 'yes' },
      { codeField: true, filled: false, targetIsCodeField: false, targetIsPasswordField: true, value: '1' },
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

  /**
   * The extension's real merge and uid code, from probeOneTimeCodeFields to the
   * end of uidTargetsIncludePasswordBox, run against fake Chrome and debugger.
   */
  function extensionProbe(options: {
    frames: unknown[];
    uidAnswers?: Record<string, boolean | Error>;
  }) {
    const source = /async function probeOneTimeCodeFields\(command\) \{[\s\S]*?\nasync function uidTargetsIncludePasswordBox\(tabId, uids\) \{[\s\S]*?\n\}/
      .exec(BACKGROUND)?.[0];
    expect(source).toBeTruthy();
    const executeScript = vi.fn(async () => options.frames);
    const sendCommand = vi.fn(async () => undefined);
    const resolved: string[] = [];
    const resolveAndCallOnDebuggee = vi.fn(async (_debuggee: unknown, uid: string) => {
      resolved.push(uid);
      const answer = options.uidAnswers?.[uid];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`Browser element uid could not be resolved: ${uid}`);
      return answer;
    });
    const run = new Function(
      'chrome', 'requireTargetTabId', 'oneTimeCodeFieldProbe', 'withDebugger', 'withCdpDeadline',
      'resolveAndCallOnDebuggee', 'CDP_UID_OBJECT_GROUP',
      `${source!}\nreturn probeOneTimeCodeFields;`,
    )(
      { scripting: { executeScript }, debugger: { sendCommand } },
      (command: { target: { tabId: number } }) => command.target.tabId,
      () => undefined,
      (tabId: number, callback: (debuggee: unknown) => Promise<unknown>) => callback({ tabId }),
      (work: Promise<unknown>) => work,
      resolveAndCallOnDebuggee,
      'uid-group',
    ) as (command: unknown) => Promise<unknown>;
    return { run, executeScript, resolved };
  }

  const CODE_ONLY = { codeField: false, filled: false, targetIsCodeField: false };

  it('runs in every frame and merges the frames, answering the password box only for a target', async () => {
    const { run, executeScript } = extensionProbe({
      frames: [
        { result: { ...CODE_ONLY, targetIsPasswordField: false } },
        { result: { codeField: true, filled: true, targetIsCodeField: false, targetIsPasswordField: true } },
        { result: null },
        {},
      ],
    });

    await expect(run({ target: { tabId: 7 }, payload: { selector: '#code' } }))
      .resolves.toEqual({ codeField: true, filled: true, targetIsCodeField: false, targetIsPasswordField: true });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7, allFrames: true },
      args: ['#code'],
    }));

    // No target: the code box answer only.
    await expect(run({ target: { tabId: 7 }, payload: {} }))
      .resolves.toEqual({ codeField: true, filled: true, targetIsCodeField: false });
    expect(executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: [null] }));
  });

  it('leaves the password box unknown when no frame answered for a selector', async () => {
    const { run } = extensionProbe({ frames: [] });
    await expect(run({ target: { tabId: 7 }, payload: { selector: '#p' } })).resolves.toEqual(CODE_ONLY);
  });

  it('resolves uid targets through the debugger', async () => {
    const no = extensionProbe({ frames: [{ result: { ...CODE_ONLY, targetIsPasswordField: false } }], uidAnswers: { 41: false, 42: false } });
    await expect(no.run({ target: { tabId: 7 }, payload: { uids: ['41', '42'] } }))
      .resolves.toEqual({ ...CODE_ONLY, targetIsPasswordField: false });
    expect(no.resolved).toEqual(['41', '42']);

    const yes = extensionProbe({ frames: [{ result: CODE_ONLY }], uidAnswers: { 41: false, 42: true } });
    await expect(yes.run({ target: { tabId: 7 }, payload: { uids: ['41', '42'] } }))
      .resolves.toEqual({ ...CODE_ONLY, targetIsPasswordField: true });
  });

  it('says unknown, never no, when a uid cannot be resolved, unless another target is already a password box', async () => {
    const unknown = extensionProbe({ frames: [{ result: { ...CODE_ONLY, targetIsPasswordField: false } }], uidAnswers: { 41: false } });
    await expect(unknown.run({ target: { tabId: 7 }, payload: { selector: '#user', uids: ['41', '99'] } }))
      .resolves.toEqual(CODE_ONLY);

    const known = extensionProbe({ frames: [{ result: { ...CODE_ONLY, targetIsPasswordField: true } }], uidAnswers: {} });
    await expect(known.run({ target: { tabId: 7 }, payload: { selector: '#pass', uids: ['99'] } }))
      .resolves.toEqual({ ...CODE_ONLY, targetIsPasswordField: true });
  });

  it('finds a password uid after one it could not resolve', async () => {
    const { run, resolved } = extensionProbe({ frames: [{ result: CODE_ONLY }], uidAnswers: { 42: true } });
    await expect(run({ target: { tabId: 7 }, payload: { uids: ['99', '42'] } }))
      .resolves.toEqual({ ...CODE_ONLY, targetIsPasswordField: true });
    expect(resolved).toEqual(['99', '42']);
  });

  it('never answers "no" for uids it dropped unchecked (malformed, or past the cap)', async () => {
    const malformed = extensionProbe({ frames: [{ result: { ...CODE_ONLY, targetIsPasswordField: false } }], uidAnswers: { 41: false } });
    await expect(malformed.run({ target: { tabId: 7 }, payload: { uids: 'not-a-list' } })).resolves.toEqual(CODE_ONLY);
    await expect(malformed.run({ target: { tabId: 7 }, payload: { selector: '#user', uids: ['41', 7, ''] } }))
      .resolves.toEqual(CODE_ONLY);
    expect(malformed.resolved).toEqual(['41']);

    const many = Object.fromEntries(Array.from({ length: 51 }, (_unused, index) => [String(index + 1), false]));
    const capped = extensionProbe({ frames: [{ result: CODE_ONLY }], uidAnswers: many });
    await expect(capped.run({ target: { tabId: 7 }, payload: { uids: Object.keys(many) } })).resolves.toEqual(CODE_ONLY);
    expect(capped.resolved).toHaveLength(50);
  });

  it('applies the same password box rule to a uid-resolved element', () => {
    const fnSource = /function uidPasswordBoxFn\(\) \{[\s\S]*?\n\}/.exec(BACKGROUND)?.[0];
    expect(fnSource).toBeTruthy();
    const uidPasswordBoxFn = new Function(`return (${fnSource!});`)() as (this: Element) => boolean;
    for (const [rows, expected] of [[PASSWORD_BOXES, true], [NOT_PASSWORD_BOXES, false]] as const) {
      for (const [label, html] of rows) {
        const element = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.getElementById('t')!;
        expect(uidPasswordBoxFn.call(element), label).toBe(expected);
      }
    }
  });
});
