import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyze } from '../ui-hints/analyze';
import { runAudit } from '../ui-hints/cli';
import { fixtureTree } from './ui-hints-fixtures';
import { glossaryReports } from '../ui-hints/glossary-report';
import { collectTemplates } from '../ui-hints/template-sources';
const real = analyze(process.cwd());
describe('real-tree measurement integrity', () => {
  it('has no leftover title bindings on shared heading components, including bound DOM titles', () => {
    expect(real.violations.filter(violation => violation.code === 'H2c')).toEqual([]);
  });
  it('has completed the whole-tree migration without hiding the measured population', () => {
    const strict = ['H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H3', 'H4', 'H5', 'H6', 'H9', 'H10', 'H12'];
    expect(real.violations.filter(violation => strict.includes(violation.code))).toEqual([]);
    expect(real.counts['controls']).toBeGreaterThan(1900);
    expect(real.counts['tooltips']).toBeGreaterThan(450);
    expect(real.counts['unreadable']).toBeLessThanOrEqual(78);
    expect(real.counts['titles']).toBe(1); // The review iframe retains its accessible document title.
    expect(real.violations.filter(violation => violation.code === 'H11')).toHaveLength(8);
    for (const code of ['H1c', 'H7', 'H8']) expect(real.violations.some(violation => violation.code === code)).toBe(true);
  });
  it('is non-vacuous and agrees with independent component/title/tooltip counts', () => {
    expect(real.counts['controls']).toBeGreaterThan(1000); expect(real.counts['tooltips']).toBeGreaterThan(50);
    expect(real.collection.templates.length).toBe(real.collection.componentCount);
    expect(real.violations.filter(v => v.code === 'H12')).toEqual([]);
    expect(real.counts['inert']).toBe(0);
    const rawTitles = real.collection.templates.reduce((sum, source) => sum + (source.text.replace(/<!--[\s\S]*?-->/g, '').match(/\s(?:title|\[title\]|\[attr.title\])\s*=/g) ?? []).length, 0);
    expect(real.counts['titles']).toBe(rawTitles);
  });
  it('keeps the migrated composer icons and the original canary named with real tooltips', () => {
    const missing = real.violations.filter(v => v.code === 'H1a' && v.ownerFile.includes('input-panel.component'));
    expect(missing).toEqual([]);
    const composerIcons = real.facts.filter(fact => fact.ownerFile.endsWith('input-panel.component.ts') && fact.iconOnly && !fact.hidden);
    expect(composerIcons.length).toBeGreaterThan(2);
    expect(composerIcons.every(fact => fact.name && fact.tooltip)).toBe(true);
    const canary = real.facts.filter(fact => fact.ownerFile.includes('instance-row.component') && fact.attributes.some(attribute => attribute.name === 'class' && attribute.text?.includes('terminate')));
    expect(canary).toHaveLength(1); expect(canary[0]?.tooltip).toBe(true); expect(canary[0]?.name).toBe(true);
    for (const owner of ['instance-row.component.ts', 'loop-control.component.ts']) expect(real.violations.filter(v => v.ownerFile.endsWith(owner) && ['H1a', 'H1b', 'H2a', 'H3', 'H4'].includes(v.code))).toEqual([]);
  });
  it('CLI JSON is parseable and exposes actual seeded violations', () => {
    const tree = fixtureTree('<button></button>');
    try { expect(analyze(tree.root).violations.some(violation => violation.code === 'H12')).toBe(false); const result = runAudit(['--root', tree.root, '--json']); expect(result.exitCode).toBe(0); const report = JSON.parse(result.output); expect(report.counts.controls).toBe(1); expect(report.violations.some((violation: { code: string }) => violation.code === 'H1a')).toBe(true); }
    finally { tree.cleanup(); }
  });
  it('first glossary uses are advisory, and a marked term precedes subsequent text', () => {
    const tree = fixtureTree('<span>Worktree</span><span>Worktree</span>');
    try {
      expect(glossaryReports(collectTemplates(tree.root), [{ id: 'worktree', pattern: /\bworktree\b/i }])).toHaveLength(1);
      tree.write('<app-term term="worktree"/><span>Worktree</span>');
      expect(glossaryReports(collectTemplates(tree.root), [{ id: 'worktree', pattern: /\bworktree\b/i }])).toEqual([]);
      expect(readFileSync('scripts/ui-hints/types.ts', 'utf8')).toContain("'H8'");
    } finally { tree.cleanup(); }
  });
});
