import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// All 23 callers have migrated. Future native dialogs must fail this gate.
const allowlist: string[] = [];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|html)$/.test(path) && !/\.(spec|test)\.ts$/.test(path) ? [path] : [];
  });
}

function nativeSites(path: string, source: string): number[] {
  const hits: number[] = [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'confirm'
      && ts.isIdentifier(node.expression) && ['window', 'globalThis'].includes(node.expression.text)) {
      hits.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'confirm') {
      hits.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  if (path.endsWith('.ts')) visit(tree);
  // Inline Angular templates are string literals to TypeScript. Check those,
  // and external templates, without treating component methods as globals.
  const templates = path.endsWith('.html') ? [source] : [];
  const findTemplates = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'template'
      && (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))) {
      templates.push(node.initializer.text);
    }
    ts.forEachChild(node, findTemplates);
  };
  if (path.endsWith('.ts')) findTemplates(tree);
  for (const template of templates) {
    if (/\b(?:window|globalThis)\s*\.\s*confirm\b/.test(template)
      || (/(?<![\w.])confirm\s*(?:\?\.)?\s*\(/.test(template)
        && !path.endsWith('remote-browse-modal.component.ts'))) hits.push(0);
  }
  return hits;
}

describe('native confirmation ratchet', () => {
  it('rejects new native confirms and stale allowlist entries', () => {
    const actual = files(root).flatMap((path) => nativeSites(path, readFileSync(path, 'utf8'))
      .map((line) => `${relative(root, path)}:${line}`));
    expect(actual.filter((site) => !allowlist.includes(site))).toEqual([]);
    expect(allowlist.filter((site) => !actual.includes(site))).toEqual([]);
  });

  it('detects bare, optional and global native calls while ignoring component methods and comments', () => {
    expect(nativeSites('example.ts', 'confirm("x"); confirm?.("x"); window.confirm("x"); globalThis.confirm?.("x");')).toHaveLength(4);
    expect(nativeSites('example.ts', '// window.confirm("x")\nclass Dialog { confirm() {} run() { this.confirm(); } }')).toEqual([]);
    expect(nativeSites('example.html', '<button (click)="window.confirm(\'x\')"></button>')).toEqual([0]);
  });
});
