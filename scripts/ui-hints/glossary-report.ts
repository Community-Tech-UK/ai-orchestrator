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

/**
 * Visible text (hover wording included) must not use an entry's `avoid` words:
 * a glossary entry declares what its concept is called, and what it is never
 * called. Failures are gate errors, not advisories.
 */
export function avoidWordReports(streams: Record<string, string[]>, patterns: readonly { word: string; pattern: RegExp }[]): string[] {
  const errors: string[] = [];
  for (const [owner, texts] of Object.entries(streams)) {
    for (const text of texts) {
      for (const { word, pattern } of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) errors.push(`avoid word "${word}" in visible text: ${owner} :: ${text.slice(0, 120)}`);
      }
    }
  }
  return errors.sort();
}

/** The short generated word list agents read. Regenerate with `npm run glossary:agents`. */
export function renderAgentGlossary(entries: readonly { label: string; plain: string; group: string; avoid?: readonly string[]; flag?: string }[]): string {
  const groups = [...new Set(entries.map(entry => entry.group))];
  const lines = ['# Agent vocabulary', '', 'Generated from `src/shared/glossary/glossary.ts` by `npm run glossary:agents`. Do not edit by hand.', '', 'Say what words mean, use these names, and never the avoid words.'];
  for (const group of groups) {
    lines.push('', `## ${group}`, '');
    for (const entry of entries.filter(entry => entry.group === group)) {
      lines.push(`- **${entry.label}** — ${entry.plain}${entry.avoid?.length ? ` Never: ${entry.avoid.map(word => `"${word}"`).join(', ')}.` : ''}${entry.flag ? ` Flag: ${entry.flag}` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}
