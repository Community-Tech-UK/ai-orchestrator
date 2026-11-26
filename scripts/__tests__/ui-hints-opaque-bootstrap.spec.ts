import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { runCheck } from '../ui-hints/cli';
import { emptyBaseline } from '../ui-hints/baseline';
import { fixtureTree } from './ui-hints-fixtures';

const opaque = '<button><app-child/></button>';
const noRule = `// H14 is planned, not enforced.
export const RULE_CATALOGUE = { H14: 'Future rule' };
export function evaluateFacts() { return []; }`;
const supportedRule = `export function evaluateFacts(facts) {
  const eligible = [];
  for (const fact of facts) if (isOpaqueControl(fact)) eligible.push('H14');
  return eligible;
}`;

function history(html: string, rules = noRule, external = false) {
  const tree = fixtureTree(html);
  // Every fixture owner lives under src/renderer/app, so the record is one `app` shard.
  const baseline = join(tree.root, 'baseline');
  const shard = join(baseline, 'app.json');
  const args = ['--root', tree.root, '--baseline', baseline, '--ledger', join(tree.root, 'ledger.json')];
  const git = (...values: string[]): string => execFileSync('git', values, { cwd: tree.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const record = (): void => { expect(runCheck([...args, '--init', '--force', '--record-wording']).exitCode).toBe(0); };
  if (external) {
    tree.file(tree.owner, '@Component({templateUrl: "sample.component.html"}) class X {}');
    tree.file('src/renderer/app/sample.component.html', html);
  }
  tree.file('scripts/ui-hints/rules.ts', rules);
  record();
  // The base always carries a record, even an empty one (a folder record writes no shard when empty).
  // Historical unsupported revisions had no H14 record, including when opaque controls existed.
  const old = existsSync(shard) ? JSON.parse(readFileSync(shard, 'utf8')) : emptyBaseline();
  if (rules === noRule) delete old.rules.H14;
  tree.file('baseline/app.json', JSON.stringify(old));
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture base');
  return { ...tree, args, record, git, check: () => runCheck([...args, '--against', 'HEAD']) };
}

describe('opaque rule first introduction against Git source', () => {
  it.each([false, true])('allows only the existing per-owner inventory, external=%s', external => {
    const tree = history(opaque, noRule, external);
    try {
      tree.record();
      expect(tree.check()).toEqual(expect.objectContaining({ exitCode: 0 }));
    } finally { tree.cleanup(); }
  });

  it('rejects actual growth even when the current baseline is raised to match', () => {
    const tree = history(opaque);
    try {
      tree.write(opaque + opaque);
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`against: H14 new ${tree.owner} 1 -> 2`);
    } finally { tree.cleanup(); }
  });

  it('rejects transfers to another owner even when the global count stays equal', () => {
    const tree = history(opaque);
    try {
      tree.write('Visible');
      tree.file('src/renderer/app/other.component.ts', `@Component({template: ${JSON.stringify(opaque)}}) class Other {}`);
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('against: H14 new src/renderer/app/other.component.ts 0 -> 1');
    } finally { tree.cleanup(); }
  });

  it('does not accept a fabricated historical inventory from the new baseline', () => {
    const tree = history('Visible');
    try {
      tree.write(opaque);
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`against: H14 new ${tree.owner} 0 -> 1`);
    } finally { tree.cleanup(); }
  });

  it('treats a missing row as zero once the base implementation supports H14', () => {
    const tree = history('Visible', supportedRule);
    try {
      tree.write(opaque);
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`against: H14 new ${tree.owner} 0 -> 1`);
    } finally { tree.cleanup(); }
  });

  it.each([false, true])('does not accept invented inventory when the base has no baseline, supported=%s', supported => {
    const tree = history('Visible', supported ? supportedRule : noRule);
    try {
      unlinkSync(join(tree.root, 'baseline/app.json'));
      tree.git('add', 'baseline/app.json');
      tree.git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'no historical baseline');
      tree.write(opaque);
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`against: H14 new ${tree.owner} 0 -> 1`);
    } finally { tree.cleanup(); }
  });

  it('does not bootstrap a supported implementation whose historical record was deleted', () => {
    const tree = history(opaque, supportedRule);
    try {
      const old = JSON.parse(readFileSync(join(tree.root, 'baseline/app.json'), 'utf8'));
      delete old.rules.H14;
      tree.file('baseline/app.json', JSON.stringify(old));
      tree.git('add', 'baseline/app.json');
      tree.git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'missing historical row');
      tree.record();
      expect(tree.check().output).toContain(`against: H14 new ${tree.owner} 0 -> 1`);
    } finally { tree.cleanup(); }
  });

  it('fails closed on unreadable base templates and invalid revisions', () => {
    const tree = history(opaque);
    try {
      tree.file(tree.owner, '@Component({templateUrl: "missing.html"}) class X {}');
      tree.git('add', tree.owner);
      tree.git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'unreadable base');
      tree.write(opaque);
      tree.record();
      const unreadable = tree.check();
      expect(unreadable.exitCode).toBe(1);
      expect(unreadable.output).toContain('H12');
      expect(unreadable.output).toContain('missing templateUrl');
      expect(runCheck([...tree.args, '--against', 'does-not-exist']).exitCode).toBe(1);
    } finally { tree.cleanup(); }
  });

  it('keeps other rule increases protected during bootstrap', () => {
    const tree = history(opaque);
    try {
      tree.write(opaque + '<button title="Open">Open</button>');
      tree.record();
      const result = tree.check();
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('against: H2a new');
      expect(result.output).not.toContain('against: H14 new');
    } finally { tree.cleanup(); }
  });
});
