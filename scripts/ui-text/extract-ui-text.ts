/**
 * Inventory of the words a person can read on screen (Phase 3, step 8a).
 *
 * `npm run audit:ui-words` walks the app's TypeScript and Angular templates and lists every visible
 * string with the rules from `ui-text-rules.ts` applied. The guard spec uses the same functions, so
 * the count in a report and the count in the test cannot drift apart.
 *
 * Comments are excluded by construction (the TypeScript parser never yields them). Arguments of
 * `logger.*(`, `console.*(` and `getLogger(` are skipped, and so are import paths and property
 * names. Inline `template:` literals are read as HTML. The template reader is deliberately small;
 * Phase 4's compiler-based reader replaces it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export interface UiString {
  /** Path from the repository root, always with forward slashes. */
  file: string;
  line: number;
  text: string;
  kind: 'ts' | 'html';
}

export interface ScanResult {
  /** Every `.ts` and `.html` file the walk reached, counted before the pre-filter. */
  filesVisited: number;
  rendererFilesVisited: number;
  strings: UiString[];
  stringsScanned: number;
}

export const SCAN_ROOTS = ['src/renderer', 'src/shared', 'src/main', 'src/worker-agent', 'apps/mobile/src'] as const;

/** Files whose strings are written for a model, not for a person. Each entry says why. */
export const MODEL_FACING: readonly { test: RegExp; reason: string }[] = [
  { test: /\.prompts?\.ts$/, reason: 'prompt text sent to a model' },
  { test: /\/mcp\/.*(?:tools?|descriptions?)[^/]*\.ts$/, reason: 'tool descriptions read by a model' },
  { test: /\/mcp\/orchestrator-mcp-deferral\.ts$/, reason: 'tool descriptions and errors returned to the model' },
  { test: /\/internal-input-provenance\.ts$/, reason: 'prompt envelope the model reads' },
  { test: /\/approval-adjudicator\.ts$/, reason: 'prompt for the approval-checking model' },
  { test: /\/review-agents\//, reason: 'prompts for review agents' },
  { test: /\/loop-auto-unstick\.ts$/, reason: 'nudges addressed to the model' },
  { test: /\/deferred-permission-handler\.ts$/, reason: 'hook reasons returned to the model' },
];

const SKIPPED_DIRS = new Set(['node_modules', '__tests__', '__fixtures__', 'generated', 'dist']);
const SKIPPED_FILE = /\.(?:spec|test|fixture|stories|d)\.ts$/;
/** Cheap test on the raw text so only candidate files are parsed. */
const PREFILTER = /AIO|Orchestrator|orchestrator|nstance|hread|Waiting for|Thinking deeply|Awaiting input|Needs approval|Hibernat/;
/** A database statement is data, not text for a person. */
const SQL_STATEMENT = /^\s*(?:INSERT|CREATE|ALTER|DROP|SELECT|UPDATE|DELETE|PRAGMA|WITH)\b[\s\S]*\s/i;
const LOG_CALL = /(?:^|\.)(?:logger|log|console)\.[A-Za-z]+$|^getLogger$/;
const STATIC_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'appTooltip']);

export function isScannedPath(relativePath: string): boolean {
  if (SKIPPED_FILE.test(relativePath) || !/\.(?:ts|html)$/.test(relativePath)) return false;
  return !relativePath.split('/').some((part) => SKIPPED_DIRS.has(part));
}

export function isModelFacing(relativePath: string): boolean {
  return MODEL_FACING.some((entry) => entry.test.test(relativePath));
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function quotedLiterals(expression: string): string[] {
  return [...expression.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Text a person reads in an Angular template: text nodes, a few attributes and quoted literals in bindings. */
export function extractHtmlStrings(file: string, source: string, firstLine = 1): UiString[] {
  const found: UiString[] = [];
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const text = source.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(style|script)\b[\s\S]*?<\/\1>/g, blank);
  const add = (value: string, offset: number) => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (clean && /[\p{L}\p{N}]/u.test(clean)) found.push({ file, line: firstLine - 1 + lineOf(text, offset), text: clean, kind: 'html' });
  };
  const tag = /<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  let last = 0;
  const readText = (segment: string, start: number) => {
    for (const m of segment.matchAll(/\{\{([\s\S]*?)\}\}/g)) quotedLiterals(m[1]).forEach((lit) => add(lit, start + (m.index ?? 0)));
    const visible = segment
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .replace(/@(?:if|else if|for|switch|case|defer|placeholder|loading|error)\b[^{]*\{/g, ' ')
      .replace(/@(?:else|empty|default)\s*\{/g, ' ')
      .replace(/@let\b[^;]*;/g, ' ')
      .replace(/[{}]/g, ' ');
    add(visible, start + segment.length - segment.trimStart().length);
  };
  for (const match of text.matchAll(tag)) {
    const index = match.index ?? 0;
    readText(text.slice(last, index), last);
    last = index + match[0].length;
    for (const attr of match[0].matchAll(/([\[(]?[\w.:@-]+[\])]?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = attr[1];
      const value = attr[2] ?? attr[3] ?? '';
      const offset = index + (attr.index ?? 0);
      if (STATIC_ATTRIBUTES.has(name)) add(value.replace(/\{\{[\s\S]*?\}\}/g, ' '), offset);
      else if (name.startsWith('[') && !name.startsWith('[class') && !name.startsWith('[style')) quotedLiterals(value).forEach((lit) => add(lit, offset));
    }
  }
  readText(text.slice(last), last);
  return found;
}

/** Visible string literals in a TypeScript file, with comments, logging and module paths left out. */
export function extractTsStrings(file: string, source: string): UiString[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: UiString[] = [];
  const add = (node: ts.Node, text: string) => {
    if (text.trim() && !SQL_STATEMENT.test(text)) found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text, kind: 'ts' });
  };
  const isLiteral = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node) || ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (LOG_CALL.test(callee) || callee === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    }
    if (ts.isElementAccessExpression(node)) { visit(node.expression); return; }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sf).replace(/^['"`]|['"`]$/g, '');
      if (name === 'styles' || name === 'styleUrl') return;
      if (name === 'template' && isLiteral(node.initializer)) {
        const raw = node.initializer.getText(sf).slice(1, -1);
        const start = sf.getLineAndCharacterOfPosition(node.initializer.getStart(sf)).line + 1;
        found.push(...extractHtmlStrings(file, raw, start));
        return;
      }
      visit(node.initializer);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(join(directory, entry.name));
    } else yield join(directory, entry.name);
  }
}

export function scanUiText(repoRoot: string, roots: readonly string[] = SCAN_ROOTS): ScanResult {
  const result: ScanResult = { filesVisited: 0, rendererFilesVisited: 0, strings: [], stringsScanned: 0 };
  for (const root of roots) {
    let files: string[];
    try { files = [...walk(join(repoRoot, root))]; } catch { continue; }
    for (const path of files) {
      const rel = relative(repoRoot, path).split(sep).join('/');
      if (!isScannedPath(rel)) continue;
      result.filesVisited += 1;
      if (rel.startsWith('src/renderer/')) result.rendererFilesVisited += 1;
      if (isModelFacing(rel)) continue;
      const source = readFileSync(path, 'utf8');
      if (!PREFILTER.test(source)) continue;
      const strings = rel.endsWith('.html') ? extractHtmlStrings(rel, source) : extractTsStrings(rel, source);
      result.stringsScanned += strings.length;
      result.strings.push(...strings);
    }
  }
  return result;
}
