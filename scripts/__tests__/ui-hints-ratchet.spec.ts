import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyze } from '../ui-hints/analyze';
import { compare, compareBaselines, initBaseline, measure, serialize, tighten, transfer, type Baseline } from '../ui-hints/baseline.js';
import { runCheck } from '../ui-hints/cli';
import { evaluateFacts, reasonKey } from '../ui-hints/rules';
import { parseFacts } from '../ui-hints/template-facts';
import { fixtureTree, template } from './ui-hints-fixtures';
const empty = (): Baseline => ({ rules: {}, markers: {}, unreadable: {} });
describe('UI hints ratchet', () => {
  it('equal counts pass; fixes must tighten; new files start at zero', () => {
    const tree = fixtureTree('<button title="Close">×</button>');
    try {
      const baseline = measure(analyze(tree.root, {})); expect(compare(baseline, baseline)).toEqual([]);
      tree.write('<button appTooltip="Close" aria-label="Close">×</button>');
      const measured = measure(analyze(tree.root, {})); expect(compare(measured, baseline).every(finding => finding.kind === 'stale')).toBe(true);
      expect(tighten(measured, baseline)).toEqual(empty());
      expect(() => tighten(baseline, measured)).toThrow(/Cannot tighten/);
      expect(compare(baseline, empty()).some(finding => finding.kind === 'new' && finding.owner === tree.owner)).toBe(true);
      expect(compareBaselines(empty(), baseline).some(finding => finding.kind === 'new')).toBe(true);
    } finally { tree.cleanup(); }
  });
  it('owners survive inline/external movement and Windows slash spelling', () => {
    const tree = fixtureTree('<button><svg/></button>');
    try {
      const before = measure(analyze(tree.root, {}));
      tree.file(tree.owner, '@Component({templateUrl: "sample.component.html"}) class X {}');
      tree.file('src/renderer/app/sample.component.html', '<button><svg/></button>');
      expect(measure(analyze(tree.root, {}))).toEqual(before);
      const windows = structuredClone(before); windows.rules['H1a'] = { [tree.owner.replace(/\//g, '\\')]: 1 };
      expect(compare(before, windows)).toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('transfers only existing debt and leaves totals unchanged', () => {
    const baseline = { ...empty(), rules: { H1a: { 'src/renderer/a.ts': 2 } } };
    const moved = transfer(baseline, 'src/renderer/a.ts', 'src/renderer/b.ts', { rule: 'H1a', count: 1 });
    expect(moved.rules['H1a']).toEqual({ 'src/renderer/a.ts': 1, 'src/renderer/b.ts': 1 });
    expect(() => transfer(baseline, 'src/renderer/a.ts', 'src/renderer/b.ts', { count: 3 })).toThrow(/more debt/);
    expect(() => transfer(baseline, 'src/renderer/no.ts', 'src/renderer/b.ts')).toThrow(/No recorded/);
    expect(compareBaselines(baseline, moved).some(finding => finding.owner === 'src/renderer/b.ts')).toBe(true);
  });
  it('validates sorted keys, zero entries, unknown/report-only rules and monotone unreadable counts', () => {
    const bad = { rules: { H7: { 'src/renderer/z.ts': 0, 'src/renderer/a.ts': 1 }, NOPE: {} }, markers: {}, unreadable: {} };
    const kinds = compare(empty(), bad).map(finding => finding.kind);
    expect(kinds).toContain('unknown-rule'); expect(kinds).toContain('unsorted'); expect(kinds).toContain('zero-entry');
    const unreadable = { ...empty(), unreadable: { 'src/renderer/a.ts': 1 } };
    expect(() => tighten(unreadable, empty())).toThrow(); expect(tighten(empty(), unreadable)).toEqual(empty());
    expect(serialize(initBaseline(unreadable))).toMatch(/"src\/renderer\/a.ts": 1\n/);
  });
  it('unknown/unused markers fail; local-key suppresses only H5; exact hover reasons go stale', () => {
    const get = (text: string) => parseFacts(template(text)).facts;
    expect(evaluateFacts(get('<button data-ui-hints-exempt="unknown"></button>'), {}).some(v => v.code === 'H12')).toBe(true);
    expect(evaluateFacts(get('<button data-ui-hints-exempt="backdrop">Close</button>'), {}).some(v => v.message.includes('unused'))).toBe(true);
    const local = evaluateFacts(get('<button data-ui-hints-exempt="local-key" title="Close (Esc)">×</button>'), {});
    expect(local.some(v => v.code === 'H5')).toBe(false); expect(local.some(v => v.code === 'H1a')).toBe(true); expect(local.some(v => v.code === 'H2a')).toBe(true);
    const hosts = get('<span class="state" appTooltip="Details">Visible</span><span class="other" appTooltip="Details">Visible</span>');
    const reason = { [reasonKey(hosts[0]!)]: 'Visible state describes the hint' };
    expect(evaluateFacts(hosts, reason).filter(v => v.code === 'H4')).toHaveLength(1);
    expect(evaluateFacts(hosts.slice(1), reason).some(v => v.message.includes('stale'))).toBe(true);
  });
  it('CLI init refuses overwrite; tighten cannot raise; marker additions require --exempt', () => {
    const tree = fixtureTree('<button aria-label="Close" appTooltip="Close">×</button>');
    const baseline = join(tree.root, 'baseline.json'), ledger = join(tree.root, 'ledger.json');
    const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0);
      expect(runCheck([...args, '--init']).exitCode).toBe(1);
      expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      tree.write('<button aria-label="Close" data-ui-hints-exempt="backdrop">×</button>');
      expect(runCheck(args).output).toContain('marker:backdrop new');
      expect(runCheck([...args, '--tighten']).exitCode).toBe(1);
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop']).exitCode).toBe(0);
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop']).exitCode).toBe(1);
      expect(runCheck([...args, '--exempt', tree.owner, 'unknown']).exitCode).toBe(1);
      const saved = readFileSync(baseline, 'utf8');
      tree.write('<button aria-label="Close" data-ui-hints-exempt="backdrop">×</button><button></button>');
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop']).exitCode).toBe(1);
      expect(readFileSync(baseline, 'utf8')).toBe(saved);
    } finally { tree.cleanup(); }
  });
  it('three CLI processes produce valid JSON, fixture findings and strict failure hits', () => {
    const tree = fixtureTree('<button></button>');
    const baseline = join(tree.root, 'baseline.json'), ledger = join(tree.root, 'ledger.json');
    try {
      const run = (script: string, extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, '--root', tree.root, ...extra], { cwd: process.cwd(), encoding: 'utf8' });
      const audit = run('scripts/audit-ui-hints.ts', ['--json']); expect(audit.status).toBe(0); expect(JSON.parse(audit.stdout).counts.controls).toBe(1);
      const init = run('scripts/check-ui-hints.ts', ['--baseline', baseline, '--ledger', ledger, '--init', '--json']); expect(init.status).toBe(0); expect(JSON.parse(init.stdout).errors).toEqual([]);
      tree.file('ledger.json', '[]');
      tree.write('<button></button><button></button>');
      const check = run('scripts/check-ui-hints.ts', ['--baseline', baseline, '--ledger', ledger]); expect(check.status).toBe(1); expect(check.stdout).toContain('H1a new'); expect(check.stdout).toContain(tree.owner + ':');
    } finally { tree.cleanup(); }
  }, 20000);
});
