import ts from 'typescript';
import { relative } from 'node:path';
import { normalizePath, type Violation, type Collection } from './types';
import { propertyName } from './template-sources';

export function outsideTemplate(root: string, collection: Collection): Violation[] {
  const violations: Violation[] = [];
  for (const file of collection.sourceFiles) {
    const ownerFile = normalizePath(relative(root, file.fileName));
    const add = (node: ts.Node, message: string): void => { violations.push({ code: 'H11', ownerFile, file: ownerFile, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, message }); };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ['template', 'templateUrl'].includes(propertyName(node.name) ?? '')) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'title' && !(ts.isStringLiteral(node.right) && !node.right.text)) add(node, 'title assignment outside a template');
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute' && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'title' && !(node.arguments[1] && ts.isStringLiteral(node.arguments[1]) && !node.arguments[1].text)) add(node, 'setAttribute title outside a template');
      if (ts.isPropertyAssignment(node) && ['title', '[title]', '[attr.title]'].includes(propertyName(node.name) ?? '') && ts.isObjectLiteralExpression(node.parent) && ts.isPropertyAssignment(node.parent.parent) && propertyName(node.parent.parent.name) === 'host') add(node, 'host title outside a template');
      if (ts.isDecorator(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'HostBinding' && node.expression.arguments.some(arg => ts.isStringLiteral(arg) && ['title', 'attr.title'].includes(arg.text))) add(node, 'HostBinding title outside a template');
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const text = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => span.literal.text).join('') : node.text;
        const matches = text.match(/(?:<[\w-]+\b[^>]*|^\s+)\btitle\s*=/g) ?? [];
        for (const _match of matches) add(node, 'HTML string title outside a template');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return violations;
}
