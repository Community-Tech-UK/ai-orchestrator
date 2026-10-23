import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parseFacts } from '../ui-hints/template-facts';
import { collectTemplates } from '../ui-hints/template-sources';
import { template, fixtureTree } from './ui-hints-fixtures';

const facts = (html: string) => parseFacts(template(html)).facts;
describe('Angular UI facts', () => {
  it.each(['&times;', '&#x2715;', '×', 'x', '{{ on ? "×" : "↻" }}', '@if (on) {<svg/>} @else {<svg/>}'])('finds icon-only content %s', content => { expect(facts('<button>' + content + '</button>')[0]?.iconOnly).toBe(true); });
  it.each(['', ' ', 'x', '×', '1', '💛'])('rejects junk aria-label %s', label => { expect(facts(`<button aria-label="${label}"><svg/></button>`)[0]?.name).toBe(false); });
  it('rejects conditional glyphs in bound accessible names', () => { expect(facts('<button [attr.aria-label]="on ? \'×\' : \'↻\'" appTooltip="Close">×</button>')[0]?.name).toBe(false); });
  it('excludes predicate literals, calls and reads from rendered expression text', () => {
    const source = template('<button [appTooltip]="state() === \'Delete all conversation history\' ? \'Close\' : \'Refresh\'">{{ status === "ready" ? "×" : "↻" }}</button>', 'state() { return "Delete all conversation history"; }');
    const fact = parseFacts(source).facts[0]!;
    expect(fact.name).toBe(false); expect(fact.iconOnly).toBe(true);
    expect(fact.hover[0]?.fragments).toEqual(['Close', 'Refresh']);
    const method = template('<button [appTooltip]="hover()">×</button>', 'hover() { return this.status === "Delete all conversation history" ? "Close" : "Refresh"; }');
    expect(parseFacts(method).facts[0]?.hover[0]?.fragments).toEqual(['Close', 'Refresh']);
  });
  it('finds titleless controls and separates data names', () => {
    expect(facts('<button><svg/></button>')[0]?.name).toBe(false);
    const bound = facts('<button [attr.aria-label]="label()"><svg/></button>')[0]!;
    expect(bound.name).toBe(true); expect(bound.dataName).toBe(true);
    const data = facts('<button>{{ item.label }}</button>')[0]!;
    expect(data.dataText).toBe(true); expect(data.iconOnly).toBe(false);
  });
  it('treats boolean predicates as selectors in same-class tooltip members', () => {
    const source = template('<button [appTooltip]="hover()">×</button>', 'hover() { return this.status === "Delete all conversation history" && "Close"; }');
    expect(parseFacts(source).facts[0]?.hover[0]?.fragments).toEqual(['Close']);
  });
  it.each(['<span class="sr-only">Close</span>', '<span class="visually-hidden">Close</span>', '<svg><title>Close</title></svg>', '<div><div></div></div>Close'])('recognises accessible content %s', content => { expect(facts('<button>' + content + '</button>')[0]?.name).toBe(true); });
  it('does not take title, placeholder or tooltip as names, or option text as an input name', () => {
    expect(facts('<button title="Close" appTooltip="Close" placeholder="Close">×</button>')[0]?.name).toBe(false);
    expect(facts('<select><option>Scope</option></select>')[0]?.name).toBe(false);
  });
  it.each(['<button>\n {{ label() }}\n</button>', '<button>{{ "(" + item.label + ")" }}</button>', '<button>{{ condition ? "×" : label() }}</button>'])('keeps rendered data distinct from choosing conditions %s', html => { expect(facts(html)[0]?.dataText).toBe(true); expect(facts(html)[0]?.iconOnly).toBe(false); });
  it('finds external and wrapping labels', () => {
    const all = facts('<input id="a"><label for="a">Scope</label><label>Message<textarea></textarea></label>');
    expect(all.filter(fact => fact.field).map(fact => fact.name)).toEqual([true, true]);
  });
  it('recursively sees every Angular control-flow region without duplicating *ngIf', () => {
    const all = facts('@if (x) {<button></button>} @else {<button></button>} @for (x of xs; track x) {<button></button>} @empty {<button></button>} @switch (x) {@case (1) {<button></button>} @default {<button></button>}} @defer {<button></button>} @placeholder {<button></button>} @loading {<button></button>} @error {<button></button>}<ng-template><button></button></ng-template><button *ngIf="x"></button>');
    expect(all.filter(fact => fact.tag === 'button')).toHaveLength(12);
  });
  it('ignores comments, decodes entities, keeps lines and catches all title forms', () => {
    const all = facts('<!-- <button title="Ignored"> -->\n<button title="a > b">&times;</button><button [title]="x"></button><button [attr.title]="null"></button><button title="{{ x }}"></button>');
    expect(all).toHaveLength(4); expect(all[0]?.line).toBe(2); expect(all.every(fact => fact.title)).toBe(true); expect(all[0]?.iconOnly).toBe(true);
    expect(facts('<svg><title>Chart</title></svg>').some(fact => fact.title)).toBe(false);
  });
  it('fails parse errors with file and line', () => { expect(() => facts("{{ '<b>' }}")).toThrow(/sample.component.ts:1/); });
  it('marks child components as opaque', () => { expect(facts('<button><app-child/></button>')[0]?.opaque).toBe(true); expect(facts('<button><app-child/></button>')[0]?.iconOnly).toBe(false); });
  it('uses both hidden attributes and imports for every tooltip provider', () => {
    expect(facts('<button aria-hidden="true" tabindex="-1"></button>')[0]?.hidden).toBe(true);
    expect(facts('<button aria-hidden="true"></button>')[0]?.hidden).toBe(false);
    expect(facts('<button tabindex="-1"></button>')[0]?.hidden).toBe(false);
    for (const provider of ['appTooltip', 'appTooltipTpl', 'appTooltipDisabledReason', 'appIconButton']) {
      const inert = parseFacts(template(`<button ${provider}="Close"></button>`, '', [])).facts[0]!;
      expect(inert.inert).toEqual([provider]); expect(inert.tooltip).toBe(false);
      expect(facts(`<button ${provider}="Close"></button>`)[0]?.tooltip).toBe(true);
    }
  });
  it('follows computed, getters, methods and same-folder helpers; external service/pipe calls are unreadable', () => {
    const source = template('<button [appTooltip]="closeTooltip()"></button>', 'closeTooltip = computed(() => this.child() ? "Close session stops this child agent and removes it" : "Close session moves this thread to history"); child = signal(false);');
    expect(parseFacts(source).facts[0]?.hover[0]?.fragments).toContain('Close session stops this child agent and removes it');
    const helper = ts.createSourceFile('/fixture/src/renderer/app/hints.ts', 'export function hint() { return "Delete all conversation history"; }', ts.ScriptTarget.Latest, true);
    const sf = ts.createSourceFile(source.sourceFile.fileName, 'import { hint } from "./hints"; class Sample { closeTooltip() { return hint(); } }', ts.ScriptTarget.Latest, true);
    const local = { ...source, sourceFile: sf, component: sf.statements.find(ts.isClassDeclaration)! };
    expect(parseFacts(local, [sf, helper]).facts[0]?.hover[0]?.fragments).toContain('Delete all conversation history');
    const getter = template('<button [title]="hover">×</button>', 'get hover() { return "Delete all conversation history"; }');
    expect(parseFacts(getter).facts[0]?.hover[0]?.fragments).toContain('Delete all conversation history');
    for (const expression of ['service.hint()', 'value | hint', 'unknown()']) expect(parseFacts(template(`<button [appTooltip]="${expression}"></button>`)).facts[0]?.hover[0]?.unreadable).toBe(true);
    expect(facts('<span [title]="item.label"></span>')[0]?.hover[0]?.unreadable).toBe(false);
  });
  it('reports missing/unreadable templates, orphan HTML and unreadable imports', () => {
    const tree = fixtureTree('Visible');
    try {
      tree.file(tree.owner, 'import { Component } from "@angular/core";\n@Component({template: dynamic, imports: factory()}) class X {}');
      tree.file('src/renderer/orphan.html', 'Orphan');
      expect(collectTemplates(tree.root).errors.map(error => error.message).join(' ')).toMatch(/unanalysable component imports/);
      expect(collectTemplates(tree.root).errors.map(error => error.message).join(' ')).toMatch(/exactly one templateUrl/);
      tree.file(tree.owner, '@Component({template: dynamic}) class X {}');
      expect(collectTemplates(tree.root).errors.some(error => error.message.includes('non-literal'))).toBe(true);
      tree.file(tree.owner, '@Component({templateUrl: "missing.html"}) class X {}');
      expect(collectTemplates(tree.root).errors.some(error => error.message.includes('missing'))).toBe(true);
    } finally { tree.cleanup(); }
  });
});
