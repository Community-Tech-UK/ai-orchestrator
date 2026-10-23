import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Linter, ESLint } from 'eslint';
import { RULE_FIXTURES } from './ui-hints-fixtures';
import { CONTROL_TAGS, FIELD_TAGS, INTERACTIVE_ROLES, EXEMPT_REASONS, TITLE_EXCEPTIONS, SHORTCUT_SOURCE } from '../ui-hints/types';
const require = createRequire(import.meta.url);
const parser = require('@angular-eslint/template-parser');
const plugin = require('../../eslint-rules/ui-hints.js');
function lint(html: string, rule: string, options?: object): Linter.LintMessage[] {
  return new Linter().verify(html, [{ files: ['**/*.html'], languageOptions: { parser }, plugins: { 'ui-hints': plugin }, rules: { ['ui-hints/' + rule]: options ? ['error', options] : 'error' } }], { filename: 'fixture.html' });
}
const icon = (html: string) => lint(html, 'icon-control-needs-name-and-tooltip');
describe('UI hint lint parity', () => {
  it.each(RULE_FIXTURES.filter(fixture => 'lint' in fixture))('$code matches bad and good shared reader fixtures', fixture => {
    const options = 'all' in fixture && fixture.all ? { scope: 'all' } : undefined;
    expect(lint(fixture.bad, fixture.lint, options)).toHaveLength(1);
    expect(lint(fixture.good, fixture.lint, options)).toHaveLength(0);
  });
  it('shares all independent syntax constants with the reader', () => { expect(plugin.constants).toEqual({ CONTROL_TAGS: [...CONTROL_TAGS], FIELD_TAGS: [...FIELD_TAGS], INTERACTIVE_ROLES: [...INTERACTIVE_ROLES], EXEMPT_REASONS: [...EXEMPT_REASONS], TITLE_EXCEPTIONS: [...TITLE_EXCEPTIONS], SHORTCUT_SOURCE }); });
  it.each(['<button>&times;</button>', '<button>@if (x) {<svg/>} @else {<svg/>}</button>', '<div role="button">×</div>', '<button aria-label="x" appTooltip="x">×</button>', '<button [attr.aria-label]="x ? \'×\' : \'↻\'" appTooltip="Close">×</button>'])('reports nameless %s', html => { expect(icon(html).map(message => message.messageId)).toEqual(['noName']); });
  it.each(['<button>@switch (x) {@case (1) {Open} @default {Close}}</button>', '<button>{{ item.label }}</button>', '<button>\n {{ label() }}\n</button>', '<button>{{ "(" + item.label + ")" }}</button>', '<button aria-label="Close" appTooltip="Close">×</button>', '<button><app-child/></button>', '<a>×</a>', '<button data-ui-hints-exempt="backdrop">×</button>', '<button aria-hidden="true" tabindex="-1">×</button>', '<button><svg><title>Close</title></svg></button>'])('accepts %s', html => { expect(icon(html)).toEqual([]); });
  it('reports missing tooltip, repeats once under structural wrappers, and local-key does not suppress names', () => {
    expect(icon('<button aria-label="Close">×</button>')[0]?.messageId).toBe('noTooltip');
    expect(icon('@for (x of xs; track x) {<button>×</button>}')).toHaveLength(1);
    expect(icon('<button *ngIf="x">×</button>')).toHaveLength(1);
    expect(icon('<button data-ui-hints-exempt="local-key">×</button>')).toHaveLength(1);
  });
  it.each(['title="Close"', '[title]="label"', '[attr.title]="label"', 'title="{{ label }}"'])('native title form %s is visible', attribute => { expect(lint(`<button ${attribute}>Close</button>`, 'no-native-title')).toHaveLength(1); });
  it('title scope skips media and SVG titles, and widens generic/component hosts', () => {
    expect(lint('<div title="Visible">Text</div>', 'no-native-title')).toEqual([]);
    expect(lint('<div title="Visible">Text</div>', 'no-native-title', { scope: 'all' })).toHaveLength(1);
    expect(lint('<iframe title="Site"></iframe><svg><title>Close</title></svg>', 'no-native-title', { scope: 'all' })).toEqual([]);
    expect(lint('<app-empty-state title="Heading"/>', 'no-native-title')).toEqual([]);
    expect(lint('<app-empty-state title="Heading"/>', 'no-native-title', { scope: 'all' })).toHaveLength(1);
  });
  it.each(['appTooltip="Open (⌘K)"', '[appTooltip]="\'Open Ctrl+K\'"', 'appTooltip="Open (Esc) {{ name }}"', '[appIconButton]="\'Close (Enter)\'"', 'appTooltipDisabledReason="Use Cmd+K"'])('shortcut form %s is visible', attribute => { expect(lint(`<button ${attribute}>Open</button>`, 'no-hardcoded-shortcut')).toHaveLength(1); });
  it('shortcut rule ignores visible text and only local-key suppresses it', () => {
    expect(lint('<button [appTooltip]="status === \'Ctrl+K\' ? \'Close\' : \'Refresh\'">Close</button>', 'no-hardcoded-shortcut')).toEqual([]);
    expect(lint('<button>Cmd+K for palette</button>', 'no-hardcoded-shortcut')).toEqual([]);
    expect(lint('<button data-ui-hints-exempt="local-key" appTooltip="Close (Esc)">Close</button>', 'no-hardcoded-shortcut')).toEqual([]);
  });
  it('real config applies to renderer HTML and inline virtual HTML, preserves TS locations, and excludes other roots', async () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js', overrideConfig: [{ files: ['src/renderer/**/*.html'], rules: { 'ui-hints/no-native-title': 'error' } }] });
    const inline = await eslint.lintText("import { Component } from '@angular/core';\n@Component({selector: 'app-probe', template: `<button title='Close'>Close</button>`})\nexport class Probe {}", { filePath: 'src/renderer/app/probe.component.ts' });
    const issue = inline.flatMap(result => result.messages).find(message => message.ruleId === 'ui-hints/no-native-title');
    expect(issue).toBeDefined(); expect(issue?.line).toBe(2); expect(issue?.column).toBeGreaterThan(1);
    const external = await eslint.lintText('<button title="Close">Close</button>', { filePath: 'src/renderer/app/probe.html' });
    expect(external[0]?.messages.some(message => message.ruleId === 'ui-hints/no-native-title')).toBe(true);
    const outside = await eslint.lintText('<button title="Close">Close</button>', { filePath: 'scripts/probe.html' });
    expect(outside[0]?.messages.some(message => message.ruleId?.startsWith('ui-hints/'))).toBe(false);
  });
});
