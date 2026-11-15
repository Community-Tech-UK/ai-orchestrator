// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// @ts-expect-error No type declarations available for jsdom in this repo.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function page(consent = false) {
  const dom = new JSDOM(consent
    ? '<form aria-label="Sign in to Codex with ChatGPT" method="post" action="/sign-in-with-chatgpt/codex/consent"><span>approved@example.invalid</span><button type="submit">Continue</button></form>'
    : `<form method="post" action="/deviceauth/authorize_code">
    ${Array.from({ length: 9 }, (_, i) => `<input name="character_${i + 1}" maxlength="1" inputmode="text" autocomplete="one-time-code" aria-label="Code character ${i + 1} of 9">`).join('')}
    <input type="hidden" name="user_code"><input type="hidden" name="user_code_text">
    <button type="submit" name="decision" value="grant" disabled>Continue</button>
    <button type="submit" name="decision" value="grant" hidden></button>
    <button type="submit" name="decision" value="reject">Cancel</button></form>`,
  { url: `https://auth.openai.com/${consent ? 'sign-in-with-chatgpt/codex/consent' : 'deviceauth/callback'}` });
  const doc = dom.window.document as Document;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  let submits = 0;
  doc.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); submits++; });
  const inputs = [...doc.querySelectorAll<HTMLInputElement>('input[name^="character_"]')];
  for (const input of inputs) input.addEventListener('input', () => {
    const value = inputs.map((field) => field.value).join('');
    doc.querySelector<HTMLInputElement>('input[name="user_code"]')!.value = value;
    doc.querySelector<HTMLInputElement>('input[name="user_code_text"]')!.value = value;
    doc.querySelector<HTMLButtonElement>('button[value="grant"]')!.disabled = value.length !== 9;
  });
  const source = readFileSync('resources/browser-extension/codex-device-handoff.js', 'utf8');
  const run = runInNewContext(`${source}\ncodexDevicePage;`, {
    document: doc, location: dom.window.location, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, Event: dom.window.Event,
    InputEvent: dom.window.InputEvent, getComputedStyle: dom.window.getComputedStyle,
    URL, Date,
  }) as (action: string, identity: string, code: string, expiry: number) => Promise<unknown>;
  return { doc, inputs, run, submits: () => submits };
}

describe('private Codex nine-control DOM write', () => {
  it('reads actual consent identity and refuses a different approved identity before clicking', async () => {
    const h = page(true);
    expect(await h.run('consent', '', '', Date.now() + 10_000)).toEqual({ identity: 'approved@example.invalid' });
    expect(await h.run('transition', 'wrong@example.invalid', '', Date.now() + 10_000)).toBe(false);
    expect(h.submits()).toBe(0);
    expect(await h.run('transition', 'approved@example.invalid', '', Date.now() + 10_000)).toBe(true);
    expect(h.submits()).toBe(1);
  });

  it('verifies every control and both submitted aggregates, then selects only visible grant', async () => {
    const h = page();
    expect(await h.run('fill', '', 'TESTCODEX', Date.now() + 10_000)).toBe(true);
    expect(h.inputs.map((input) => input.value).join('')).toBe('TESTCODEX');
    expect(await h.run('submit', '', 'TESTCODEX', Date.now() + 10_000)).toBe(true);
    expect(h.submits()).toBe(1);
  });

  it.each(['last-control', 'early-control', 'aggregate', 'text-aggregate', 'origin', 'expiry', 'format', 'duplicate'])('refuses %s without reporting a verified fill', async (kind) => {
    const h = page();
    if (kind === 'last-control') h.inputs[8].addEventListener('input', () => { h.inputs[8].value = ''; });
    if (kind === 'early-control') h.inputs[8].addEventListener('input', () => { h.inputs[0].value = ''; });
    if (kind === 'aggregate') h.inputs[8].addEventListener('input', () => { h.doc.querySelector<HTMLInputElement>('[name="user_code"]')!.value = ''; });
    if (kind === 'text-aggregate') h.inputs[8].addEventListener('input', () => { h.doc.querySelector<HTMLInputElement>('[name="user_code_text"]')!.value = ''; });
    if (kind === 'origin') h.doc.querySelector('form')!.action = 'https://wrong.example.invalid/deviceauth/authorize_code';
    if (kind === 'duplicate') h.doc.querySelector('form')!.append(h.inputs[0].cloneNode());
    expect(await h.run('fill', '', kind === 'format' ? 'TEST-CODEX' : 'TESTCODEX', kind === 'expiry' ? 1 : Date.now() + 10_000)).toBe(false);
    expect(h.submits()).toBe(0);
  });

  it('rechecks controls and hidden values before submission', async () => {
    const h = page();
    expect(await h.run('fill', '', 'TESTCODEX', Date.now() + 10_000)).toBe(true);
    h.inputs[0].value = '';
    expect(await h.run('submit', '', 'TESTCODEX', Date.now() + 10_000)).toBe(false);
    expect(h.submits()).toBe(0);
  });

  it.each(['action', 'override', 'disabled-aggregate'])('refuses changed %s at submit', async (kind) => {
    const h = page();
    expect(await h.run('fill', '', 'TESTCODEX', Date.now() + 10_000)).toBe(true);
    if (kind === 'action') h.doc.querySelector('form')!.action = 'https://wrong.example.invalid/';
    if (kind === 'override') h.doc.querySelector('button')!.setAttribute('formaction', 'https://wrong.example.invalid/');
    if (kind === 'disabled-aggregate') h.doc.querySelector<HTMLInputElement>('[name="user_code"]')!.disabled = true;
    expect(await h.run('submit', '', 'TESTCODEX', Date.now() + 10_000)).toBe(false);
    expect(h.submits()).toBe(0);
  });
});
