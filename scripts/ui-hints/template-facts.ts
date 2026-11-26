import { parseTemplate, TmplAstRecursiveVisitor, tmplAstVisitAll, TmplAstElement, TmplAstText, TmplAstBoundText, ASTWithSource } from '@angular/compiler';
import { expressionText, hoverText } from './hover-strings';
import { renderedTextStream } from './rendered-text-stream';
import { namedFormFields, type FormNameElement } from './form-field-names.js';
import { CONTROL_TAGS, FIELD_TAGS, HOVER_BINDINGS, INTERACTIVE_ROLES, TOOLTIP_PROVIDERS, WORD, type AttributeFact, type ElementFact, type TemplateSource } from './types';
import type ts from 'typescript';

export function parseFacts(source: TemplateSource, files: ts.SourceFile[] = [source.sourceFile], copy: Record<string, string> = {}): { facts: ElementFact[]; visible: string[]; vocabulary: string[] } {
  const parsed = parseTemplate(source.text, source.file, { enableBlockSyntax: true, enableLetSyntax: true });
  if (parsed.errors?.length) throw new Error(parsed.errors.map(error => `${source.file}:${source.firstLine + error.span.start.line}: ${error.msg}`).join('\n'));
  class TextCollector extends TmplAstRecursiveVisitor {
    fragments: string[] = [];
    data = false;
    opaque = false;
    override visitText(node: TmplAstText): void { this.fragments.push(node.value); }
    override visitBoundText(node: TmplAstBoundText): void {
      const text = expressionText(node.value);
      this.fragments.push(...text.fragments);
      // Literal-only glyph choices are not a data name; identifiers on a conditional do not render.
      if (text.dynamic) this.data = true;
    }
    override visitElement(node: TmplAstElement): void {
      if (node.name.includes('-') && !node.name.startsWith('ng-')) this.opaque = true;
      super.visitElement(node);
    }
  }
  const facts: ElementFact[] = [];
  const naming: FormNameElement[] = [];
  const parents: number[] = [];
  const branches: [number, number][] = [];
  const ancestors: ElementFact[] = [];
  class Visitor extends TmplAstRecursiveVisitor {
    private nextGroup = 0;
    private groups: { id: number; nextArm: number }[] = [];
    override visitIfBlock(node: Parameters<TmplAstRecursiveVisitor['visitIfBlock']>[0]): void {
      this.groups.push({ id: this.nextGroup++, nextArm: 0 }); super.visitIfBlock(node); this.groups.pop();
    }
    override visitSwitchBlock(node: Parameters<TmplAstRecursiveVisitor['visitSwitchBlock']>[0]): void {
      this.groups.push({ id: this.nextGroup++, nextArm: 0 }); super.visitSwitchBlock(node); this.groups.pop();
    }
    override visitIfBlockBranch(node: Parameters<TmplAstRecursiveVisitor['visitIfBlockBranch']>[0]): void {
      const group = this.groups.at(-1)!; branches.push([group.id, group.nextArm++]); super.visitIfBlockBranch(node); branches.pop();
    }
    override visitSwitchBlockCaseGroup(node: Parameters<TmplAstRecursiveVisitor['visitSwitchBlockCaseGroup']>[0]): void {
      const group = this.groups.at(-1)!; branches.push([group.id, group.nextArm++]); super.visitSwitchBlockCaseGroup(node); branches.pop();
    }
    override visitElement(node: TmplAstElement): void {
      const attributes: AttributeFact[] = [
        ...node.attributes.map(attr => ({ name: attr.name, text: attr.value, form: 'static' as const })),
        ...node.inputs.map(attr => ({ name: attr.name, expression: attr.value, source: attr.value instanceof ASTWithSource ? attr.value.source ?? '' : '', form: attr.type === 1 ? 'attribute' as const : attr.value instanceof ASTWithSource && attr.value.ast.constructor.name === 'Interpolation' ? 'interpolated' as const : 'property' as const })),
      ];
      const get = (name: string): AttributeFact | undefined => attributes.find(attr => attr.name === name);
      const text = new TextCollector();
      tmplAstVisitAll(text, node.children);
      const roleAttribute = get('role');
      const role = roleAttribute?.text ?? (roleAttribute?.expression ? expressionText(roleAttribute.expression).fragments.find(value => (INTERACTIVE_ROLES as readonly string[]).includes(value)) ?? '(bound)' : undefined);
      const tag = node.name;
      const field = (FIELD_TAGS as readonly string[]).includes(tag);
      const control = field || (CONTROL_TAGS as readonly string[]).includes(tag) || tag === 'a' && !!(get('href') || get('routerLink')) || !!role && (INTERACTIVE_ROLES as readonly string[]).includes(role);
      const inert = attributes.filter(attr => (TOOLTIP_PROVIDERS as readonly string[]).includes(attr.name) && !source.imports.includes(attr.name === 'appIconButton' ? 'AppIconButtonDirective' : 'AioTooltipDirective')).map(attr => attr.name);
      const tooltip = attributes.some(attr => (TOOLTIP_PROVIDERS as readonly string[]).includes(attr.name) && !inert.includes(attr.name));
      const nameAttributes = attributes.filter(attr => ['aria-label', 'aria-labelledby', 'appIconButton'].includes(attr.name));
      const validName = nameAttributes.some(attr => attr.expression ? expressionText(attr.expression).fragments.some(value => WORD.test(value)) || expressionText(attr.expression).dynamic : WORD.test(attr.text ?? ''));
      const dataName = nameAttributes.some(attr => !!attr.expression && expressionText(attr.expression).dynamic && !expressionText(attr.expression).fragments.length);
      const marker = get('data-ui-hints-exempt')?.text;
      const fact: ElementFact = {
        ownerFile: source.ownerFile, file: source.file, line: source.firstLine + node.startSourceSpan.start.line,
        tag, attributes, componentHost: tag.includes('-') && !tag.startsWith('ng-'), control, field, role,
        title: get('title'), tooltip, inert,
        hover: attributes.filter(attr => (HOVER_BINDINGS as readonly string[]).includes(attr.name)).map(attr => hoverText(attr.name, attr.expression, attr.text, source, files, copy)),
        name: validName || control && !field && (text.fragments.some(value => WORD.test(value)) || text.data), dataName,
        visible: text.fragments, dataText: text.data, opaque: text.opaque,
        iconOnly: control && !field && !text.fragments.some(value => WORD.test(value)) && !text.data && !text.opaque,
        focusable: control || !!get('tabindex') && get('tabindex')?.text !== '-1',
        hidden: get('aria-hidden')?.text === 'true' && get('tabindex')?.text === '-1', marker,
        firstClass: (get('class')?.text ?? '').split(/\s+/)[0] ?? '',
        nested: ancestors.some(parent => parent.tooltip || !!parent.title),
        click: node.outputs.find(output => output.name === 'click')?.handler instanceof ASTWithSource ? (node.outputs.find(output => output.name === 'click')!.handler as ASTWithSource).source ?? undefined : undefined,
        disabled: get('disabled')?.source,
      };
      facts.push(fact);
      naming.push({ tag, attributes: attributes.map(attr => ({ name: attr.name, value: attr.text ?? attr.expression, form: attr.form })), readable: text.fragments.some(value => value.trim()) || text.data, parent: parents.at(-1), branches: [...branches] });
      parents.push(facts.length - 1);
      ancestors.push(fact);
      super.visitElement(node);
      ancestors.pop();
      parents.pop();
    }
  }
  tmplAstVisitAll(new Visitor(), parsed.nodes);
  const named = namedFormFields(naming);
  facts.forEach((fact, index) => { if (fact.field) fact.name = named.has(index); });
  return { facts, visible: renderedTextStream(parsed.nodes, 'visible'), vocabulary: renderedTextStream(parsed.nodes, 'vocabulary') };
}
