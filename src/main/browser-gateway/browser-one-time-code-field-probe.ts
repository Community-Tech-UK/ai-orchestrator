/**
 * Sign-in code box evidence for the action guard.
 *
 * On a shared extension tab the guard only sees the agent's own description of
 * a click, so a two-factor step used to stop only when that description used a
 * two-factor word (2026-11-05: a Report MI code typed with browser.type into
 * `#code` was submitted as an ordinary click). This page function lets the
 * guard see the code box itself.
 *
 * ONE source, run in two places:
 *  - the browser extension's `probe_one_time_code` command (background.js holds
 *    a byte-identical copy, pinned by browser-one-time-code-field-probe.spec.ts),
 *    which runs it in every frame. That command is deliberately NOT a
 *    secret-observation command, because the code page usually sits on the
 *    origin a password fill has just protected — and `read_control` is refused
 *    there.
 *  - managed (Harness-owned) profiles, through the driver's evaluate.
 *
 * It returns three booleans and nothing else: never a value, page text,
 * selector match list or element identity.
 *
 * A code box is a visible, enabled text/tel/number/password/untyped
 * `<input>` (open shadow roots included; some sites mask the code) that has `autocomplete` containing `one-time-code`,
 * an id or name of exactly `code`, a two-factor term in its id or name, a
 * two-factor term in its placeholder, aria-label or label text (unless its
 * own id, name or autocomplete says it is an email, phone or username field
 * and its id or name has no code-like word such as code, pin or token),
 * or is one of 4-8 single-character inputs in one form (split-digit boxes).
 * Card security codes, postcodes and discount/CPV/SIC codes deliberately do
 * not match.
 *
 * `targetSelector` (type/fill_form targets, a CSS selector list): a selector the
 * page cannot parse counts as a code box whenever one is visible, so an
 * unresolvable target fails closed rather than open.
 *
 * Must stay free of backticks and template placeholders: it is a String.raw.
 */
export const ONE_TIME_CODE_FIELD_PROBE_SOURCE = String.raw`function oneTimeCodeFieldProbe(targetSelector) {
  const CODE_TERMS = /(?:^| )(?:otp|mfa|2fa|totp|two factor|one time|verification code|recovery code|passcode|authentication code|auth code)(?: |$)/;
  const FIELD_TYPES = ['', 'text', 'tel', 'number', 'password'];
  const words = (value) => String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
  const roots = [];
  const inputs = [];
  const walk = (root) => {
    roots.push(root);
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.tagName === 'INPUT') inputs.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const labelText = (element) => {
    const parts = Array.from(element.labels || []).map((label) => label.textContent);
    for (const id of (element.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      const labelled = id ? document.getElementById(id) : null;
      if (labelled) parts.push(labelled.textContent);
    }
    return parts.join(' ');
  };
  const candidates = inputs.filter((element) =>
    FIELD_TYPES.includes((element.getAttribute('type') || '').toLowerCase())
    && !element.disabled
    && visible(element));
  const CONTACT_TERMS = /(?:^| )(?:email|e mail|phone|mobile|telephone|username)(?: |$)/;
  const CODE_WORDS = /(?:^| )(?:code|pin|token|verification|verify)(?: |$)/;
  const named = (element) => {
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    const id = (element.id || '').toLowerCase();
    const name = (element.getAttribute('name') || '').toLowerCase();
    const identity = words([element.id, element.getAttribute('name')].join(' '));
    if (autocomplete.includes('one-time-code') || id === 'code' || name === 'code' || CODE_TERMS.test(identity)) {
      return true;
    }
    // Prose around a field ("Email - we will send a verification code") is
    // weaker than its own identity: a field that says it is contact data, and
    // nothing code-like (emailCode, phone_pin), is never a code box on its
    // label or placeholder alone.
    const contact = CONTACT_TERMS.test(identity)
      || autocomplete.some((token) => token === 'email' || token === 'username' || token.startsWith('tel'));
    if (contact && !CODE_WORDS.test(identity)) {
      return false;
    }
    return CODE_TERMS.test(words([
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
      labelText(element),
    ].join(' ')));
  };
  const codeFields = candidates.filter(named);
  const boxesByForm = new Map();
  for (const element of candidates) {
    if (element.maxLength !== 1) continue;
    const scope = element.form || element.getRootNode();
    boxesByForm.set(scope, (boxesByForm.get(scope) || []).concat([element]));
  }
  for (const boxes of boxesByForm.values()) {
    if (boxes.length >= 4 && boxes.length <= 8) codeFields.push(...boxes);
  }
  const filled = codeFields.some((element) => String(element.value || '').trim() !== '');
  let targetIsCodeField = false;
  if (typeof targetSelector === 'string' && targetSelector) {
    try {
      targetIsCodeField = roots.some((root) => Array.from(root.querySelectorAll(targetSelector))
        .some((element) => codeFields.includes(element)));
    } catch {
      targetIsCodeField = codeFields.length > 0;
    }
  }
  return { codeField: codeFields.length > 0, filled, targetIsCodeField };
}`;

/** Driver expression for managed profiles: the same function, main frame only. */
export function managedOneTimeCodeProbeExpression(targetSelector: string | undefined): string {
  return `(${ONE_TIME_CODE_FIELD_PROBE_SOURCE})(${JSON.stringify(targetSelector ?? null)})`;
}

export interface BrowserOneTimeCodeEvidence {
  /** A visible sign-in code box is on the page. */
  codeField: boolean;
  /** At least one visible code box holds a value. */
  filled: boolean;
  /** The type/fill_form target is a code box (or cannot be resolved while one is visible). */
  targetIsCodeField: boolean;
}

/**
 * Strict reader for the probe's answer. Anything but exactly three booleans is
 * not evidence (a stale or foreign reply must not be read as "no code box").
 */
export function parseOneTimeCodeEvidence(value: unknown): BrowserOneTimeCodeEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'codeField,filled,targetIsCodeField'
    || typeof record['codeField'] !== 'boolean'
    || typeof record['filled'] !== 'boolean'
    || typeof record['targetIsCodeField'] !== 'boolean'
  ) {
    return undefined;
  }
  return {
    codeField: record['codeField'],
    filled: record['filled'],
    targetIsCodeField: record['targetIsCodeField'],
  };
}
