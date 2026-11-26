import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { analyze } from '../ui-hints/analyze';
import { runCheck } from '../ui-hints/cli';
import { compareBaselines, measure, readBaseline, transfer } from '../ui-hints/baseline.js';
import { fixtureTree } from './ui-hints-fixtures';

describe('strict shared form-field guard (October follow-ups 7f)', () => {
  it.each([false, true])('rejects unnamed fields in the real check, external=%s, without accepting recorded debt', external => {
    const tree = fixtureTree('<input aria-label="Search">');
    const args = ['--root', tree.root, '--baseline', join(tree.root, 'baseline'), '--ledger', join(tree.root, 'ledger.json')];
    try {
      expect(runCheck([...args, '--init', '--record-wording']).exitCode).toBe(0);
      const write = (html: string): void => {
        if (!external) tree.write(html);
        else {
          tree.file(tree.owner, '@Component({templateUrl: "sample.component.html"}) class X {}');
          tree.file('src/renderer/app/sample.component.html', html);
        }
      };
      write('\n<input placeholder="Search">');
      const failed = runCheck(args);
      expect(failed.exitCode).toBe(1);
      expect(failed.output).toContain('H13');
      expect(failed.output).toContain(external ? 'sample.component.html:2' : 'sample.component.ts:3');
      const before = readBaseline(join(tree.root, 'baseline'));
      expect(runCheck([...args, '--init', '--force']).exitCode).toBe(1);
      expect(readBaseline(join(tree.root, 'baseline'))).toEqual(before);
      write('<label for="search">Search</label><input id="search">');
      expect(runCheck(args).exitCode).toBe(0);
    } finally { tree.cleanup(); }
  });

  it('enables the same rule in real external and inline ESLint paths with source locations', async () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js' });
    const external = await eslint.lintText('\n<input placeholder="Search">', { filePath: 'src/renderer/app/field-probe.html' });
    const inline = await eslint.lintText("import { Component } from '@angular/core';\n@Component({selector: 'app-probe', template: `\n<input placeholder=\"Search\">`})\nexport class Probe {}", { filePath: 'src/renderer/app/field-probe.component.ts' });
    for (const [results, line] of [[external, 2], [inline, 3]] as const) {
      expect(results.flatMap(result => result.messages).filter(message => message.ruleId === 'ui-hints/form-field-needs-name'))
        .toEqual([expect.objectContaining({ line })]);
    }
  });

  it('records actual opaque controls per owner, rejects growth, and requires tightening on removal', () => {
    const tree = fixtureTree('<button><app-child/></button>');
    const args = ['--root', tree.root, '--baseline', join(tree.root, 'baseline'), '--ledger', join(tree.root, 'ledger.json')];
    try {
      expect(runCheck([...args, '--init', '--record-wording']).exitCode).toBe(0);
      const original = readBaseline(join(tree.root, 'baseline'));
      expect(original.rules['H14']).toEqual({ [tree.owner]: 1 });
      tree.write('<button><app-child/></button><button><app-child/></button>');
      expect(runCheck(args).output).toContain('H14 new');
      expect(runCheck([...args, '--tighten']).exitCode).toBe(1);
      const grown = measure(analyze(tree.root));
      expect(compareBaselines(original, grown).some(finding => finding.code === 'H14' && finding.kind === 'new')).toBe(true);
      tree.write('Visible');
      expect(runCheck(args).output).toContain('H14 stale');
      expect(runCheck([...args, '--tighten']).exitCode).toBe(0);
      expect(readBaseline(join(tree.root, 'baseline')).rules['H14']).toBeUndefined();
      expect(() => transfer(original, tree.owner, 'src/renderer/app/other.ts', { rule: 'H11' })).toThrow('No recorded debt');
    } finally { tree.cleanup(); }
  });

  it('uses the canonical reader for the whole renderer and holds unnamed fields at zero', () => {
    const analysis = analyze(process.cwd());
    expect(analysis.counts['unnamedFields']).toBe(0);
    expect(analysis.violations.filter(violation => violation.code === 'H13')).toEqual([]);
  }, 60_000);
});
