/**
 * The audit is a measuring instrument, and a measuring instrument that reports
 * a confident wrong number is worse than none. Both of its historical failure
 * modes are pinned here:
 *
 *  - it matched only a literal ` title="…"` and missed every Angular binding;
 *  - it ignored visible text, so a button labelled by its own content was
 *    reported as nameless;
 *  - it took a name from `<select>`/`<input>` content, from an interpolation's
 *    identifiers rather than what it renders, and never looked for an external
 *    or wrapping `<label>` — between them these hid the composer Send button,
 *    the app's most-used control, which had no accessible name at all.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  findMatchingClose,
  findTitledTags,
  hasAssociatedLabel,
  hasNamingAttribute,
  hasNativeTitle,
  hasTextualName,
  isInteractive,
  renderInterpolations,
  tagNameOf,
} = require_('./audit-native-titles.js') as {
  findMatchingClose: (source: string, tagEndIndex: number, tagName: string) => number;
  findTitledTags: (source: string) => { tag: string; line: number; endIndex: number }[];
  hasAssociatedLabel: (source: string, tag: string, tagStartIndex: number) => boolean;
  hasNamingAttribute: (tag: string) => boolean;
  hasNativeTitle: (tag: string) => boolean;
  hasTextualName: (source: string, endIndex: number, tagName: string) => boolean;
  isInteractive: (tag: string) => boolean;
  renderInterpolations: (inner: string) => string;
  tagNameOf: (tag: string) => string;
};

describe('hasNativeTitle', () => {
  // The regression that made the first published number wrong.
  it('catches every form a native title reaches the DOM in', () => {
    expect(hasNativeTitle('<button title="Close">')).toBe(true);
    expect(hasNativeTitle('<button [title]="tooltip()">')).toBe(true);
    expect(hasNativeTitle('<button [attr.title]="tooltip()">')).toBe(true);
    expect(hasNativeTitle('<button title="{{ label }}">')).toBe(true);
  });

  it('does not fire on an unrelated attribute that merely ends in title', () => {
    expect(hasNativeTitle('<button data-subtitle="x">')).toBe(false);
    expect(hasNativeTitle('<app-row [rowTitle]="x">')).toBe(false);
  });
});

describe('isInteractive', () => {
  it('recognises natively interactive tags', () => {
    for (const tag of ['<button>', '<a href="#">', '<input>', '<select>', '<textarea>']) {
      expect(isInteractive(tag), tag).toBe(true);
    }
  });

  // A nameless div-with-a-role is the case where the gap hurts most.
  it('recognises a role that makes a plain element interactive', () => {
    expect(isInteractive('<span role="button">')).toBe(true);
    expect(isInteractive('<div role="menuitem">')).toBe(true);
  });

  it('ignores genuinely non-interactive elements', () => {
    expect(isInteractive('<span>')).toBe(false);
    expect(isInteractive('<div class="chip">')).toBe(false);
  });
});

describe('hasNamingAttribute', () => {
  it('accepts every naming form used in this codebase', () => {
    expect(hasNamingAttribute('<button aria-label="Close">')).toBe(true);
    expect(hasNamingAttribute('<button [attr.aria-label]="label()">')).toBe(true);
    expect(hasNamingAttribute('<button aria-labelledby="x">')).toBe(true);
    // Angular accepts a plain property binding too; knowing only `[attr.…]`
    // under-reports named controls.
    expect(hasNamingAttribute('<button [aria-label]="label()">')).toBe(true);
    expect(hasNamingAttribute('<button [attr.aria-labelledby]="id()">')).toBe(true);
  });

  it('is false for a bare titled button', () => {
    expect(hasNamingAttribute('<button title="Close">')).toBe(false);
  });

  // A tooltip wires `aria-describedby` — a DESCRIPTION. A control named only by
  // its tooltip is still nameless, so this must not count.
  it('does not accept a tooltip as an accessible name', () => {
    expect(hasNamingAttribute('<button [appTooltip]="copy()">')).toBe(false);
  });
});

describe('renderInterpolations', () => {
  // The bug that hid the composer Send button: testing the raw source for
  // letters counts the identifier `armed` even though the rendered value is a
  // glyph.
  it('renders an interpolation of glyph literals as those glyphs, not the identifiers', () => {
    expect(renderInterpolations("{{ loopArmed() ? '↻' : '↑' }}")).not.toMatch(/[A-Za-z]/);
  });

  it('treats an expression with no literals as text, because it probably renders a label', () => {
    expect(renderInterpolations('{{ item.label }}')).toMatch(/[A-Za-z]/);
  });

  it('leaves ordinary text untouched', () => {
    expect(renderInterpolations('Add edge')).toBe('Add edge');
  });
});

describe('hasAssociatedLabel', () => {
  it('finds an external <label for> naming the control', () => {
    const html = '<label for="q" class="visually-hidden">Search</label>\n<input id="q" title="Search">';
    const tag = '<input id="q" title="Search">';
    expect(hasAssociatedLabel(html, tag, html.indexOf(tag))).toBe(true);
  });

  it('finds a wrapping <label>', () => {
    const html = '<label>Provider <select title="Pick"><option>a</option></select></label>';
    const tag = '<select title="Pick">';
    expect(hasAssociatedLabel(html, tag, html.indexOf(tag))).toBe(true);
  });

  // Per the accessible-name computation a <label> names only its FIRST
  // labelable descendant. Crediting the rest hides genuinely nameless controls
  // — `chat-detail.component.html` wraps an input and then two icon buttons.
  it('names only the first labelable descendant of a wrapping label', () => {
    const html = '<label>Folder <input id="p" title="Path"> '
      + '<button title="Choose folder">...</button></label>';
    const input = html.indexOf('<input');
    const button = html.indexOf('<button');

    expect(hasAssociatedLabel(html, '<input id="p" title="Path">', input)).toBe(true);
    expect(hasAssociatedLabel(html, '<button title="Choose folder">', button)).toBe(false);
  });

  it('is false once the wrapping label has closed', () => {
    const html = '<label for="x">X</label>\n<select title="Pick"><option>a</option></select>';
    const tag = '<select title="Pick">';
    expect(hasAssociatedLabel(html, tag, html.indexOf(tag))).toBe(false);
  });
});

describe('hasTextualName', () => {
  function check(html: string): boolean {
    const [tag] = findTitledTags(html);
    return hasTextualName(html, tag!.endIndex, tagNameOf(tag!.tag));
  }

  // The false-positive class: content already names the control.
  it('treats real words in the content as an accessible name', () => {
    expect(check('<button title="Add edge">Add edge</button>')).toBe(true);
    expect(check('<button title="Close all">Close All</button>')).toBe(true);
  });

  it('treats an interpolated label as a name', () => {
    expect(check('<a title="Go">{{ item.label }}</a>')).toBe(true);
  });

  // A lone glyph computing as the accessible name is exactly the bad outcome
  // this audit exists to surface, so it must NOT count as named.
  it('does not accept a lone glyph as a name', () => {
    expect(check('<button title="Remove">x</button>')).toBe(false);
    expect(check('<button title="Terminate">×</button>')).toBe(false);
    expect(check('<button title="Expand">›</button>')).toBe(false);
    expect(check('<button title="Restart">↻</button>')).toBe(false);
  });

  // A <select> is NOT named by its <option> text, and <input>/<textarea> have
  // no content at all. Treating option text as a name miscounts a genuinely
  // nameless control as fine.
  it('never takes a name from the content of select, input or textarea', () => {
    const select = '<select title="Scope"><option>{{ scopeLabel(s) }}</option></select>';
    const [tag] = findTitledTags(select);
    expect(hasTextualName(select, tag!.endIndex, 'select')).toBe(false);
    expect(hasTextualName('<input title="x">', 20, 'input')).toBe(false);
  });

  // A plain indexOf stops at the FIRST nested close tag, truncating the scan
  // before the real label. The common shape is an icon wrapper closing first.
  it('finds the name past a nested same-named element', () => {
    const html = '<div role="button" title="Open">'
      + '<div class="thumb"></div><span>Report.pdf</span></div>';
    const [tag] = findTitledTags(html);
    expect(hasTextualName(html, tag!.endIndex, 'div')).toBe(true);
  });

  it('still reports nameless when the nested content is only a glyph', () => {
    const html = '<div role="button" title="Close"><div class="icon"></div><span>×</span></div>';
    const [tag] = findTitledTags(html);
    expect(hasTextualName(html, tag!.endIndex, 'div')).toBe(false);
  });

  it('ignores nested markup when looking for text', () => {
    expect(check('<button title="Close"><span class="icon"></span></button>')).toBe(false);
    expect(check('<button title="Close"><span class="icon"></span>Close</button>')).toBe(true);
  });
});

describe('findMatchingClose', () => {
  it('counts depth rather than stopping at the first close', () => {
    const html = '<div title="x"><div></div>tail</div>';
    const open = html.indexOf('>') + 1;
    expect(findMatchingClose(html, open, 'div')).toBe(html.lastIndexOf('</div>'));
  });

  it('does not count a self-closing tag as a new level', () => {
    const html = '<div title="x"><div/>tail</div>';
    const open = html.indexOf('>') + 1;
    expect(findMatchingClose(html, open, 'div')).toBe(html.lastIndexOf('</div>'));
  });

  it('returns -1 when the element is never closed', () => {
    expect(findMatchingClose('<div title="x">tail', 15, 'div')).toBe(-1);
  });
});

describe('findTitledTags', () => {
  it('reports the source line so a finding is navigable', () => {
    const html = '<div>\n  <span>x</span>\n  <button title="Close">×</button>\n</div>';
    expect(findTitledTags(html)[0]?.line).toBe(3);
  });

  // SVG `<title>` is the correct way to name a graphic, not a defect.
  it('never reports an SVG title element', () => {
    expect(findTitledTags('<svg><title>Chart</title></svg>')).toEqual([]);
  });

  it('does not choke on a > inside an attribute value', () => {
    const html = '<button title="a > b" (click)="go()">x</button>';
    expect(findTitledTags(html)).toHaveLength(1);
  });
});
