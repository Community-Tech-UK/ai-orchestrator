import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface VisibleErrorSite { key: string; line: number }

const ERROR_NAME = /\b(?:error|err|e)\b|\b(?:error|err)[A-Z]|\.error\b/;

/** Conservative source guard: raw error text belongs in diagnostic logs or Details. */
export function collectVisibleErrorSites(path: string, source: string): VisibleErrorSite[] {
  const sites: VisibleErrorSite[] = [];
  const add = (text: string, position: number) => sites.push({
    key: `${path}:${createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`,
    line: source.slice(0, position).split('\n').length,
  });
  if (path.endsWith('.html')) {
    for (const match of source.matchAll(/\{\{\s*(?:[A-Za-z_$][\w$]*\.)?(?:error|err|e)(?:(?:\?\.|\.)message)?\s*\}\}/g)) {
      add(match[0], match.index!);
    }
    return sites;
  }
  const mainSource = path.replace(/\\/g, '/').startsWith('src/main/');
  // Most files cannot contain either guarded expression. Avoid building their ASTs.
  // Escaped identifiers still get parsed, so this is only a performance filter.
  if (!source.includes('message') && !source.includes('${') && !source.includes('\\u')) return sites;
  if (mainSource && !/\b(?:content|emitSystemMessage|addErrorToOutput|emitErrorMessage)\b/.test(source)
    && !source.includes('\\u')) return sites;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const mainVisibleSink = (node: ts.Node): boolean => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isPropertyAssignment(parent) && parent.name.getText(tree).replace(/['"]/g, '') === 'content') return true;
      if (ts.isCallExpression(parent) && /(?:^|\.)(?:emitSystemMessage|addErrorToOutput|emitErrorMessage)$/.test(parent.expression.getText(tree))) {
        const content = parent.arguments[1];
        if (content && node.pos >= content.pos && node.end <= content.end) return true;
      }
      if (ts.isStatement(parent)) break;
    }
    return false;
  };
  const diagnosticOnly = (node: ts.Node): boolean => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isCallExpression(parent) && /^(?:console|logger|this\.logger)\./.test(parent.expression.getText(tree))) return true;
      if (ts.isStatement(parent)) break;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (!diagnosticOnly(node) && (!mainSource || mainVisibleSink(node))) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'message' && ERROR_NAME.test(node.expression.getText(tree))) {
        add(node.getText(tree), node.getStart(tree));
      } else if (ts.isTemplateSpan(node) && ts.isIdentifier(node.expression) && /^(?:error|err|e)$/.test(node.expression.text)) {
        add(node.getText(tree), node.getStart(tree));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
}

export function rendererSources(directory = 'src/renderer'): [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSources(path);
    return /\.(?:ts|html)$/.test(path) && !/\.(?:spec|test)\.ts$/.test(path)
      ? [[path, readFileSync(path, 'utf8')] as [string, string]] : [];
  });
}

export function presentationSources(): [string, string][] {
  return [...rendererSources(), ...rendererSources('src/main')];
}

// Bootstrap from committed source, never from the working tree. New work cannot grandfather itself.
if (process.argv.includes('--baseline-from-head') || process.argv.includes('--baseline-main-from-head')) {
  const main = process.argv.includes('--baseline-main-from-head');
  const paths = execFileSync('rtk', ['proxy', 'git', 'ls-files', main ? 'src/main' : 'src/renderer'], { encoding: 'utf8' }).trim().split('\n');
  const baseline: Record<string, number> = {};
  for (const path of paths.filter(path => /\.(?:ts|html)$/.test(path) && !/\.(?:spec|test)\.ts$/.test(path))) {
    const source = execFileSync('rtk', ['proxy', 'git', 'show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    for (const site of collectVisibleErrorSites(path, source)) baseline[site.key] = (baseline[site.key] ?? 0) + 1;
  }
  const target = main ? 'scripts/visible-main-error-baseline.json' : 'scripts/visible-error-baseline.json';
  writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n');
}
