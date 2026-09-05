#!/usr/bin/env node
/**
 * UX1/W3.3 — audit interactive controls that still rely on a native `title`.
 *
 * A native `title` is a poor tooltip: it cannot be styled, appears after an
 * unconfigurable ~1s delay, never appears on keyboard focus, and is announced
 * inconsistently. The migration to `[appTooltip]` is incremental, so this
 * reports the remaining surface rather than failing the build.
 *
 * Two distinct problems are reported separately, because they are not equally
 * bad:
 *
 *  - **blocking**: an interactive control whose ONLY name is a native `title`.
 *    A screen reader may announce nothing useful at all. These are the ones
 *    worth fixing first.
 *  - **advisory**: an interactive control that has an accessible name AND a
 *    native `title`. Not broken, just not migrated yet.
 *
 * Two correctness rules learned the hard way, because an audit that reports a
 * confident wrong number is worse than no audit:
 *
 *  1. **Angular bindings count.** `[title]="x"`, `[attr.title]="x"` and
 *     `title="{{ x }}"` are all native titles at runtime. An earlier version
 *     of this script matched only a literal ` title="…"` and silently missed
 *     over fifty controls.
 *  2. **Visible text is an accessible name — but only for the elements that
 *     take their name from content.** `<button title="Add edge">Add edge</button>`
 *     is already named by its content; a `<select>` is NOT named by its
 *     `<option>` text, and `<input>` has no content at all. A lone glyph
 *     (`×`, `›`, `↻`) is never a usable name.
 *  3. **An interpolation is only text if it renders text.** `{{ item.label }}`
 *     renders a label; `{{ armed() ? '↻' : '↑' }}` renders a glyph. Testing the
 *     raw source for letters counts the identifier `armed` as a name and hides
 *     a genuinely unnamed control — this is how the composer's Send button
 *     escaped an earlier version of this audit.
 *  4. **An external `<label for>` or a wrapping `<label>` names a control**,
 *     even though nothing on the tag itself says so.
 *
 * A tooltip is deliberately NOT treated as a name: `[appTooltip]` wires
 * `aria-describedby`, which is a description. A control whose only "name" is a
 * tooltip is still nameless.
 *
 * Deliberately NOT reported: `title` on non-interactive elements, settings-row
 * `title` object properties (a field, not an attribute), and SVG `<title>`
 * elements, which are the correct way to name a graphic.
 *
 * Usage:
 *   node scripts/audit-native-titles.js            # human summary
 *   node scripts/audit-native-titles.js --json     # machine-readable
 *   node scripts/audit-native-titles.js --strict   # exit 1 if any blocking
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'src', 'renderer');

/** Tags that are interactive by default. */
const INTERACTIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea'];

/** Roles that make a non-interactive tag interactive. */
const INTERACTIVE_ROLES = /role\s*=\s*["'](button|link|menuitem|tab|switch|checkbox|radio|option)["']/;

/**
 * Every way a native `title` reaches the DOM: a literal attribute, an Angular
 * property binding, an attribute binding, or an interpolation.
 */
const TITLE_ATTR = /(?:^|\s)(?:\[title\]|\[attr\.title\]|title)\s*=\s*(["'])/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.ts'))) {
      if (entry.name.endsWith('.spec.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

function tagNameOf(tag) {
  return /^<\s*([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase() ?? '';
}

/**
 * Does this opening tag look like an interactive control?
 * `role="button"` counts even on a `<span>`; that is exactly the case where a
 * missing accessible name hurts most.
 */
function isInteractive(tag) {
  if (INTERACTIVE_TAGS.includes(tagNameOf(tag))) return true;
  return INTERACTIVE_ROLES.test(tag);
}

/** Does the opening tag carry a native title in any of its four forms? */
function hasNativeTitle(tag) {
  return TITLE_ATTR.test(tag);
}

/**
 * An explicit naming attribute on the tag itself.
 *
 * `appTooltip` is deliberately absent: the directive wires `aria-describedby`,
 * a DESCRIPTION. A control named only by its tooltip is still nameless.
 */
function hasNamingAttribute(tag) {
  // Covers `aria-label=`, `[aria-label]=` and `[attr.aria-label]=` — Angular
  // accepts all three and an audit that knows only one of them under-reports.
  return /(?:^|\s)\[?(?:attr\.)?aria-label\]?\s*=/.test(tag)
    || /(?:^|\s)\[?(?:attr\.)?aria-labelledby\]?\s*=/.test(tag);
}

/** Elements whose accessible name never comes from their own content. */
const NAME_NOT_FROM_CONTENT = new Set(['input', 'select', 'textarea']);

/** Elements a `<label>` can implicitly name. */
const LABELABLE = /^<\s*(input|select|textarea|button|meter|output|progress)[\s/>]/i;

/**
 * Is this control named by a `<label for="id">` elsewhere, or by a `<label>`
 * wrapping it? Both are legitimate names that carry no attribute on the tag.
 *
 * The wrapping case is narrower than "inside a label". Per the HTML
 * accessible-name computation a `<label>` implicitly names only its FIRST
 * labelable descendant; later ones get nothing. `chat-detail.component.html`
 * has exactly this shape — a `<label>` wrapping an `<input>` and then two icon
 * buttons — and crediting the buttons hides a genuinely nameless control.
 */
function hasAssociatedLabel(source, tag, tagStartIndex) {
  const id = /(?:^|\s)id\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
  if (id && new RegExp(`<label[^>]*\\sfor\\s*=\\s*["']${id}["']`).test(source)) return true;

  const before = source.slice(0, tagStartIndex);
  const labelOpen = before.lastIndexOf('<label');
  if (labelOpen < 0 || labelOpen < before.lastIndexOf('</label>')) return false;

  // Inside a label — but only the first labelable descendant is named by it.
  return firstLabelableIndex(source, labelOpen) === tagStartIndex;
}

/** Index of the first labelable descendant after a `<label>` opening tag. */
function firstLabelableIndex(source, labelOpenIndex) {
  const scanFrom = source.indexOf('>', labelOpenIndex) + 1;
  const end = source.indexOf('</label>', scanFrom);
  const region = source.slice(scanFrom, end < 0 ? source.length : end);
  const re = /<[a-zA-Z][\w-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
  let match;
  while ((match = re.exec(region)) !== null) {
    if (LABELABLE.test(match[0])) return scanFrom + match.index;
  }
  return -1;
}

/**
 * Replace each `{{ … }}` with what it plausibly RENDERS. When the expression
 * contains quoted literals those are the rendered candidates; otherwise the
 * expression is assumed to render text.
 */
function renderInterpolations(inner) {
  return inner.replace(/\{\{([\s\S]*?)\}\}/g, (_full, expr) => {
    const literals = String(expr).match(/'([^']*)'|"([^"]*)"/g);
    if (!literals) return ' interpolatedText ';
    return ` ${literals.map((lit) => lit.slice(1, -1)).join(' ')} `;
  });
}

/**
 * Visible text between an opening tag and its matching close, with nested tags
 * stripped. Interpolations are kept — `{{ item.label }}` renders as a label.
 *
 * A lone glyph is deliberately NOT a name: `×` technically computes as the
 * accessible name of a close button, and that is precisely the bad outcome
 * this audit exists to surface.
 */
function hasTextualName(source, tagEndIndex, tagName) {
  if (!tagName || NAME_NOT_FROM_CONTENT.has(tagName)) return false;
  const closeIndex = findMatchingClose(source, tagEndIndex, tagName);
  if (closeIndex < 0) return false;
  const inner = renderInterpolations(source.slice(tagEndIndex, closeIndex))
    .replace(/<[^>]*>/g, ' ');
  return /[A-Za-z][A-Za-z0-9._-]/.test(inner);
}

/**
 * Index of the close tag that actually matches this opening tag, counting
 * depth.
 *
 * A plain `indexOf('</div')` stops at the FIRST nested close, which truncates
 * the scan window before the real label text. The common shape is an icon
 * wrapper closing first: `<div title=…><div class="thumb"></div><span>name
 * </span></div>` — naive matching sees only the empty thumbnail and calls the
 * control nameless.
 */
function findMatchingClose(source, tagEndIndex, tagName) {
  const re = new RegExp(`<(/?)${tagName}(?=[\\s/>])`, 'gi');
  re.lastIndex = tagEndIndex;
  let depth = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match[1] === '/') {
      if (depth === 0) return match.index;
      depth -= 1;
    } else if (!isSelfClosing(source, match.index)) {
      depth += 1;
    }
  }
  return -1;
}

/** Is the tag starting at `index` self-closing (`<tag ... />`)? */
function isSelfClosing(source, index) {
  const close = source.indexOf('>', index);
  return close > 0 && source[close - 1] === '/';
}

/** Opening tags carrying a native `title` (not an SVG `<title>` element). */
function findTitledTags(source) {
  const tags = [];
  const re = /<[a-zA-Z][\w-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const tag = match[0];
    // `<title>` elements are the correct way to name a graphic — skip them.
    if (tagNameOf(tag) === 'title') continue;
    if (!hasNativeTitle(tag)) continue;
    tags.push({
      tag,
      line: source.slice(0, match.index).split('\n').length,
      endIndex: match.index + tag.length,
    });
  }
  return tags;
}

function audit(scanDir = SCAN_DIR) {
  const blocking = [];
  const advisory = [];
  for (const file of walk(scanDir)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('title')) continue;
    for (const { tag, line, endIndex } of findTitledTags(source)) {
      if (!isInteractive(tag)) continue;
      const named = hasNamingAttribute(tag)
        || hasAssociatedLabel(source, tag, endIndex - tag.length)
        || hasTextualName(source, endIndex, tagNameOf(tag));
      const record = { file: path.relative(ROOT, file), line, snippet: tag.slice(0, 120) };
      if (named) advisory.push(record);
      else blocking.push(record);
    }
  }
  return { blocking, advisory };
}

module.exports = {
  audit,
  findMatchingClose,
  findTitledTags,
  firstLabelableIndex,
  hasAssociatedLabel,
  hasNamingAttribute,
  hasNativeTitle,
  hasTextualName,
  isInteractive,
  renderInterpolations,
  tagNameOf,
};

if (require.main === module) {
  const result = audit();
  const args = process.argv.slice(2);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const files = new Set([...result.blocking, ...result.advisory].map((r) => r.file));
    process.stdout.write(
      'Native-title audit (UX1)\n'
      + `  ${result.blocking.length} interactive control(s) with NO accessible name\n`
      + `  ${result.advisory.length} named but still using a native title\n`
      + `  across ${files.size} file(s)\n`,
    );
    for (const record of result.blocking.slice(0, 25)) {
      process.stdout.write(`  BLOCKING ${record.file}:${record.line}  ${record.snippet}\n`);
    }
    if (result.blocking.length > 25) {
      process.stdout.write(`  … and ${result.blocking.length - 25} more\n`);
    }
  }

  if (args.includes('--strict') && result.blocking.length > 0) process.exit(1);
}
