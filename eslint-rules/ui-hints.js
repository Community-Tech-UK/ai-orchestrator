// @ts-check
/** UI hints convenience rules. The source guard ignores eslint-disable comments.
 * Switch on H5 first; then native titles (controls), icon controls, titles (all).
 * See scripts/__tests__/ui-hints-lint-link.spec.ts. Whole-tree/judgement rules
 * H3/H4/H6/H9/H10/H11 stay in scripts/check-ui-hints.ts.
 */
const CONTROL_TAGS = ['button', 'summary'];
const FIELD_TAGS = ['input', 'select', 'textarea'];
const INTERACTIVE_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'slider', 'spinbutton'];
const EXEMPT_REASONS = ['backdrop', 'decorative', 'local-key'];
const TITLE_EXCEPTIONS = ['iframe', 'frame', 'embed', 'object', 'math', 'title'];
const SHORTCUT_SOURCE = '[⌘⌥⇧⌃]|(?:Cmd|Ctrl|Alt|Shift)\\+|\\((?:Esc|Enter)\\)|\\+Enter|-(?:click)';
const WORD = /\p{L}{2,}/u;
const shortcut = new RegExp(SHORTCUT_SOURCE, 'i');
const attributes = node => [...node.attributes, ...node.inputs];
const attr = (node, name) => attributes(node).find(attribute => attribute.name === name);
const textValue = attribute => attribute && typeof attribute.value === 'string' ? attribute.value : undefined;
const component = name => name.includes('-') && !name.startsWith('ng-');
const control = node => CONTROL_TAGS.includes(node.name) || node.name === 'a' && !!(attr(node, 'href') || attr(node, 'routerLink')) || (textValue(attr(node, 'role')) !== undefined ? [textValue(attr(node, 'role'))] : fragments(attr(node, 'role')?.value)).some(role => INTERACTIVE_ROLES.includes(role));
const hidden = node => textValue(attr(node, 'aria-hidden')) === 'true' && textValue(attr(node, 'tabindex')) === '-1';
const marker = node => textValue(attr(node, 'data-ui-hints-exempt'));
/** Only authored literal text counts; identifiers in ternary conditions do not render. */
function fragments(value) {
  const result = [];
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.constructor.name === 'Binary') {
      if (['+', '||', '??'].includes(node.operation)) visit(node.left);
      if (['+', '||', '??', '&&'].includes(node.operation)) visit(node.right);
      return;
    }
    if (node.constructor.name === 'PrefixNot') return;
    if (node.constructor.name === 'Conditional') { visit(node.trueExp); visit(node.falseExp); return; }
    if (node.constructor.name === 'LiteralPrimitive' && typeof node.value === 'string') result.push(node.value);
    if (node.constructor.name === 'TemplateLiteralElement') result.push(node.text);
    if (node.constructor.name === 'Interpolation') result.push(...node.strings.filter(Boolean));
    for (const [key, child] of Object.entries(node)) {
      if (['parent', 'sourceSpan', 'span', 'nameSpan', 'keySpan', 'valueSpan', 'loc', 'range'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(value);
  return result;
}
function renderedData(value) {
  if (!value || typeof value !== 'object') return false;
  const kind = value.constructor.name;
  if (kind === 'Binary') return ['+', '||', '??'].includes(value.operation) && renderedData(value.left) || ['+', '||', '??', '&&'].includes(value.operation) && renderedData(value.right);
  if (kind === 'PrefixNot') return false;
  if (['PropertyRead', 'SafePropertyRead', 'Call', 'SafeCall', 'BindingPipe'].includes(kind)) return true;
  if (kind === 'LiteralPrimitive' || kind === 'TemplateLiteralElement') return false;
  if (kind === 'Conditional') return renderedData(value.trueExp) || renderedData(value.falseExp);
  return Object.entries(value).some(([key, child]) => !['parent', 'sourceSpan', 'span', 'nameSpan', 'keySpan', 'valueSpan', 'loc', 'range'].includes(key) && (Array.isArray(child) ? child.some(renderedData) : renderedData(child)));
}
const namedAttribute = attribute => {
  if (!attribute) return false;
  const text = textValue(attribute);
  if (text !== undefined) return WORD.test(text);
  const literals = fragments(attribute.value);
  return literals.some(text => WORD.test(text)) || renderedData(attribute.value);
};
const meta = (messages, schema = []) => ({ type: 'problem', docs: { description: 'Keep screen controls named and reachable. See docs/screen-and-wording-guide.md.' }, schema, messages });
const rules = {
  'icon-control-needs-name-and-tooltip': {
    meta: meta({ noName: 'Icon-only control needs an accessible name.', noTooltip: 'Icon-only control needs a Harness tooltip.' }),
    create(context) {
      const stack = [];
      return {
        Element(node) {
          if (component(node.name)) for (const open of stack) open.opaque = true;
          if (control(node)) stack.push({ node, text: false, opaque: false });
        },
        Text(node) { if (WORD.test(node.value)) for (const open of stack) open.text = true; },
        BoundText(node) {
          const values = fragments(node.value);
          if (renderedData(node.value) || values.some(value => WORD.test(value))) for (const open of stack) open.text = true;
        },
        'Element:exit'(node) {
          if (!control(node)) return;
          const open = stack.pop();
          if (!open || open.text || open.opaque || hidden(node) || ['backdrop', 'decorative'].includes(marker(node))) return;
          const named = ['aria-label', 'aria-labelledby', 'appIconButton'].some(name => namedAttribute(attr(node, name)));
          const tooltip = ['appTooltip', 'appTooltipTpl', 'appIconButton', 'appTooltipDisabledReason'].some(name => !!attr(node, name));
          if (!named) context.report({ node, messageId: 'noName' });
          else if (!tooltip) context.report({ node, messageId: 'noTooltip' });
        },
      };
    },
  },
  'no-native-title': {
    meta: meta({ nativeTitle: 'Move native title wording unchanged into an accessible Harness tooltip.' }, [{ type: 'object', properties: { scope: { enum: ['controls', 'all'] } }, additionalProperties: false }]),
    create(context) {
      const scope = context.options[0]?.scope ?? 'controls';
      return { Element(node) {
        if (TITLE_EXCEPTIONS.includes(node.name) || !attr(node, 'title')) return;
        if (scope === 'all' || control(node) || FIELD_TAGS.includes(node.name)) context.report({ node, messageId: 'nativeTitle' });
      } };
    },
  },
  'no-hardcoded-shortcut': {
    meta: meta({ shortcut: 'Use the shortcut channel; local keys require an explicit local-key marker.' }),
    create(context) {
      return { Element(node) {
        if (marker(node) === 'local-key') return;
        for (const name of ['title', 'appTooltip', 'appIconButton', 'appTooltipDisabledReason', 'appIconButtonDisabledReason']) {
          const attribute = attr(node, name); if (!attribute) continue;
          const text = textValue(attribute);
          if ((text !== undefined ? [text] : fragments(attribute.value)).some(value => shortcut.test(value))) context.report({ node: attribute, messageId: 'shortcut' });
        }
      } };
    },
  },
};
module.exports = { meta: { name: 'ui-hints' }, rules, constants: { CONTROL_TAGS, FIELD_TAGS, INTERACTIVE_ROLES, EXEMPT_REASONS, TITLE_EXCEPTIONS, SHORTCUT_SOURCE } };
