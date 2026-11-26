/** Shared naming semantics over Angular AST projections. No HTML parsing here. */
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const LABELABLE_TAGS = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const actual = value => value?.constructor?.name === 'ASTWithSource' ? value.ast : value;

/** A literal binding and the corresponding static attribute name the same id. */
function literal(value) {
  if (typeof value === 'string') return value;
  value = actual(value);
  if (value?.constructor?.name === 'LiteralPrimitive') return typeof value.value === 'string' ? value.value : undefined;
  return undefined;
}

/** Compare parsed expressions, preserving string contents and ignoring source spacing. */
function expressionKey(value) {
  value = actual(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(expressionKey);
  return [value.constructor.name, ...Object.entries(value)
    .filter(([key]) => !['source', 'location', 'errors', 'parent', 'loc', 'range'].includes(key) && !/span$/i.test(key))
    .map(([key, child]) => [key, expressionKey(child)])];
}
function identity(value, form) {
  if (value === undefined) return undefined;
  const ast = actual(value);
  if (ast?.constructor?.name === 'LiteralPrimitive') {
    if (ast.value == null && form !== 'property') return undefined;
    const rendered = String(ast.value);
    return hasText(rendered) ? 'literal:' + rendered : undefined;
  }
  const text = literal(value);
  return text !== undefined ? (hasText(text) ? 'literal:' + text : undefined) : 'bound:' + JSON.stringify(expressionKey(value));
}

/** Only rendered expression branches count, never predicates or quoted source text. */
function readable(value) {
  const text = literal(value);
  if (text !== undefined) return hasText(text);
  value = actual(value);
  if (!value || typeof value !== 'object') return false;
  switch (value.constructor.name) {
    case 'PropertyRead': case 'SafePropertyRead': case 'Call': case 'SafeCall': case 'BindingPipe': case 'KeyedRead': case 'SafeKeyedRead': return true;
    case 'LiteralPrimitive': case 'PrefixNot': return false;
    case 'Conditional': return readable(value.trueExp) || readable(value.falseExp);
    case 'Binary': return ['+', '||', '??'].includes(value.operation) && readable(value.left) || ['+', '||', '??', '&&'].includes(value.operation) && readable(value.right);
    case 'Interpolation': return value.strings.some(hasText) || value.expressions.some(readable);
    case 'TemplateLiteral': return value.elements.some(element => hasText(element.text)) || value.expressions.some(readable);
    default: return false;
  }
}

/** Returns named field indices. Both the source guard and ESLint use this decision. */
function namedFormFields(elements) {
  const attributeName = attribute => attribute.name === 'htmlFor' && attribute.form === 'property' ? 'for' : attribute.name;
  const attributes = elements.map(element => new Map(element.attributes.map(attribute => [attributeName(attribute), attribute.value])));
  const forms = elements.map(element => new Map(element.attributes.map(attribute => [attributeName(attribute), attribute.form])));
  const identityOf = (index, name) => identity(attributes[index].get(name), forms[index].get(name));
  const hasFor = index => {
    const value = actual(attributes[index].get('for'));
    return attributes[index].has('for') && !(forms[index].get('for') === 'attribute' && value?.constructor?.name === 'LiteralPrimitive' && value.value == null);
  };
  const coexists = (left, right) => !(elements[left].branches ?? []).some(([group, arm]) => (elements[right].branches ?? []).some(([other, branch]) => group === other && arm !== branch));
  const ids = new Map();
  const labels = new Map();
  const implicitTargets = new Map();
  for (let index = 0; index < elements.length; index++) {
    const id = identityOf(index, 'id');
    if (id !== undefined) ids.set(id, [...(ids.get(id) ?? []), index]);
    if (elements[index].tag === 'label') {
      const target = identityOf(index, 'for');
      if (target !== undefined) labels.set(target, [...(labels.get(target) ?? []), index]);
    }
    if (LABELABLE_TAGS.has(elements[index].tag) && !(elements[index].tag === 'input' && literal(attributes[index].get('type')) === 'hidden')) {
      let parent = elements[index].parent;
      while (parent !== undefined) {
        if (elements[parent].tag === 'label') implicitTargets.set(parent, [...(implicitTargets.get(parent) ?? []), index]);
        parent = elements[parent].parent;
      }
    }
  }
  const firstId = (id, context) => (ids.get(id) ?? []).find(candidate => coexists(candidate, context));
  const contentName = (index, visiting = new Set(), allowContent = true, context = index) => {
    if (visiting.has(index)) return false;
    const next = new Set([...visiting, index]);
    const attrs = attributes[index];
    const references = attrs.get('aria-labelledby');
    const text = literal(references);
    if (text !== undefined && hasText(text)) {
      if (text.trim().split(/\s+/).some(id => {
        const target = firstId('literal:' + id, context);
        return target !== undefined && contentName(target, next, true, context);
      })) return true;
    } else {
      const target = firstId(identityOf(index, 'aria-labelledby'), context);
      if (target !== undefined && contentName(target, next, true, context)) return true;
    }
    return readable(attrs.get('aria-label')) || allowContent && elements[index].readable;
  };
  const result = new Set();
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!FIELD_TAGS.has(element.tag)) continue;
    const attrs = attributes[index];
    const id = identityOf(index, 'id');
    // A field's options/placeholder/value do not label the field itself.
    const named = literal(attrs.get('type')) === 'hidden' || contentName(index, new Set(), false);
    if (named || id !== undefined && firstId(id, index) === index && (labels.get(id) ?? []).some(label => coexists(label, index) && contentName(label, new Set(), true, index))) {
      result.add(index); continue;
    }
    let parent = element.parent;
    while (parent !== undefined) {
      if (elements[parent].tag === 'label' && !hasFor(parent) && (implicitTargets.get(parent) ?? []).find(candidate => coexists(candidate, index)) === index && contentName(parent, new Set(), true, index)) {
        result.add(index); break;
      }
      parent = elements[parent].parent;
    }
  }
  return result;
}

module.exports = { namedFormFields };
