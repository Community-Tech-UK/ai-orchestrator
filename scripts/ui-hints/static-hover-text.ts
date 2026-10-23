import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { unwrap } from './template-sources';
import type { TemplateSource } from './types';

/** Read source, never import/execute it. Only exported immutable string literals cross folder boundaries. */
export function importedHoverLiteral(file: string, name: string, source: TemplateSource, files: ts.SourceFile[]): string | undefined {
  const root = resolve(dirname(source.sourceFile.fileName), ...source.ownerFile.split('/').slice(1).map(() => '..'), 'src');
  const path = relative(root, file);
  if (path.startsWith('..') || !file.endsWith('.ts') || !existsSync(file)) return undefined;
  const module = files.find(module => module.fileName === file)
    ?? ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of module.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
      || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const declaration = statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
    const value = declaration?.initializer && unwrap(declaration.initializer);
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
  }
  return undefined;
}

/** Fold only known strings and literal replaceAll calls; arbitrary methods remain unreadable. */
export function staticHoverText(node: ts.Expression, copy: Record<string, string>, depth = 0): string | undefined {
  if (depth > 16) return undefined;
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isCallExpression(node)) return undefined;
  if (ts.isIdentifier(node.expression) && ['copy', 'copyFor'].includes(node.expression.text) && node.arguments.length === 1) {
    const key = node.arguments[0]!;
    return ts.isStringLiteral(key) ? copy[key.text] : undefined;
  }
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'replaceAll' || node.arguments.length !== 2) return undefined;
  const [search, replacement] = node.arguments;
  if (!search || !replacement || !ts.isStringLiteral(search) || !ts.isStringLiteral(replacement)) return undefined;
  const text = staticHoverText(node.expression.expression, copy, depth + 1);
  // Bound allocation, including empty-search insertions, before doing the replacement.
  if (text === undefined || (text.length + 1) * (replacement.text.length + 1) > 65_536) return undefined;
  return text.replaceAll(search.text, replacement.text);
}
