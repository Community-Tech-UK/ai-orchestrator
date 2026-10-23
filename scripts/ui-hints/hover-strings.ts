import { AST, RecursiveAstVisitor, ASTWithSource, Call, ImplicitReceiver, PropertyRead, ThisReceiver, BindingPipe } from '@angular/compiler';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { type HoverText, type TemplateSource } from './types';
import { propertyName } from './template-sources';
import { importedHoverLiteral, staticHoverText } from './static-hover-text';

export interface ExpressionText { fragments: string[]; dynamic: boolean; calls: string[]; reads: string[]; pipe: boolean }
export function expressionText(ast: AST): ExpressionText {
  const result: ExpressionText = { fragments: [], dynamic: false, calls: [], reads: [], pipe: false };
  class Visitor extends RecursiveAstVisitor {
    override visitBinary(node: Parameters<RecursiveAstVisitor['visitBinary']>[0], context: unknown): void {
      if (['+', '||', '??'].includes(node.operation)) node.left.visit(this, context);
      if (['+', '||', '??', '&&'].includes(node.operation)) node.right.visit(this, context);
    }
    override visitPrefixNot(): void { /* Boolean selectors do not author label text. */ }
    override visitConditional(node: Parameters<RecursiveAstVisitor['visitConditional']>[0], context: unknown): void { node.trueExp.visit(this, context); node.falseExp.visit(this, context); }
    override visitLiteralPrimitive(node: { value: unknown }): void { if (typeof node.value === 'string') result.fragments.push(node.value); }
    override visitTemplateLiteralElement(node: { text: string }): void { result.fragments.push(node.text); }
    override visitInterpolation(node: Parameters<RecursiveAstVisitor['visitInterpolation']>[0], context: unknown): void {
      result.fragments.push(...node.strings.filter(text => text.trim()));
      super.visitInterpolation(node, context);
    }
    override visitPropertyRead(node: PropertyRead, context: unknown): void { if (node.receiver instanceof ImplicitReceiver || node.receiver instanceof ThisReceiver) result.reads.push(node.name); super.visitPropertyRead(node, context); }
    override visitCall(node: Call, context: unknown): void {
      const receiver = node.receiver;
      if (receiver instanceof PropertyRead) {
        if (receiver.receiver instanceof ImplicitReceiver || receiver.receiver instanceof ThisReceiver) result.calls.push(receiver.name);
        else result.calls.push(receiver.receiver.toString() + '.' + receiver.name);
      } else result.calls.push('?');
      super.visitCall(node, context);
    }
    override visitPipe(node: BindingPipe, context: unknown): void { result.pipe = true; super.visitPipe(node, context); }
  }
  const actual = ast instanceof ASTWithSource ? ast.ast : ast;
  actual.visit(new Visitor());
  // The condition chooses text; it is not itself rendered text.
  class RenderedData extends RecursiveAstVisitor {
    override visitBinary(node: Parameters<RecursiveAstVisitor['visitBinary']>[0], context: unknown): void {
      if (['+', '||', '??'].includes(node.operation)) node.left.visit(this, context);
      if (['+', '||', '??', '&&'].includes(node.operation)) node.right.visit(this, context);
    }
    override visitPrefixNot(): void { /* Boolean results are not meaningful data names. */ }
    override visitPropertyRead(): void { result.dynamic = true; }
    override visitCall(): void { result.dynamic = true; }
    override visitPipe(): void { result.dynamic = true; }
    override visitConditional(node: Parameters<RecursiveAstVisitor['visitConditional']>[0], context: unknown): void { node.trueExp.visit(this, context); node.falseExp.visit(this, context); }
  }
  actual.visit(new RenderedData());
  return result;
}

export function hoverText(channel: string, ast: AST | undefined, text: string | undefined, source: TemplateSource, files: ts.SourceFile[], copy: Record<string, string>): HoverText {
  if (!ast) return { channel, fragments: text ? [text] : [], dynamic: false, unreadable: false };
  const parsed = expressionText(ast);
  const fragments: string[] = [];
  let unreadable = parsed.pipe;
  const add = (value: string): void => { fragments.push(copy[value] ?? value); };
  parsed.fragments.forEach(add);
  const members = new Map<string, ts.ClassElement>();
  for (const member of source.component.members) { const name = propertyName(member.name); if (name) members.set(name, member); }
  const imports = new Map<string, { file: string; exported: string }>();
  for (const statement of source.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const binding of statement.importClause.namedBindings.elements) imports.set(binding.name.text, {
      file: resolve(dirname(source.sourceFile.fileName), statement.moduleSpecifier.text + '.ts'), exported: binding.propertyName?.text ?? binding.name.text,
    });
  }
  const visited = new Set<ts.Node>();
  const scan = (node: ts.Node, helperDepth: number): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && imports.has(node.initializer.text)) resolveHelper(node.initializer.text, helperDepth);
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const text = staticHoverText(child, copy);
        if (text !== undefined) { fragments.push(text); return; }
      }
      if (ts.isBinaryExpression(child)) {
        const operator = child.operatorToken.kind;
        if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(operator)) visit(child.left);
        if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(operator)) visit(child.right);
        return;
      }
      if (ts.isPrefixUnaryExpression(child) && child.operator === ts.SyntaxKind.ExclamationToken) return;
      if (ts.isConditionalExpression(child)) { visit(child.whenTrue); visit(child.whenFalse); return; }
      if (ts.isIfStatement(child)) { visit(child.thenStatement); if (child.elseStatement) visit(child.elseStatement); return; }
      if (ts.isSwitchStatement(child)) { visit(child.caseBlock); return; }
      if (ts.isCaseClause(child)) { child.statements.forEach(visit); return; }
      if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) add(child.text);
      else if (ts.isTemplateExpression(child)) {
        add(child.head.text);
        for (const span of child.templateSpans) { visit(span.expression); add(span.literal.text); }
        return;
      }
      if (ts.isCallExpression(child)) {
        const name = ts.isIdentifier(child.expression) ? child.expression.text
          : ts.isPropertyAccessExpression(child.expression) && child.expression.expression.kind === ts.SyntaxKind.ThisKeyword ? child.expression.name.text : undefined;
        if (name === 'copy' || name === 'copyFor') { /* key literals below resolve registry text */ }
        else if (name && members.has(name)) scan(members.get(name)!, helperDepth);
        else if (name && imports.has(name) && !['computed', 'signal'].includes(name)) resolveHelper(name, helperDepth);
        else if (name && !['computed', 'signal'].includes(name) || ts.isPropertyAccessExpression(child.expression) && child.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) unreadable = true;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  const resolveHelper = (name: string, depth: number): boolean => {
    const imported = imports.get(name);
    if (imported && depth === 0) {
      const literal = importedHoverLiteral(imported.file, imported.exported, source, files);
      if (literal !== undefined) { fragments.push(literal); return true; }
    }
    if (!imported || depth > 0 || dirname(imported.file) !== dirname(source.sourceFile.fileName)) { unreadable = true; return false; }
    const file = files.find(file => file.fileName === imported.file);
    const declaration = file?.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === imported.exported)
      ?? file?.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === imported.exported);
    if (!declaration) { unreadable = true; return false; }
    scan(declaration, depth + 1);
    return true;
  };
  for (const name of new Set([...parsed.calls, ...parsed.reads.filter(name => members.has(name))])) {
    if (name === 'copy' || name === 'copyFor') continue;
    const member = members.get(name);
    if (member) scan(member, 0);
    else resolveHelper(name, 0);
  }
  return { channel, fragments: [...new Set(fragments)], dynamic: parsed.dynamic, unreadable };
}
