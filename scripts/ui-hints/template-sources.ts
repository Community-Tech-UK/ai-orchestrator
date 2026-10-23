import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { normalizePath, type Collection } from './types';

export function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
}
export const isProductionTs = (file: string): boolean => file.endsWith('.ts') && !/\.(spec|test|bench)\.ts$/.test(file);
export function propertyName(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}
export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
export function collectTemplates(root: string): Collection {
  const files = walk(join(root, 'src/renderer'));
  const result: Collection = { templates: [], sourceFiles: [], errors: [], componentCount: 0 };
  const references = new Map<string, number>();
  const problem = (file: string, line: number, message: string): void => { result.errors.push({ code: 'H12', ownerFile: file, file, line, message }); };
  for (const file of files.filter(isProductionTs)) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    result.sourceFiles.push(sourceFile);
    const ownerFile = normalizePath(relative(root, file));
    // Independent lexical decorator count, stripping comments via TypeScript's scanner.
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    let withoutComments = '';
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      withoutComments += token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? '' : scanner.getTokenText();
    }
    result.componentCount += (withoutComments.match(/^\s*@Component\s*\(/gm) ?? []).length;
    const constants = new Map<string, ts.Expression>();
    const importAliases = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
      }
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const binding of statement.importClause.namedBindings.elements) importAliases.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
    }
    const readImports = (expression: ts.Expression, seen = new Set<string>()): string[] | undefined => {
      expression = unwrap(expression);
      if (ts.isIdentifier(expression)) {
        if (seen.has(expression.text)) return undefined;
        const constant = constants.get(expression.text);
        return constant ? readImports(constant, new Set([...seen, expression.text])) : undefined;
      }
      if (!ts.isArrayLiteralExpression(expression)) return undefined;
      const imports: string[] = [];
      for (const element of expression.elements) {
        if (ts.isIdentifier(element)) imports.push(importAliases.get(element.text) ?? element.text);
        else if (ts.isSpreadElement(element)) {
          const spread = readImports(element.expression, seen);
          if (!spread) return undefined;
          imports.push(...spread);
        } else return undefined;
      }
      return imports;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        for (const decorator of ts.getDecorators(node) ?? []) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || (importAliases.get(call.expression.text) ?? call.expression.text) !== 'Component') continue;
          const line = sourceFile.getLineAndCharacterOfPosition(decorator.getStart()).line + 1;
          const metadata = call.arguments[0];
          if (!metadata || !ts.isObjectLiteralExpression(metadata)) { problem(ownerFile, line, 'unanalysable @Component metadata'); continue; }
          const props = metadata.properties.filter(ts.isPropertyAssignment);
          const importsProp = props.find(prop => propertyName(prop.name) === 'imports');
          const imports = importsProp ? readImports(importsProp.initializer) : [];
          if (!imports) { problem(ownerFile, line, 'unanalysable component imports'); continue; }
          const template = props.find(prop => propertyName(prop.name) === 'template');
          const url = props.find(prop => propertyName(prop.name) === 'templateUrl');
          if (!!template === !!url) { problem(ownerFile, line, 'expected exactly one template or templateUrl'); continue; }
          const initializer = (template ?? url)!.initializer;
          if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) { problem(ownerFile, line, 'unanalysable non-literal template'); continue; }
          if (template) result.templates.push({ ownerFile, file: ownerFile, text: initializer.text, firstLine: sourceFile.getLineAndCharacterOfPosition(initializer.getStart()).line + 1, imports, sourceFile, component: node });
          else {
            const templateFile = resolve(dirname(file), initializer.text);
            references.set(templateFile, (references.get(templateFile) ?? 0) + 1);
            if (!existsSync(templateFile)) { problem(ownerFile, line, 'missing templateUrl: ' + initializer.text); continue; }
            result.templates.push({ ownerFile, file: normalizePath(relative(root, templateFile)), text: readFileSync(templateFile, 'utf8'), firstLine: 1, imports, sourceFile, component: node });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  for (const file of files.filter(file => file.endsWith('.html') && !file.endsWith('/index.html'))) {
    if (references.get(file) !== 1) problem(normalizePath(relative(root, file)), 1, 'HTML must be referenced by exactly one templateUrl');
  }
  if (result.templates.length !== result.componentCount) problem('src/renderer', 1, `measurement drift: ${result.templates.length} templates vs ${result.componentCount} @Component decorators`);
  return result;
}
