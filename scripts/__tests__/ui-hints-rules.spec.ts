import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { evaluateFacts } from '../ui-hints/rules';
import { parseFacts } from '../ui-hints/template-facts';
import { RULE_FIXTURES, template, fixtureTree } from './ui-hints-fixtures';
const rules = (html: string, copy: Record<string, string> = {}) => evaluateFacts(parseFacts(template(html), undefined, copy).facts, {});
describe('UI hint rules', () => {
  it.each(RULE_FIXTURES)('$code rejects the defect and accepts its nearest twin', fixture => {
    expect(rules(fixture.bad).some(violation => violation.code === fixture.code)).toBe(true);
    expect(rules(fixture.good).some(violation => violation.code === fixture.code)).toBe(false);
  });
  it.each(['⌘K', 'Cmd+K', 'Ctrl+K', '(Esc)', '(Enter)', 'Alt+Enter', 'Shift-click'])('H5 sees %s in static, binding, and resolved copy', shortcut => {
    for (const html of [`<button appTooltip="Open ${shortcut}">Open</button>`, `<button [appTooltip]="'Open ${shortcut}'">Open</button>`, '<button [appTooltip]="copy(\'key\')">Open</button>']) expect(rules(html, { key: 'Open ' + shortcut }).some(v => v.code === 'H5')).toBe(true);
    expect(rules(`<button>Open ${shortcut}</button>`).some(v => v.code === 'H5')).toBe(false);
  });
  it('H10 ignores event-only handlers and any role; iframe title is permitted', () => {
    expect(rules('<div (click)="$event.stopPropagation(); $event.preventDefault()"></div>').some(v => v.code === 'H10')).toBe(false);
    expect(rules('<div [attr.role]="role()" (click)="go()"></div>').some(v => v.code === 'H10')).toBe(false);
    expect(rules('<div role="dialog" (click)="go()"></div>').some(v => v.code === 'H10')).toBe(false);
    expect(rules('<iframe title="External site"></iframe>').some(v => v.code === 'H2c' || v.code === 'H2b')).toBe(false);
  });
  it('H6 ignores comments and follows split/spread dictionary entries and literal uses', () => {
    const tree = fixtureTree('<!-- "template.dead" --><button [appTooltip]="copyFor(key)">Open</button>');
    try {
      tree.file('src/renderer/app/tooltip-copy-more.ts', 'export const EXTRA_COPY = { "more.live": { meaning: "Open more controls" }};');
      tree.file('src/renderer/app/tooltip-copy.ts', 'import { EXTRA_COPY } from "./tooltip-copy-more"; export const TOOLTIP_COPY = { ...EXTRA_COPY, "template.dead": { meaning: "Remove all history" }, "key.dead": { meaning: "Delete all history" }, "key.live": { meaning: "Close session" }};');
      tree.file('src/renderer/app/uses.ts', '// "key.dead"\nconst keys = ["key.live", "more.live"];');
      const all = analyze(tree.root, {});
      expect(Object.keys(all.copyKeys)).toHaveLength(4);
      expect(all.violations.filter(v => v.code === 'H6').map(v => v.message)).toEqual(['unused copy key: template.dead', 'unused copy key: key.dead']);
    } finally { tree.cleanup(); }
  });
  it('H11 detects assignments, setAttribute, host metadata, HostBinding and HTML strings', () => {
    const tree = fixtureTree('Visible');
    try {
      tree.file('src/renderer/app/service.ts', 'class X { @HostBinding("attr.title") hover = "Open"; run() { button.title = "Open"; button.setAttribute("title", "Open"); } } const html = `<button title="Open">`; const meta = {host: {"[title]": "hover"}};');
      expect(analyze(tree.root, {}).violations.filter(v => v.code === 'H11')).toHaveLength(5);
    } finally { tree.cleanup(); }
  });
  it('H8 flags an unmarked first use and accepts <app-term> or termTooltip', () => {
    const h8 = (html: string): number => {
      const tree = fixtureTree(html);
      try { return analyze(tree.root, {}).violations.filter(v => v.code === 'H8' && v.message.includes('worktree')).length; }
      finally { tree.cleanup(); }
    };
    expect(h8('<span>Worktree</span>')).toBe(1);
    expect(h8('<app-term term="worktree">Worktree</app-term>')).toBe(0);
    expect(h8('<button [appTooltip]="termTooltip(\'worktree\')">Worktree</button>')).toBe(0);
    expect(h8('<span>Worktree</span><button [appTooltip]="termTooltip(\'worktree\')">Worktree</button>')).toBe(1);
    expect(h8('<button [appTooltip]="termTooltip(\'worktree\')">Go</button><span>Worktree</span>')).toBe(1);
  });
});
