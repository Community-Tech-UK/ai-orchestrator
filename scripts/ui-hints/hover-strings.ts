import { AST, RecursiveAstVisitor, ASTWithSource, Call, ImplicitReceiver, PropertyRead, ThisReceiver, BindingPipe } from '@angular/compiler';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { type HoverText, type TemplateSource } from './types';
import { propertyName, unwrap } from './template-sources';
import { importedHoverLiteral, staticHoverText } from './static-hover-text';
import { sharedHelperText } from './shared-helper-text';

export interface ExpressionText { fragments: string[]; dynamic: boolean; calls: string[]; reads: string[]; projections: { root: string; path: string[] }[]; pipe: boolean }
export function expressionText(ast: AST): ExpressionText {
  const result: ExpressionText = { fragments: [], dynamic: false, calls: [], reads: [], projections: [], pipe: false };
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
    override visitPropertyRead(node: PropertyRead, context: unknown): void {
      const path: string[] = [];
      let receiver: AST = node;
      while (receiver instanceof PropertyRead) { path.unshift(receiver.name); receiver = receiver.receiver; }
      if (receiver instanceof ImplicitReceiver || receiver instanceof ThisReceiver) {
        const root = path.shift()!;
        result.reads.push(root);
        if (path.length) result.projections.push({ root, path });
        return;
      }
      super.visitPropertyRead(node, context);
    }
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
  const localFunctions = new Set(source.sourceFile.statements.filter(ts.isFunctionDeclaration).flatMap(declaration => declaration.name ? [declaration.name.text] : []));
  const imports = new Map<string, { file: string; exported: string }>();
  const angularInputs = new Set<string>();
  for (const statement of source.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const binding of statement.importClause.namedBindings.elements) {
      const exported = binding.propertyName?.text ?? binding.name.text;
      imports.set(binding.name.text, { file: resolve(dirname(source.sourceFile.fileName), statement.moduleSpecifier.text + '.ts'), exported });
      if (statement.moduleSpecifier.text === '@angular/core' && exported === 'input') angularInputs.add(binding.name.text);
    }
  }
  const visited = new Set<ts.Node>();
  const importedProjection = (name: string, path: string[]): string | undefined => {
    const imported = imports.get(name);
    return imported ? importedHoverLiteral(imported.file, imported.exported, source, files, path) : undefined;
  };
  const shadowsImport = (node: ts.Node, name: string): boolean => {
    for (let scope = node.parent; scope && scope !== source.component; scope = scope.parent) {
      if (!ts.isFunctionLike(scope)) continue;
      let found = false;
      const visit = (child: ts.Node): void => {
        if ((ts.isVariableDeclaration(child) || ts.isParameter(child) || ts.isBindingElement(child)
          || ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child))
          && child.name && ts.isIdentifier(child.name) && child.name.text === name) found = true;
        if (child !== scope && ts.isFunctionLike(child)) return;
        ts.forEachChild(child, visit);
      };
      visit(scope);
      if (found) return true;
    }
    return false;
  };
  const scan = (node: ts.Node, helperDepth: number): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (ts.isPropertyDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && imports.has(node.initializer.text)) resolveHelper(node.initializer.text, helperDepth);
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        const importedCallee = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
        if (ts.isIdentifier(importedCallee) && imports.has(importedCallee.text) && shadowsImport(child, importedCallee.text)) { unreadable = true; return; }
        // An input is runtime data. Only its default can author hover text;
        // generic types and input.required's alias options are not prose.
        const isInput = ts.isIdentifier(callee) && angularInputs.has(callee.text);
        const isRequiredInput = ts.isPropertyAccessExpression(callee) && callee.name.text === 'required'
          && ts.isIdentifier(callee.expression) && angularInputs.has(callee.expression.text);
        if (isInput || isRequiredInput) {
          const options = child.arguments[isInput ? 1 : 0];
          if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(property =>
            !ts.isPropertyAssignment(property) || propertyName(property.name) === undefined
              || ['transform', '__proto__'].includes(propertyName(property.name)!)))) unreadable = true;
          else if (isInput && child.arguments[0]) visit(child.arguments[0]);
          return;
        }
        const text = staticHoverText(child, copy);
        if (text !== undefined) { fragments.push(text); return; }
      }
      if (ts.isPropertyAccessExpression(child)) {
        const path: string[] = [];
        let root: ts.Expression = child;
        while (ts.isPropertyAccessExpression(root)) { path.unshift(root.name.text); root = root.expression; }
        if (ts.isIdentifier(root) && imports.has(root.text)) {
          if (helperDepth > 0 || shadowsImport(child, root.text)) { unreadable = true; return; }
          const literal = importedProjection(root.text, path);
          if (literal !== undefined) fragments.push(literal); else unreadable = true;
          return;
        }
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
        else if (name && localFunctions.has(name)) { unreadable = true; return; }
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
      const literal = importedHoverLiteral(imported.file, imported.exported, source, files, []);
      if (literal !== undefined) { fragments.push(literal); return true; }
    }
    const shared = imported ? sharedHelperText(imported.file, imported.exported, source) : undefined;
    if (shared) { fragments.push(...shared); return true; }
    if (!imported || depth > 0 || dirname(imported.file) !== dirname(source.sourceFile.fileName)) { unreadable = true; return false; }
    const file = files.find(file => file.fileName === imported.file);
    const declaration = file?.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === imported.exported)
      ?? file?.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === imported.exported);
    if (!declaration) { unreadable = true; return false; }
    scan(declaration, depth + 1);
    return true;
  };
  const projectedRoots = new Set<string>();
  for (const projection of parsed.projections) {
    const member = members.get(projection.root);
    const initializer = member && ts.isPropertyDeclaration(member) && member.initializer ? unwrap(member.initializer) : undefined;
    if (member && (!initializer || !ts.isIdentifier(initializer) || !imports.has(initializer.text))) continue;
    const name = initializer && ts.isIdentifier(initializer) ? initializer.text : projection.root;
    if (!imports.has(name)) continue;
    projectedRoots.add(projection.root);
    const literal = importedProjection(name, projection.path);
    if (literal !== undefined) fragments.push(literal); else unreadable = true;
  }
  for (const name of new Set([...parsed.calls, ...parsed.reads.filter(name => members.has(name) && !projectedRoots.has(name))])) {
    if (name === 'copy' || name === 'copyFor') continue;
    const member = members.get(name);
    if (member) scan(member, 0);
    else resolveHelper(name, 0);
  }
  return { channel, fragments: [...new Set(fragments)], dynamic: parsed.dynamic, unreadable };
}
