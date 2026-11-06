import { AST, ASTWithSource, Binary, BindingType, Conditional, Interpolation, LiteralPrimitive, ParenthesizedExpression, TemplateLiteral, TmplAstRecursiveVisitor, tmplAstVisitAll, type TmplAstNode } from '@angular/compiler';
import { TEXT_GAP } from './types';

const gap = ` ${TEXT_GAP} `;
const MAX_VARIANTS = 128;
// Bound path expansion; conservative fallback separates every segment rather than fabricating adjacency.
function combine(left: string[], right: string[]): string[] {
  if (left.length * right.length > MAX_VARIANTS) return [left.join(gap) + gap + right.join(gap)];
  return [...new Set(left.flatMap(prefix => right.map(suffix => prefix + suffix)))];
}
function sequence(parts: string[][]): string[] { return parts.reduce(combine, ['']); }
function expressionPaths(ast: AST): string[] {
  if (ast instanceof ASTWithSource) return expressionPaths(ast.ast);
  if (ast instanceof ParenthesizedExpression) return expressionPaths(ast.expression);
  if (ast instanceof LiteralPrimitive) return [ast.value == null ? '' : String(ast.value)];
  if (ast instanceof Conditional) return [...expressionPaths(ast.trueExp), ...expressionPaths(ast.falseExp)];
  if (ast instanceof Binary && ast.operation === '+') return combine(expressionPaths(ast.left), expressionPaths(ast.right));
  if (ast instanceof Binary && ast.operation === '&&') return [...expressionPaths(ast.right), ''];
  if (ast instanceof Binary && ['||', '??'].includes(ast.operation)) return [...expressionPaths(ast.left), ...expressionPaths(ast.right)];
  if (ast instanceof Interpolation) return sequence(ast.strings.flatMap((text, index) => index < ast.expressions.length ? [[text], expressionPaths(ast.expressions[index]!)] : [[text]]));
  if (ast instanceof TemplateLiteral) return sequence(ast.elements.flatMap((element, index) => index < ast.expressions.length ? [[element.text], expressionPaths(ast.expressions[index]!)] : [[element.text]]));
  return [gap];
}
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'small', 'u', 's', 'a', 'label', 'ng-container']);
const HIDDEN_CLASSES = new Set(['sr-only', 'visually-hidden']);
// Authored literals in attributes and component inputs can be visible copy
// (a `subtitle="…"` renders inside the child), so vocabulary checks include them.
// They cannot stand in for a visibly rendered warning in
// the wording ledger: an arbitrary input or aria-label need not render at all.
const NON_TEXT_ATTRIBUTES = new Set([
  'class', 'className', 'style', 'id', 'for', 'href', 'src', 'srcset', 'action', 'formaction', 'type', 'name', 'value',
  'role', 'tabindex', 'accesskey', 'dir', 'lang', 'slot', 'part', 'xmlns', 'viewBox', 'fill', 'stroke', 'd', 'width',
  'height', 'min', 'max', 'step', 'rows', 'cols', 'size', 'pattern', 'list', 'accept', 'multiple', 'autocomplete',
  'autofocus', 'required', 'readonly', 'disabled', 'hidden', 'checked', 'selected', 'open', 'controls', 'loop', 'muted',
  'poster', 'preload', 'cite', 'datetime', 'colspan', 'rowspan', 'scope', 'wrap', 'method', 'target', 'rel', 'download',
  'media', 'sizes', 'loading', 'decoding', 'contenteditable', 'draggable', 'spellcheck', 'translate', 'enterkeyhint',
  'inputmode', 'is', 'form', 'key', 'track', 'priority',
]);
const TEXT_ARIA_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']);
function authoredTextName(rawName: string): boolean {
  const name = rawName.startsWith('attr.') ? rawName.slice('attr.'.length) : rawName;
  if (NON_TEXT_ATTRIBUTES.has(name) || name.startsWith('data-')) return false;
  return !name.startsWith('aria-') || TEXT_ARIA_ATTRIBUTES.has(name);
}
function hiddenTextAttribute(name: string, value: unknown): boolean {
  return typeof value === 'string' && (['class', 'className'].includes(name) && value.split(/\s+/).some(part => HIDDEN_CLASSES.has(part))
    || name === 'style' && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i.test(value));
}
function hidden(node: Parameters<TmplAstRecursiveVisitor['visitElement']>[0]): boolean {
  return ['title', 'script', 'style', 'template'].includes(node.name.split(':').at(-1)!) || node.attributes.some(attribute => attribute.name === 'hidden'
    || hiddenTextAttribute(attribute.name, attribute.value))
    || node.inputs.some(input => {
      const value = input.value instanceof ASTWithSource ? input.value.ast : input.value;
      if (!(value instanceof LiteralPrimitive)) return false;
      return input.name === 'hidden' && (input.type === BindingType.Attribute ? value.value != null : !!value.value)
        || hiddenTextAttribute(input.name, value.value)
        || input.type === BindingType.Class && HIDDEN_CLASSES.has(input.name) && !!value.value
        || input.type === BindingType.Style && (input.name === 'display' && value.value === 'none' || input.name === 'visibility' && (value.value === 'hidden' || value.value === 'collapse'));
    });
}

function paths(nodes: TmplAstNode[], kind: 'visible' | 'vocabulary'): string[] {
  class Collector extends TmplAstRecursiveVisitor {
    parts: string[][] = [];
    override visitText(node: Parameters<TmplAstRecursiveVisitor['visitText']>[0]): void { this.parts.push([node.value]); }
    override visitBoundText(node: Parameters<TmplAstRecursiveVisitor['visitBoundText']>[0]): void { this.parts.push(expressionPaths(node.value)); }
    override visitElement(node: Parameters<TmplAstRecursiveVisitor['visitElement']>[0]): void {
      if (hidden(node)) { this.parts.push([gap]); return; }
      const authored: string[] = [];
      for (const attribute of node.attributes) if (kind === 'vocabulary' && authoredTextName(attribute.name)) authored.push(attribute.value);
      for (const input of node.inputs) {
        if (kind !== 'vocabulary' || !authoredTextName(input.name)) continue;
        const value = input.value instanceof ASTWithSource ? input.value.ast : input.value;
        if (value instanceof LiteralPrimitive) {
          if (typeof value.value === 'string') authored.push(value.value);
        } else if (value instanceof Interpolation || value instanceof Binary || value instanceof TemplateLiteral || value instanceof ParenthesizedExpression || value instanceof Conditional) {
          authored.push(...expressionPaths(value));
        }
      }
      if (authored.length) this.parts.push([gap + authored.join(gap) + gap]);
      const children = paths(node.children, kind);
      this.parts.push(INLINE_TAGS.has(node.name) ? children : [gap + children.join(gap) + gap]);
    }
    override visitTemplate(node: Parameters<TmplAstRecursiveVisitor['visitTemplate']>[0]): void { this.parts.push([node.tagName === 'ng-template' ? gap : gap + paths(node.children, kind).join(gap) + gap]); }
    override visitIfBlock(node: Parameters<TmplAstRecursiveVisitor['visitIfBlock']>[0]): void { this.parts.push(node.branches.flatMap(branch => paths(branch.children, kind))); }
    override visitSwitchBlock(node: Parameters<TmplAstRecursiveVisitor['visitSwitchBlock']>[0]): void { this.parts.push(node.groups.flatMap(group => paths(group.children, kind))); }
    override visitForLoopBlock(node: Parameters<TmplAstRecursiveVisitor['visitForLoopBlock']>[0]): void {
      this.parts.push([...paths(node.children, kind), ...(node.empty ? paths(node.empty.children, kind) : [''])]);
    }
    override visitDeferredBlock(node: Parameters<TmplAstRecursiveVisitor['visitDeferredBlock']>[0]): void {
      this.parts.push([node, node.placeholder, node.loading, node.error].flatMap(block => block ? paths(block.children, kind) : []));
    }
    override visitContent(node: Parameters<TmplAstRecursiveVisitor['visitContent']>[0]): void { this.parts.push([gap]); super.visitContent(node); }
  }
  const collector = new Collector();
  tmplAstVisitAll(collector, nodes);
  return sequence(collector.parts);
}

/** Sentinels preserve boundaries; vocabulary additionally checks authored input copy. */
export function renderedTextStream(nodes: TmplAstNode[], kind: 'visible' | 'vocabulary'): string[] { return [gap + paths(nodes, kind).join(gap) + gap]; }
