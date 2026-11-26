import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import type { TemplateSource } from '../ui-hints/types';

export function template(text: string, members = '', imports = ['AioTooltipDirective', 'AppIconButtonDirective']): TemplateSource {
  const ownerFile = 'src/renderer/app/sample.component.ts';
  const sourceFile = ts.createSourceFile('/fixture/' + ownerFile, `class Sample { ${members} }`, ts.ScriptTarget.Latest, true);
  const component = sourceFile.statements.find(ts.isClassDeclaration)!;
  return { text, ownerFile, file: ownerFile, firstLine: 1, imports, sourceFile, component };
}
export function fixtureTree(html: string, members = '', name = 'sample'): { root: string; owner: string; write: (text: string) => void; file: (path: string, text: string) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ui-hints-'));
  const owner = `src/renderer/app/${name}.component.ts`;
  const file = (path: string, text: string): void => { const absolute = join(root, path); mkdirSync(join(absolute, '..'), { recursive: true }); writeFileSync(absolute, text); };
  const write = (text: string): void => file(owner, `import { Component } from '@angular/core';\n@Component({ imports: [AioTooltipDirective, AppIconButtonDirective], template: ${JSON.stringify(text)} })\nexport class Sample { ${members} }`);
  write(html);
  return { root, owner, write, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export const RULE_FIXTURES = [
  { code: 'H1a', bad: '<button>{{ status === "ready" && "×" }}</button>', good: '<button appIconButton="Close">{{ status === "ready" && "×" }}</button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H1a', bad: '<button [attr.aria-label]="status === \'ready\' && \'×\'" appTooltip="Close">×</button>', good: '<button [attr.aria-label]="status === \'ready\' && \'Close\'" appTooltip="Close">×</button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H1a', bad: '<button>{{ status === "ready" ? "×" : "↻" }}</button>', good: '<button appIconButton="Close">{{ status === "ready" ? "×" : "↻" }}</button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H1a', bad: '<button [attr.aria-label]="status === \'ready\' ? \'×\' : \'↻\'" appTooltip="Close">×</button>', good: '<button [attr.aria-label]="status === \'ready\' ? \'Close\' : \'Refresh\'" appTooltip="Close">×</button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H1a', bad: '<div [attr.role]="\'button\'">×</div>', good: '<div [attr.role]="\'button\'" appIconButton="Close">×</div>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H2a', bad: '<div [attr.role]="ready ? \'button\' : \'link\'" title="Close">Close</div>', good: '<div [attr.role]="ready ? \'button\' : \'link\'" appTooltip="Close">Close</div>', lint: 'no-native-title' },
  { code: 'H1a', bad: '<button><svg/></button>', good: '<button aria-label="Close" appTooltip="Close"><svg/></button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H1b', bad: '<button aria-label="Close">×</button>', good: '<button aria-label="Close" appTooltip="Close">×</button>', lint: 'icon-control-needs-name-and-tooltip' },
  { code: 'H2a', bad: '<button title="Close">Close</button>', good: '<button appTooltip="Close">Close</button>', lint: 'no-native-title' },
  { code: 'H2b', bad: '<div title="Explanation">Visible</div>', good: '<div appTooltip="Explanation">Visible</div>', lint: 'no-native-title', all: true },
  { code: 'H2c', bad: '<app-empty-state title="Heading"/>', good: '<app-empty-state heading="Heading"/>', lint: 'no-native-title', all: true },
  { code: 'H3', bad: '<div title="Outer"><span title="Inner">Visible</span></div>', good: '<div><span title="Inner">Visible</span></div>' },
  { code: 'H4', bad: '<span appTooltip="Hidden state">Visible</span>', good: '<span appTooltip="Hidden state" tabindex="0">Visible</span>' },
  { code: 'H5', bad: '<button appTooltip="Open (⌘K)">Open</button>', good: '<button appTooltip="Open" appTooltipShortcut="palette">Open</button>', lint: 'no-hardcoded-shortcut' },
  { code: 'H10', bad: '<div (click)="open()">Open</div>', good: '<div role="button" (click)="open()">Open</div>' },
] as const;

/** Shared semantic boundaries for the canonical Angular reader and ESLint adapter. */
export const FIELD_NAME_FIXTURES = [
  { html: '<input aria-label="Search > projects">', named: true },
  { html: "<input aria-label='Search'>", named: true },
  { html: '<input aria-label="">', named: false },
  { html: '<input aria-label="   ">', named: false },
  { html: '<input data-aria-label="Search">', named: false },
  { html: '<input data-id="x"><label for="x">Search</label>', named: false },
  { html: '<!--<label for="x">Search</label>--><input id="x">', named: false },
  { html: '<input placeholder="Search" title="Search">', named: false },
  { html: '<label><input></label>', named: false },
  { html: '<label aria-label="Search"><input></label>', named: true },
  { html: '<label><span>Search</span><input></label>', named: true },
  { html: '<label>{{ label() }}<input></label>', named: true },
  { html: '<input id="search"><label for="search">Search</label>', named: true },
  { html: '<input id="search"><label for="search"></label>', named: false },
  { html: `<label [attr.for]="'x-' + id">Search</label><input [id]="'x-' + id">`, named: true },
  { html: `<label [attr.for]="'a b' + id">Search</label><input [id]="'ab' + id">`, named: false },
  { html: `<label [attr.for]="'x-' + id">Search</label><input [id]="'x-'  +  id">`, named: true },
  { html: `<label [attr.for]="'search'">Search</label><input id="search">`, named: true },
  { html: '<label for="field-{{ id }}">Search</label><input id="field-{{ id }}">', named: true },
  { html: '<input [attr.aria-label]="label()">', named: true },
  { html: `<input [attr.aria-label]="''">`, named: false },
  { html: '<span id="name">Search</span><input aria-labelledby="name">', named: true },
  { html: '<span id="name"></span><input aria-labelledby="name">', named: false },
  { html: '<input type="hidden">', named: true },
  { html: "<input type='hidden'>", named: true },
  { html: '<input data-type="hidden">', named: false },
  { html: "<label for='search'>Search</label><input id='search'>", named: true },
  { html: '<label data-for="search">Search</label><input id="search">', named: false },
  { html: '<label for="other">Search<input id="search"></label>', named: false },
  { html: '<label>Search<!-- no control here --></label><input>', named: false },
  { html: '@if (open) {<label>Search<input></label>}', named: true },
  { html: '@for (row of rows; track row.id) {<label [attr.for]="row.id">Search</label><input [id]="row.id">}', named: true },
  { html: '<span id="name" aria-label="Search"></span><input aria-labelledby="name">', named: true },
  { html: '<span id="a" aria-labelledby="b"></span><span id="b" aria-labelledby="a"></span><input aria-labelledby="a">', named: false },
  { html: '<select><option>Search</option></select>', named: false },
  { html: '<label>X<input></label>', named: true },
  { html: '<label [attr.for]="null">Search</label><input [attr.id]="null">', named: false },
  { html: '<span id="name"></span><span id="name">Search</span><input aria-labelledby="name">', named: false },
] as const;

export const FIELD_ASSOCIATION_FIXTURES = [
  { html: '<label for="x">Search</label><input id="x"><input id="x">', names: [true, false] },
  { html: '<label for="x">Search</label><div id="x"></div><input id="x">', names: [false] },
  { html: '<label>Search<input><input></label>', names: [true, false] },
  { html: '<label>Search<input type="hidden"><input></label>', names: [true, true] },
  { html: '<label>Search<button>Change</button><input></label>', names: [false] },
  { html: '<label for="x">Search</label><input id="x" type="hidden"><input id="x">', names: [true, false] },
  { html: '<label for="">Search<input></label>', names: [false] },
  { html: '<input [attr.aria-labelledby]="missingId">', names: [false] },
  { html: '<span [id]="nameId"></span><input [attr.aria-labelledby]="nameId">', names: [false] },
  { html: '<span [id]="nameId">Search</span><input [attr.aria-labelledby]="otherId">', names: [false] },
  { html: '<span [id]="nameId">Search</span><input [attr.aria-labelledby]="nameId">', names: [true] },
  { html: '<span id="name-{{ id }}">Search</span><input aria-labelledby="name-{{ id }}">', names: [true] },
  { html: '<span id="name-{{ id }}"></span><input aria-labelledby="name-{{ id }}">', names: [false] },
  { html: '<span [id]="nameId" [attr.aria-labelledby]="missingId"></span><input [attr.aria-labelledby]="nameId">', names: [false] },
  { html: '<label for="x">Search</label>@switch (mode) {@case (1) {<input id="x">} @case (2) {<input id="x">}}', names: [true, true] },
  { html: '<label for="x">Search</label>@if (mode) {<input id="x">} @else {<input id="x">}', names: [true, true] },
  { html: '<label for="x">Search</label>@if (a) {<input id="x">} @if (b) {<input id="x">}', names: [true, false] },
  { html: '<label>Search @if (mode) {<input>} @else {<input>}</label>', names: [true, true] },
  { html: '<label [attr.for]="null">Search<input></label>', names: [true] },
  { html: '<label [attr.for]="undefined">Search<input></label>', names: [true] },
  { html: '<label for=" ">Search<input></label>', names: [false] },
  { html: '<label [for]="null">Search</label><input [id]="null">', names: [true] },
  { html: '<label [for]="null">Search<input></label>', names: [false] },
  { html: '<label [htmlFor]="null">Search<input></label>', names: [false] },
  { html: `<label [htmlFor]="'other'">Search<input></label>`, names: [false] },
  { html: '<label for="null">Search</label><input [id]="null">', names: [true] },
  { html: '<label for="undefined">Search</label><input [id]="undefined">', names: [true] },
  { html: '<label for="0">Search</label><input [id]="0">', names: [true] },
  { html: '<label for="0">Search</label><input [attr.id]="0">', names: [true] },
  { html: '<label [for]="0">Search</label><input id="0">', names: [true] },
  { html: '<label [attr.for]="false">Search</label><input id="false">', names: [true] },
] as const;
