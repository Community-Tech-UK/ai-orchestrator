import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { analyze } from '../ui-hints/analyze';
import { runCheck } from '../ui-hints/cli';
import { measure, readBaseline } from '../ui-hints/baseline.js';
import { fixtureTree } from './ui-hints-fixtures';
import { checkLedger, recordNew } from '../ui-hints/wording-ledger.js';
import { avoidWordReports } from '../ui-hints/glossary-report';
import { AVOID_WORD_PATTERNS } from '../../src/shared/glossary/glossary';

describe('record integrity and review comparison', () => {
  it('refuses missing or malformed records rather than quietly dropping protection', () => {
    const tree = fixtureTree('Visible');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json');
    const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0);
      expect(runCheck(args).output).toContain('Missing wording ledger');
      tree.file('ledger.json', '[]');
      tree.file('baseline/app.json', '{"rules":{},"markers":{},"unreadable":{},"extra":1}');
      expect(runCheck(args).output).toContain('malformed baseline');
      tree.file('baseline/app.json', '{"rules":{},"markers":{},"unreadable":{}}'); tree.file('ledger.json', 'null');
      expect(runCheck(args).output).toContain('malformed wording ledger');
    } finally { tree.cleanup(); }
  });
  it('against ref blocks hand-raised baseline numbers, removed/edited wording, and lists retirement reasons', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json');
    const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    const git = (...args: string[]) => spawnSync('git', args, { cwd: tree.root, encoding: 'utf8' });
    const reason = 'The backdrop scrim closes the dialog when it is clicked.';
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      expect(git('init', '-q').status).toBe(0); expect(git('add', '.').status).toBe(0);
      expect(git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture baseline').status).toBe(0);
      expect(runCheck([...args, '--against', 'HEAD']).exitCode).toBe(0);
      tree.write('<button title="Delete all conversation history">Delete</button><button aria-label="Close" data-ui-hints-exempt="backdrop">×</button>');
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop', '--reason', reason, '--tighten']).exitCode).toBe(0);
      const reviewed = runCheck([...args, '--against', 'HEAD']); expect(reviewed.exitCode).toBe(0); expect(reviewed.output).toContain('Marker review notice:');
      tree.write('<button title="Delete all conversation history">Delete</button>');
      expect(runCheck([...args, '--tighten']).exitCode).toBe(0);
      tree.write('<button title="Delete all conversation history">Delete</button><button title="Open">Open</button>');
      expect(runCheck([...args, '--init', '--force']).exitCode).toBe(0);
      expect(runCheck([...args, '--against', 'HEAD']).output).toContain('against: H2a new');
      tree.write('<button title="Delete all conversation history">Delete</button>'); expect(runCheck([...args, '--tighten']).exitCode).toBe(0);
      const original = JSON.parse(readFileSync(ledger, 'utf8'));
      tree.file('ledger.json', '[]'); expect(runCheck([...args, '--against', 'HEAD']).output).toContain('entry removed');
      tree.file('ledger.json', JSON.stringify([{ ...original[0], text: 'Delete history' }])); expect(runCheck([...args, '--against', 'HEAD']).output).toContain('words edited');
      tree.file('ledger.json', JSON.stringify(original));
      expect(runCheck([...args, '--retire', original[0].id, '--reason', 'This owning feature has been replaced after a wording review.']).exitCode).toBe(0);
      const retired = runCheck([...args, '--against', 'HEAD', '--json']); expect(retired.exitCode).toBe(0); expect(JSON.parse(retired.output).retirements).toHaveLength(1);
    } finally { tree.cleanup(); }
  });
  it('against ref demands a written reason for a raised marker', () => {
    const tree = fixtureTree('<button aria-label="Close">×</button>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json');
    const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    const git = (...gitArgs: string[]) => spawnSync('git', gitArgs, { cwd: tree.root, encoding: 'utf8' });
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      expect(git('init', '-q').status).toBe(0); expect(git('add', '.').status).toBe(0);
      expect(git('-c', 'user.name=UI Hints Test', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture baseline').status).toBe(0);
      const record = join(baseline, 'app.json');
      tree.file('baseline/app.json', readFileSync(record, 'utf8').replace('"markers": {}', '"markers": {\n    "backdrop": {\n      "' + tree.owner + '": { "count": 1, "reason": "unreviewed" }\n    }\n  }'));
      const raised = runCheck([...args, '--against', 'HEAD']);
      expect(raised.exitCode).toBe(1);
      expect(raised.output).toContain('raised marker needs a written reason');
    } finally { tree.cleanup(); }
  });
  it('a shortened warning can retire wording and tighten debt in one validated operation', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json'); const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      const id = JSON.parse(readFileSync(ledger, 'utf8'))[0].id;
      tree.write('<button appTooltip="Delete history">Delete</button>');
      expect(runCheck([...args, '--tighten']).exitCode).toBe(1);
      const beforeBaseline = readFileSync(join(baseline, 'app.json'), 'utf8'), beforeLedger = readFileSync(ledger, 'utf8');
      expect(runCheck([...args, '--tighten', '--retire', id, '--reason', 'short']).exitCode).toBe(1);
      expect(readFileSync(join(baseline, 'app.json'), 'utf8')).toBe(beforeBaseline); expect(readFileSync(ledger, 'utf8')).toBe(beforeLedger);
      expect(runCheck([...args, '--tighten', '--retire', id, '--reason', 'The redesigned control uses a reviewed inline confirmation.']).exitCode).toBe(0);
      expect(readBaseline(baseline).rules).toEqual({}); expect(JSON.parse(readFileSync(ledger, 'utf8'))[0].retired).toContain('reviewed');
    } finally { tree.cleanup(); }
  });
  it('a new backdrop exemption and its removed debt tighten together', () => {
    const tree = fixtureTree('<button aria-label="Close">×</button>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json'); const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    const reason = 'The backdrop scrim closes the dialog when it is clicked.';
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      tree.write('<button aria-label="Close" data-ui-hints-exempt="backdrop">×</button>');
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop']).exitCode).toBe(1);
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop', '--reason', reason, '--tighten']).exitCode).toBe(0);
      expect(readBaseline(baseline).rules).toEqual({}); expect(readBaseline(baseline).markers['backdrop']?.[tree.owner]).toEqual({ count: 1, reason });
    } finally { tree.cleanup(); }
  });
  it('marker command refuses a new marker if any independent rule goes up', () => {
    const tree = fixtureTree('<button aria-label="Close" appTooltip="Close">×</button>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json'); const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    try {
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      const record = join(baseline, 'app.json');
      const original = existsSync(record) ? readFileSync(record, 'utf8') : '';
      tree.write('<button aria-label="Close" data-ui-hints-exempt="backdrop">×</button><button></button>');
      expect(runCheck([...args, '--exempt', tree.owner, 'backdrop', '--reason', 'The backdrop scrim closes the dialog when it is clicked.']).output).toContain('another count went up');
      expect(existsSync(record) ? readFileSync(record, 'utf8') : '').toBe(original);
    } finally { tree.cleanup(); }
  });
  it('empty title suppression is ignored; title passthrough and HTML attribute fragments are surfaces', () => {
    const tree = fixtureTree('Visible');
    try {
      tree.file('src/renderer/app/service.ts', 'const part = ` title="${label}"`; function restore() { el.setAttribute("title", ""); el.setAttribute("title", previous); }');
      const surfaces = analyze(tree.root, {}).violations.filter(v => v.code === 'H11');
      expect(surfaces).toHaveLength(2); expect(surfaces.some(v => v.message.includes('HTML string'))).toBe(true);
    } finally { tree.cleanup(); }
  });
  it('report-only codes never enter records and never fail the gate', () => {
    const tree = fixtureTree('<button aria-label="Close" appTooltip="Dismiss">×</button><button [disabled]="!folder">Send</button><span>Worktree</span>');
    const baseline = join(tree.root, 'baseline'), ledger = join(tree.root, 'ledger.json'); const args = ['--root', tree.root, '--baseline', baseline, '--ledger', ledger];
    try {
      const analysis = analyze(tree.root, {});
      for (const code of ['H1c', 'H7', 'H8']) { expect(analysis.violations.some(v => v.code === code)).toBe(true); expect(measure(analysis).rules[code]).toBeUndefined(); }
      expect(runCheck([...args, '--init']).exitCode).toBe(0); expect(runCheck([...args, '--record-wording']).exitCode).toBe(0);
      expect(runCheck(args).exitCode).toBe(0); expect(readBaseline(baseline).rules).toEqual({});
    } finally { tree.cleanup(); }
  });
  it('template parse failure and independent extraction drift stop the gate', () => {
    const tree = fixtureTree('{{ \'<b>\' }}');
    try { expect(runCheck(['--root', tree.root, '--init']).output).toContain('H12'); }
    finally { tree.cleanup(); }
  });
  it('same-folder helpers calling copyFor resolve without unreadable debt', () => {
    const tree = fixtureTree('<button [appTooltip]="hover()">Close</button>', 'hover() { return helper(); }');
    try {
      tree.file(tree.owner, 'import { helper } from "./hints";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="hover()">Close</button>`}) class X { hover() { return helper(); } }');
      tree.file('src/renderer/app/hints.ts', 'import { copyFor } from "../shared/tooltip/tooltip-copy"; export function helper() { return copyFor("key.warning"); }');
      tree.file('src/renderer/app/tooltip-copy.ts', 'export const TOOLTIP_COPY = { "key.warning": { meaning: "Close session stops the agent and moves this thread to history" } };');
      const analysis = analyze(tree.root, {}); expect(analysis.counts['unreadable']).toBe(0);
      expect(recordNew(analysis, []).some(entry => entry.text.includes('stops'))).toBe(true);
      expect(checkLedger(analysis, recordNew(analysis, []))).toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('sees forbidden wording passed through visible component inputs, but not path spellings', () => {
    const tree = fixtureTree('<app-child subtitle="Selected instance"></app-child>');
    try {
      const analysis = analyze(tree.root, {});
      expect(analysis.vocabularyStreams[tree.owner]?.some(text => text.includes('Selected instance'))).toBe(true);
      expect(avoidWordReports(analysis.vocabularyStreams, AVOID_WORD_PATTERNS).length).toBeGreaterThan(0);
    } finally { tree.cleanup(); }
    const path = fixtureTree('<p>Open ~/.instance/plugins</p>');
    try {
      const analysis = analyze(path.root, {});
      expect(avoidWordReports(analysis.vocabularyStreams, AVOID_WORD_PATTERNS)).toEqual([]);
    } finally { path.cleanup(); }
  });
});
