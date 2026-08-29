import type { BrowserAccessibilityNode } from '@contracts/types/browser';
import { redactBrowserText } from './browser-redaction';
export { normalizeElementCandidates } from './browser-element-candidates';

export function normalizeAxTreeNodes(
  tree: unknown,
  options: { interestingOnly: boolean; limit: number },
): BrowserAccessibilityNode[] {
  if (!tree || typeof tree !== 'object') {
    return [];
  }
  const rawNodes = (tree as Record<string, unknown>)['nodes'];
  if (!Array.isArray(rawNodes)) {
    return [];
  }
  const nodes: BrowserAccessibilityNode[] = [];
  for (const raw of rawNodes) {
    if (nodes.length >= options.limit) break;
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    if (options.interestingOnly && node['ignored'] === true) continue;
    const backendId = node['backendDOMNodeId'];
    if (typeof backendId !== 'number') continue;
    const role = axValueString(node['role']);
    if (!role) continue;
    // Keep the editable HOST: Chrome reports a contenteditable body as role
    // `generic`, so an unconditional generic drop filters every rich-text editor
    // out of the tree. `editable` alone is inherited by every descendant, so
    // require `focusable` too -- live-probed, only the host reports both.
    const props = axProperties(node['properties']);
    const editableToken = props.find((property) => property.name === 'editable')?.value;
    const focusable = props.find((property) => property.name === 'focusable')?.value;
    // The frame document (RootWebArea) also reports editable+focusable but is
    // not a typeable target, so exclude it explicitly.
    const isEditableHost = editableToken !== undefined
      && editableToken !== false
      && editableToken !== 'false'
      && (focusable === true || focusable === 'true')
      && role !== 'RootWebArea';
    if (
      options.interestingOnly
      && !isEditableHost
      && (role === 'none' || role === 'generic' || role === 'InlineTextBox')
    ) {
      continue;
    }
    const entry: BrowserAccessibilityNode = { uid: String(backendId), role };
    const name = axValueString(node['name']);
    if (name) entry.name = redactBrowserText(name).slice(0, 2000);
    const value = axValueString(node['value']);
    if (value) entry.value = redactBrowserText(value).slice(0, 2000);
    const description = axValueString(node['description']);
    if (description) entry.description = redactBrowserText(description).slice(0, 2000);
    for (const property of axProperties(node['properties'])) {
      const rawValue = property.value;
      switch (property.name) {
        case 'checked':
          entry.checked = rawValue === 'mixed' ? 'mixed' : rawValue === true || rawValue === 'true';
          break;
        case 'selected':
          entry.selected = rawValue === true || rawValue === 'true';
          break;
        case 'expanded':
          entry.expanded = rawValue === true || rawValue === 'true';
          break;
        case 'disabled':
          entry.disabled = rawValue === true || rawValue === 'true';
          break;
        case 'focused':
          entry.focused = rawValue === true || rawValue === 'true';
          break;
        case 'level':
          if (typeof rawValue === 'number') entry.level = rawValue;
          break;

        default:
          break;
      }
    }
    // Only the HOST carries `editable`. The switch above runs for every node and
    // `editable` is inherited, so emitting it there would mark paragraphs and
    // text runs inside an editor -- and a paragraph accepts a write and reports
    // success, which is exactly the confident-wrong-write this avoids.
    if (isEditableHost && typeof editableToken === 'string' && editableToken) {
      entry.editable = editableToken.slice(0, 40);
    } else if (isEditableHost && editableToken === true) {
      entry.editable = 'plaintext';
    }
    nodes.push(entry);
  }
  return nodes;
}

function axValueString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const inner = (value as Record<string, unknown>)['value'];
  return typeof inner === 'string' && inner.trim() ? inner : undefined;
}

function axProperties(value: unknown): Array<{ name: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ name: string; value: unknown }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as Record<string, unknown>)['name'];
    const valueObject = (item as Record<string, unknown>)['value'];
    if (typeof name !== 'string') continue;
    result.push({
      name,
      value: valueObject && typeof valueObject === 'object'
        ? (valueObject as Record<string, unknown>)['value']
        : undefined,
    });
  }
  return result;
}
