/**
 * UX3 regression guard: an icon-only control must offer a hover hint, not just
 * an `aria-label`.
 *
 * This exists because the tooltip rollout itself broke it. The Terminate button
 * in the instance row had `title="Terminate instance"` replaced with an
 * `aria-label` and nothing else, on the reading that house rule 2 ("never hide
 * a destructive consequence in a tooltip") meant the hover had to GO. It does
 * not: an `aria-label` is invisible to anyone not running a screen reader, so a
 * sighted mouse user was left with a bare `×` on an action that terminates a
 * session with no confirmation step — while every other icon in the same row
 * kept its hint. Removing a disclosure is not an accessibility improvement.
 *
 * Scope is deliberately the two templates this wave migrated. A repo-wide
 * version of this rule belongs in `scripts/audit-native-titles.js`, whose
 * published counts would change; that is a separate piece of work.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { hasTextualName, tagNameOf, findMatchingClose, isInteractive } = require_(
  '../../../../../scripts/audit-native-titles.js',
) as {
  hasTextualName: (source: string, tagEndIndex: number, tagName: string) => boolean;
  tagNameOf: (tag: string) => string;
  findMatchingClose: (source: string, tagEndIndex: number, tagName: string) => number;
  isInteractive: (tag: string) => boolean;
};

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** Templates migrated to `[appTooltip]` in Wave 3. */
const MIGRATED_TEMPLATES = [
  'src/renderer/app/features/instance-list/instance-row.component.html',
  'src/renderer/app/features/loop/loop-control.component.ts',
];

const TAG_RE = /<[a-zA-Z][\w-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;

function hasTooltip(tag: string): boolean {
  return /(?:^|\s)\[?appTooltip\]?\s*=/.test(tag) || /(?:^|\s)\[?appTooltipTpl\]?\s*=/.test(tag);
}

interface IconControl {
  file: string;
  line: number;
  tag: string;
}

function findIconOnlyButtonsWithoutTooltip(file: string): IconControl[] {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const offenders: IconControl[] = [];
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(source)) !== null) {
    const tag = match[0];
    if (tagNameOf(tag) !== 'button') continue;
    const endIndex = match.index + tag.length;
    // A button whose own content names it (e.g. "Skip round") is discoverable
    // without hovering; only glyph-only controls depend on the hint.
    if (hasTextualName(source, endIndex, 'button')) continue;
    if (hasTooltip(tag)) continue;
    offenders.push({ file, line: source.slice(0, match.index).split('\n').length, tag });
  }
  return offenders;
}

describe('icon-only controls keep a hover hint (UX3)', () => {
  for (const file of MIGRATED_TEMPLATES) {
    it(`has no glyph-only button without a tooltip in ${file}`, () => {
      const offenders = findIconOnlyButtonsWithoutTooltip(file);
      expect(
        offenders.map((o) => `${o.file}:${o.line} ${o.tag.replace(/\s+/g, ' ').slice(0, 90)}`),
      ).toEqual([]);
    });
  }

  // Guard the guard: if the detector silently stopped finding buttons, the
  // assertion above would pass vacuously on any template.
  it('actually inspects buttons rather than passing on an empty scan', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'src/renderer/app/features/instance-list/instance-row.component.html'),
      'utf8',
    );
    expect(source).toContain('<button');
    // The exact control the rollout regressed.
    expect(source).toMatch(/class="action-btn terminate"[\s\S]{0,200}?appTooltip=/);
  });
});

/**
 * The migration was reported complete on the strength of `grep 'title="'`,
 * which does not match Angular's `[title]="expr"` binding form. Four survived
 * in `loop-control.component.ts` under a claim of "zero native title=".
 *
 * Scoped to INTERACTIVE controls, matching `audit-native-titles.js`'s own
 * `isInteractive` and the actual defect: a native `title` never fires on
 * keyboard focus. Static status text cannot be focused, so `title` is a
 * legitimate description there — and on a bare `<span>` it is the only one,
 * since ARIA prohibits naming a roleless generic element. A component `@Input`
 * named `title` (e.g. `<app-prompt-modal [title]="…">`) is not a DOM attribute
 * and is likewise excluded.
 */
describe('interactive controls in migrated templates carry no native title (UX3)', () => {
  const KNOWN_COMPONENT_INPUTS = new Set(['app-prompt-modal']);

  for (const file of MIGRATED_TEMPLATES) {
    it(`has no native title attribute or binding in ${file}`, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const offenders: string[] = [];
      TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TAG_RE.exec(source)) !== null) {
        const tag = match[0];
        const name = tagNameOf(tag);
        if (name === 'title' || KNOWN_COMPONENT_INPUTS.has(name)) continue;
        if (!/(?:^|\s)\[?title\]?\s*=/.test(tag)) continue;
        if (!isInteractive(tag)) continue;
        offenders.push(`${file}:${source.slice(0, match.index).split('\n').length} <${name}>`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * `mouseenter` fires on an element and on every ancestor, so nested hosts each
 * open an overlay. The directive now resolves this innermost-wins, but a nested
 * pair is still almost always a mistake: it means one control has two competing
 * descriptions. The instance row shipped exactly that — a status dot inside the
 * leading indicator whose state the indicator's own tooltip already named.
 */
describe('migrated templates do not nest tooltip hosts (UX3)', () => {
  for (const file of MIGRATED_TEMPLATES) {
    it(`has no tooltip host inside another tooltip host in ${file}`, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const hosts: { start: number; end: number; name: string; line: number }[] = [];
      TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TAG_RE.exec(source)) !== null) {
        if (!hasTooltip(match[0])) continue;
        hosts.push({
          start: match.index,
          end: match.index + match[0].length,
          name: tagNameOf(match[0]),
          line: source.slice(0, match.index).split('\n').length,
        });
      }
      expect(hosts.length).toBeGreaterThan(0);

      const nested: string[] = [];
      for (const host of hosts) {
        const close = findMatchingClose(source, host.end, host.name);
        if (close < 0) continue;
        for (const other of hosts) {
          if (other === host) continue;
          if (other.start > host.end && other.start < close) {
            nested.push(`${file}:${other.line} nested inside <${host.name}> at line ${host.line}`);
          }
        }
      }
      expect(nested).toEqual([]);
    });
  }
});

/**
 * House rule 4: a tooltip may elaborate on visible text, but it may not be the
 * only carrier of a state. A non-interactive host that is neither focusable nor
 * `aria-label`led can only be read by hovering, so anything it alone says is
 * invisible to keyboard and screen-reader users.
 *
 * This is an exact-match allowlist rather than a heuristic on purpose. "Does the
 * element have visible text?" is the check that MISSED the remote-node badge —
 * its text is the node name whether the node is healthy or disconnected. Only a
 * human can judge whether the visible text conveys what the tooltip conveys, so
 * adding a host here has to be a deliberate act with a reason beside it.
 *
 * **Scope limit, stated because it has already bitten:** this guard only sees
 * elements that CARRY a tooltip. A state disclosed by CSS colour and a data
 * attribute with no tooltip at all is invisible to it — that is how the
 * completion-gate strip's done/blocked/pending shipped colour-only through
 * twelve gate passes. Colour-only state is the wider class; the strip's own
 * coverage lives in `loop-formatters.util.spec.ts`.
 */
describe('non-interactive tooltip hosts are hover-only only by decision (UX3)', () => {
  const ELABORATION_ONLY: Record<string, string> = {
    'approval-chip': 'visible text already reads "Awaiting approval"',
    'remote-badge': 'visible text carries " · offline" when disconnected',
    'diff-stats': 'visible text is the +N/-N counts themselves',
    'ls-pill': 'visible text is the status label',
    'ls-text': 'visible text is the metric numbers being explained',
    'lp-badge': 'visible text is the chip/badge wording being explained',
    'loop-gate': 'visible text is the gate step labels',
    'automation-clock': 'has an aria-label; listed for completeness',
    'leading-indicator': 'has an aria-label; listed for completeness',
    'unread-dot': 'has an aria-label; listed for completeness',
    'collapsed-badge': 'has an aria-label; listed for completeness',
  };
  const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);

  for (const file of MIGRATED_TEMPLATES) {
    it(`has no unlisted hover-only tooltip host in ${file}`, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const offenders: string[] = [];
      TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TAG_RE.exec(source)) !== null) {
        const tag = match[0];
        if (!hasTooltip(tag)) continue;
        if (INTERACTIVE.has(tagNameOf(tag))) continue;
        if (/aria-label/.test(tag) || /tabindex/.test(tag)) continue;
        const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
        const known = Object.keys(ELABORATION_ONLY).find((c) => cls.split(/\s+/).includes(c));
        if (known) continue;
        offenders.push(
          `${file}:${source.slice(0, match.index).split('\n').length} class="${cls}"`
          + ' — hover-only. Give it tabindex/aria-label, put the state in its visible'
          + ' text, or add it to ELABORATION_ONLY with a reason.',
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});
