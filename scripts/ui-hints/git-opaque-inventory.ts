import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import ts from 'typescript';
import { collectTemplates, type TemplateReader } from './template-sources';
import { parseFacts } from './template-facts';
import { isOpaqueControl } from './rules';

const rulePath = 'scripts/ui-hints/rules.ts';

/** Inspect executable rule code, not comments, catalogue entries or baseline rows. */
function supportsOpaqueRule(text: string): boolean {
  const file = ts.createSourceFile(rulePath, text, ts.ScriptTarget.Latest, true);
  const evaluator = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'evaluateFacts');
  let supported = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === 'H14')) supported = true;
    ts.forEachChild(node, visit);
  };
  if (evaluator && ts.isFunctionDeclaration(evaluator) && evaluator.body) visit(evaluator.body);
  return supported;
}

/** Read tracked blobs without checking out, executing, or copying historical source. */
function gitSources(root: string, ref: string): Map<string, string> {
  const options = { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { ...options, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['ls-tree', '-rz', commit, '--', 'src/renderer', rulePath], { ...options, encoding: 'utf8' });
  const entries = tree.split('\0').filter(Boolean).flatMap(row => {
    const tab = row.indexOf('\t');
    const [mode, kind, oid] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    if (path !== rulePath && !/\.(?:ts|html)$/.test(path)) return [];
    if (kind !== 'blob' || !mode?.startsWith('100') || !oid) throw new Error('H12 unsupported historical source: ' + path);
    return [{ path, oid }];
  });
  const ids = [...new Set(entries.map(entry => entry.oid))];
  const blobs = new Map<string, string>();
  if (ids.length) {
    const output = execFileSync('git', ['cat-file', '--batch'], { ...options, input: ids.join('\n') + '\n' });
    let offset = 0;
    for (const id of ids) {
      const end = output.indexOf(10, offset);
      const [actual, kind, size] = output.subarray(offset, end).toString('utf8').split(' ');
      const length = Number(size);
      if (end < offset || actual !== id || kind !== 'blob' || !Number.isSafeInteger(length) || length < 0 || output[end + 1 + length] !== 10) throw new Error('H12 unreadable historical Git blob: ' + id);
      offset = end + 1;
      blobs.set(id, output.subarray(offset, offset + length).toString('utf8'));
      offset += length + 1;
    }
    if (offset !== output.length) throw new Error('H12 unexpected historical Git blob data');
  }
  return new Map(entries.map(entry => [resolve(root, entry.path), blobs.get(entry.oid)!]));
}

/** Undefined means H14 already ran at the base: its missing record remains zero. */
export function initialOpaqueInventory(root: string, ref: string): Record<string, number> | undefined {
  const sources = gitSources(root, ref);
  if (supportsOpaqueRule(sources.get(resolve(root, rulePath)) ?? '')) return undefined;
  const reader: TemplateReader = {
    files: directory => [...sources.keys()].filter(file => file.startsWith(directory + sep)).sort(),
    exists: file => sources.has(file),
    read: file => {
      const text = sources.get(file);
      if (text === undefined) throw new Error('H12 missing historical source: ' + file);
      return text;
    },
  };
  const collection = collectTemplates(root, reader);
  if (collection.errors.length) throw new Error(collection.errors.map(error => `H12 base ${error.file}:${error.line} ${error.message}`).join('\n'));
  const inventory: Record<string, number> = {};
  for (const source of collection.templates) {
    try {
      for (const fact of parseFacts(source, collection.sourceFiles).facts) {
        if (isOpaqueControl(fact)) inventory[fact.ownerFile] = (inventory[fact.ownerFile] ?? 0) + 1;
      }
    } catch (error) { throw new Error(`H12 base ${source.file}: ${String(error)}`, { cause: error }); }
  }
  return Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
