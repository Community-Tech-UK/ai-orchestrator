import { describe, expect, it } from 'vitest';
import { shouldDescribeHost } from './tooltip-policy';
import { visibleTextOf } from './tooltip-visible-text';

describe('tooltip accessible descriptions', () => {
  it('skips only empty text and exact normalized names', () => {
    expect(shouldDescribeHost(' close  PANEL ', 'Close panel')).toBe(false);
    expect(shouldDescribeHost('', 'Close')).toBe(false);
    expect(shouldDescribeHost(null, null)).toBe(false);
    expect(shouldDescribeHost('Session history', 'History')).toBe(true);
    expect(shouldDescribeHost('template', null)).toBe(true);
  });
});
describe('visibleTextOf', () => {
  it('omits hidden and accessible-only labels without losing visible descendants', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span style="display:none">Hidden</span><span class="sr-only">Accessible</span><span aria-hidden="true">Decorative</span><span>Visible <b>label</b></span>';
    document.body.append(el);
    expect(visibleTextOf(el)).toBe('Visible label');
    el.remove();
  });
  it('omits SVG titles and stylesheet-hidden labels', () => {
    const style = document.createElement('style'); style.textContent = '.hidden-tooltip-label { display: none; }'; document.head.append(style);
    const el = document.createElement('div'); el.innerHTML = '<svg><title>Icon description</title></svg><span class="hidden-tooltip-label">Hidden</span><span>Visible</span>';
    document.body.append(el); expect(visibleTextOf(el)).toBe('Visible'); el.remove(); style.remove();
  });
  it('falls back to text content without a window', () => {
    const doc = document.implementation.createHTMLDocument('Detached'); const el = doc.createElement('span'); el.textContent = 'Fallback';
    expect(visibleTextOf(el)).toBe('Fallback');
  });
  it('recognizes hidden ancestors', () => {
    const parent = document.createElement('div'); parent.style.display = 'none';
    const child = document.createElement('span'); child.textContent = 'Hidden'; parent.append(child);
    document.body.append(parent);
    expect(visibleTextOf(child)).toBe(''); parent.remove();
  });
});
