import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { unwrap } from './template-sources';
import type { TemplateSource } from './types';

/** JSDoc tag a shared helper carries when the checker may read all the words it can say. */
export const HOVER_TEXT_TAG = 'hoverTextReadable';
const MAX_DECLARATIONS = 64;
const MAX_MODULE_DEPTH = 3;
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword,
]);

interface Module {
  file: string;
  functions: Map<string, ts.Node>;
  constants: Map<string, ts.Expression>;
  imports: Map<string, { file: string; exported: string } | null>;
}

/**
 * Reads, never runs, the words a pure helper under `src/shared` can put on screen. A helper such as
 * `providerName` or the session status presenter keeps its words in tables and calls other helpers, so
 * a component that shows its answer has no literal of its own to read.
 *
 * Every string the helper can say counts: the literals in the function it names, in the constants and
 * tables that function refers to, and in the shared helpers it calls, to a bounded depth. A table lookup
 * picks one value at run time, so each value is possible. Words that are only compared, thrown, used as
 * a table key or handed to a string method are not on screen and are not counted.
 *
 * Only a helper that says so is followed: its JSDoc carries `@hoverTextReadable`, the author's statement
 * that everything it can say is a literal in its own module. A data module such as the glossary holds
 * words that are never shown (the ones to avoid), so reading all of it would report words nobody sees.
 * The mark cannot hide anything: the reading is still done here, and a helper that reaches code that cannot
 * be read stays unreadable.
 *
 * Returns undefined, which leaves the hover unreadable, when the helper is not marked, is not a function
 * or table in `src/shared`, or reaches code that cannot be read: a package, a file outside `src/shared`, a
 * missing declaration, or more than the bound allows.
 */
export function sharedHelperText(file: string, exported: string, source: TemplateSource): string[] | undefined {
  const sourceRoot = resolve(dirname(source.sourceFile.fileName), ...source.ownerFile.split('/').slice(1).map(() => '..'), 'src');
  const sharedRoot = resolve(sourceRoot, 'shared');
  const modules = new Map<string, Module | null>();
  const fragments: string[] = [];
  const seen = new Set<ts.Node>();
  let readable = true;

  const load = (path: string): Module | null => {
    if (modules.has(path)) return modules.get(path)!;
    const inside = !relative(sharedRoot, path).startsWith('..') && path.endsWith('.ts');
    if (!inside || !existsSync(path)) { modules.set(path, null); return null; }
    const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const module: Module = { file: path, functions: new Map(), constants: new Map(), imports: new Map() };
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) module.functions.set(statement.name.text, statement);
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) module.constants.set(declaration.name.text, declaration.initializer);
        }
      } else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
        const bindings = statement.importClause.namedBindings;
        const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
        const target = specifier.startsWith('.') ? resolve(dirname(path), specifier + '.ts') : null;
        if (statement.importClause.name) module.imports.set(statement.importClause.name.text, null);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements.filter(element => !element.isTypeOnly)) {
            module.imports.set(binding.name.text, target ? { file: target, exported: binding.propertyName?.text ?? binding.name.text } : null);
          }
        } else if (bindings) module.imports.set(bindings.name.text, null);
      }
    }
    modules.set(path, module);
    return module;
  };

  const follow = (module: Module, name: string, depth: number): void => {
    const declaration = module.functions.get(name) ?? module.constants.get(name);
    if (declaration) {
      if (seen.has(declaration)) return;
      seen.add(declaration);
      if (seen.size > MAX_DECLARATIONS) { readable = false; return; }
      walk(declaration, module, depth);
      return;
    }
    if (!module.imports.has(name)) return; // a global such as Math or JSON, or a parameter
    const imported = module.imports.get(name);
    const target = imported && depth < MAX_MODULE_DEPTH ? load(imported.file) : null;
    if (!imported || !target) { readable = false; return; }
    follow(target, imported.exported, depth + 1);
  };

  const walk = (root: ts.Node, module: Module, depth: number): void => {
    const visit = (node: ts.Node): void => {
      if (!readable || ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isThrowStatement(node)) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.endsWith('Error')) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { fragments.push(node.text); return; }
      if (ts.isTemplateExpression(node)) {
        fragments.push(node.head.text);
        for (const span of node.templateSpans) { visit(span.expression); fragments.push(span.literal.text); }
        return;
      }
      if (ts.isIdentifier(node)) { follow(module, node.text, depth); return; }
      if (ts.isPropertyAccessExpression(node)) { visit(node.expression); return; }
      if (ts.isElementAccessExpression(node)) { visit(node.expression); return; }
      if (ts.isPropertyAssignment(node)) { visit(node.initializer); return; }
      if (ts.isShorthandPropertyAssignment(node)) { follow(module, node.name.text, depth); return; }
      if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return;
      if (ts.isConditionalExpression(node)) { visit(node.whenTrue); visit(node.whenFalse); return; }
      if (ts.isIfStatement(node)) { visit(node.thenStatement); if (node.elseStatement) visit(node.elseStatement); return; }
      if (ts.isCaseClause(node)) { node.statements.forEach(visit); return; }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
        // A string method on data (`id.startsWith('x')`) transforms text; its literal arguments are not shown.
        visit(node.expression);
        node.arguments.filter(argument => !ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)).forEach(visit);
        return;
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && !node.initializer) return;
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) { visit(node.initializer!); return; }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  const start = load(file);
  const target = start?.functions.get(exported) ?? (start?.constants.has(exported) ? unwrap(start.constants.get(exported)!) : undefined);
  // Only a function or a table can be followed. A constant that calls out (`service.names()`) cannot be read.
  const followable = target && (ts.isFunctionDeclaration(target) || ts.isArrowFunction(target) || ts.isFunctionExpression(target)
    || ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target));
  if (!start || !followable) return undefined;
  // The tag sits on the function itself, or on the statement of a constant function.
  if (!ts.getJSDocTags(target).some(tag => tag.tagName.text === HOVER_TEXT_TAG)) return undefined;
  follow(start, exported, 0);
  return readable ? [...new Set(fragments)] : undefined;
}
