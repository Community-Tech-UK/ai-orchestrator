import { afterEach, describe, expect, it } from 'vitest';
import { visibleTextOf } from './tooltip-visible-text';

describe('visibleTextOf', () => {
  afterEach(() => document.body.replaceChildren());

  function root(html: string): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = html;
    document.body.append(element);
    return element;
  }

  it('keeps visible nested text and its whitespace', () => {
    expect(visibleTextOf(root('Run <strong>the</strong> task'))).toBe('Run the task');
  });

  it('skips hidden and display-none subtrees', () => {
    expect(visibleTextOf(root('Shown<span hidden>Hidden <b>nested</b></span><span style="display:none">Collapsed</span>'))).toBe('Shown');
  });

  it('honors display-none styles from a stylesheet', () => {
    expect(visibleTextOf(root('<style>.hidden-label { display: none; }</style><span class="hidden-label">Hidden</span><span>Shown</span>'))).toBe('Shown');
  });

  it('skips hidden text while preserving descendants that restore visibility', () => {
    expect(visibleTextOf(root('<span style="visibility:hidden">Hidden<span style="visibility:visible">Shown</span></span>'))).toBe('Shown');
  });

  it('ignores SVG titles in icon controls', () => {
    expect(visibleTextOf(root('<svg><title>Settings</title></svg>Visible'))).toBe('Visible');
  });

  it('returns no text for a hidden root', () => {
    const element = root('Hidden');
    element.hidden = true;
    expect(visibleTextOf(element)).toBe('');
  });

  it('falls back to textContent without a document view', () => {
    const detachedDocument = document.implementation.createHTMLDocument();
    const element = detachedDocument.createElement('div');
    element.innerHTML = 'Fallback <span hidden>text</span>';
    expect(visibleTextOf(element)).toBe('Fallback text');
  });
});
