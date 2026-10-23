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

function paths(nodes: TmplAstNode[]): string[] {
  class Collector extends TmplAstRecursiveVisitor {
    parts: string[][] = [];
    override visitText(node: Parameters<TmplAstRecursiveVisitor['visitText']>[0]): void { this.parts.push([node.value]); }
    override visitBoundText(node: Parameters<TmplAstRecursiveVisitor['visitBoundText']>[0]): void { this.parts.push(expressionPaths(node.value)); }
    override visitElement(node: Parameters<TmplAstRecursiveVisitor['visitElement']>[0]): void {
      if (hidden(node)) { this.parts.push([gap]); return; }
      const children = paths(node.children);
      this.parts.push(INLINE_TAGS.has(node.name) ? children : [gap + children.join(gap) + gap]);
    }
    override visitTemplate(node: Parameters<TmplAstRecursiveVisitor['visitTemplate']>[0]): void { this.parts.push([node.tagName === 'ng-template' ? gap : gap + paths(node.children).join(gap) + gap]); }
    override visitIfBlock(node: Parameters<TmplAstRecursiveVisitor['visitIfBlock']>[0]): void { this.parts.push(node.branches.flatMap(branch => paths(branch.children))); }
    override visitSwitchBlock(node: Parameters<TmplAstRecursiveVisitor['visitSwitchBlock']>[0]): void { this.parts.push(node.groups.flatMap(group => paths(group.children))); }
    override visitForLoopBlock(node: Parameters<TmplAstRecursiveVisitor['visitForLoopBlock']>[0]): void {
      this.parts.push([...paths(node.children), ...(node.empty ? paths(node.empty.children) : [''])]);
    }
    override visitDeferredBlock(node: Parameters<TmplAstRecursiveVisitor['visitDeferredBlock']>[0]): void {
      this.parts.push([node, node.placeholder, node.loading, node.error].flatMap(block => block ? paths(block.children) : []));
    }
    override visitContent(node: Parameters<TmplAstRecursiveVisitor['visitContent']>[0]): void { this.parts.push([gap]); super.visitContent(node); }
  }
  const collector = new Collector();
  tmplAstVisitAll(collector, nodes);
  return sequence(collector.parts);
}

/** Ledger stream only: sentinels must never be treated as control-name fragments. */
export function renderedTextStream(nodes: TmplAstNode[]): string[] { return [gap + paths(nodes).join(gap) + gap]; }
