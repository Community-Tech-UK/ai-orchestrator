import { ASTWithSource, Call, ImplicitReceiver, LiteralPrimitive, PropertyRead, RecursiveAstVisitor, ThisReceiver, parseTemplate, TmplAstRecursiveVisitor, tmplAstVisitAll, TmplAstText, TmplAstBoundText, TmplAstElement } from '@angular/compiler';
import { expressionText } from './hover-strings';
import type { Collection, Violation } from './types';
export interface GlossaryPattern { id: string; pattern: RegExp }

function tooltipTermIds(node: TmplAstElement): string[] {
  const ids: string[] = [];
  for (const input of node.inputs) {
    if (!['appTooltip', 'appIconButton'].includes(input.name)) continue;
    const ast = input.value instanceof ASTWithSource ? input.value.ast : input.value;
    class Visitor extends RecursiveAstVisitor {
      override visitCall(call: Call, context: unknown): void {
        const receiver = call.receiver;
        if (receiver instanceof PropertyRead && receiver.name === 'termTooltip' && (receiver.receiver instanceof ImplicitReceiver || receiver.receiver instanceof ThisReceiver)) {
          for (const arg of call.args) {
            const literal = arg instanceof ASTWithSource ? arg.ast : arg;
            if (literal instanceof LiteralPrimitive && typeof literal.value === 'string') ids.push(literal.value);
          }
        }
        super.visitCall(call, context);
      }
    }
    ast.visit(new Visitor());
  }
  return ids;
}

/** Advisory first authored use, in source order. No baseline count or gate. */
export function glossaryReports(collection: Collection, patterns: readonly GlossaryPattern[]): Violation[] {
  const reports: Violation[] = [];
  for (const source of collection.templates) {
    const seen = new Set<string>();
    class Visitor extends TmplAstRecursiveVisitor {
      private readonly marked: string[] = [];
      private check(text: string, line: number): void {
        for (const { id, pattern } of patterns) {
          pattern.lastIndex = 0;
          if (seen.has(id) || !pattern.test(text)) continue;
          seen.add(id);
          if (this.marked.includes(id)) continue;
          reports.push({ code: 'H8', ownerFile: source.ownerFile, file: source.file, line: source.firstLine + line, message: `First glossary use ${id} is not marked; use app-term.` });
        }
      }
      override visitElement(node: TmplAstElement): void {
        if (node.name === 'app-term') {
          const id = node.attributes.find(attribute => attribute.name === 'term')?.value;
          if (id) seen.add(id);
          return;
        }
        const depth = this.marked.length;
        this.marked.push(...tooltipTermIds(node));
        super.visitElement(node);
        this.marked.length = depth;
      }
      override visitText(node: TmplAstText): void { this.check(node.value, node.sourceSpan.start.line); }
      override visitBoundText(node: TmplAstBoundText): void { for (const fragment of expressionText(node.value).fragments) this.check(fragment, node.sourceSpan.start.line); }
    }
    const parsed = parseTemplate(source.text, source.file, { enableBlockSyntax: true, enableLetSyntax: true });
    if (!parsed.errors?.length) tmplAstVisitAll(new Visitor(), parsed.nodes);
  }
  return reports;
}
