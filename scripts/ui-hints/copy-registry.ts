import ts from 'typescript';
import { propertyName, unwrap } from './template-sources';

export function readCopyRegistry(files: ts.SourceFile[]): { keys: Record<string, string>; owners: Record<string, string> } {
  const declarations = new Map<string, { expression: ts.Expression; file: ts.SourceFile }>();
  for (const file of files.filter(file => /(?:^|\/)tooltip-copy[^/]*\.ts$/.test(file.fileName))) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, { expression: node.initializer, file });
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const keys: Record<string, string> = {};
  const owners: Record<string, string> = {};
  const read = (expression: ts.Expression, file: ts.SourceFile, seen: Set<string>): void => {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return;
      const declaration = declarations.get(expression.text);
      if (declaration) read(declaration.expression, declaration.file, new Set([...seen, expression.text]));
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) { read(property.expression, file, seen); continue; }
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      const value = unwrap(property.initializer);
      if (!key || !ts.isObjectLiteralExpression(value)) continue;
      const parts: string[] = [];
      for (const field of value.properties) if (ts.isPropertyAssignment(field) && ['meaning', 'consequence'].includes(propertyName(field.name) ?? '')) {
        const literal = unwrap(field.initializer);
        if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) parts.push(literal.text);
      }
      if (parts.length) { keys[key] = parts.join(' '); owners[key] = file.fileName; }
    }
  };
  // Each split dictionary is meaningful, including one not yet spread into TOOLTIP_COPY.
  for (const [name, declaration] of declarations) if (/COPY/.test(name)) read(declaration.expression, declaration.file, new Set([name]));
  return { keys, owners };
}
