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
