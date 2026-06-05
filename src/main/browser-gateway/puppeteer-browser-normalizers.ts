import type {
  BrowserAccessibilityNode,
  BrowserElementCandidate,
  BrowserSelectOption,
} from '@contracts/types/browser';
import { redactBrowserText, redactBrowserUrl } from './browser-redaction';

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
    if (options.interestingOnly && (role === 'none' || role === 'generic' || role === 'InlineTextBox')) {
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

export function normalizeElementCandidates(result: unknown): BrowserElementCandidate[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [];
  }
  const rawElements = (result as Record<string, unknown>)['elements'];
  if (!Array.isArray(rawElements)) {
    return [];
  }
  const candidates: BrowserElementCandidate[] = [];
  for (const item of rawElements) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const selector = value['selector'];
    const tagName = value['tagName'];
    if (typeof selector !== 'string' || !selector || typeof tagName !== 'string' || !tagName) {
      continue;
    }
    candidates.push({
      selector: selector.slice(0, 2_000),
      tagName: tagName.slice(0, 120),
      ...optionalString(value, 'role', 120),
      ...optionalString(value, 'accessibleName', 500),
      ...optionalText(value),
      ...optionalString(value, 'inputType', 120),
      ...optionalString(value, 'placeholder', 500),
      ...optionalHref(value),
      ...optionalControlValue(value),
      ...optionalBoolean(value, 'checked'),
      ...optionalBoolean(value, 'disabled'),
      ...optionalBoolean(value, 'expanded'),
      ...optionalOptions(value),
    });
  }
  return candidates;
}

function optionalControlValue(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const out: Partial<BrowserElementCandidate> = {};
  const raw = value['value'];
  if (typeof raw === 'string') {
    out.value = redactBrowserText(raw).slice(0, 1_000);
  }
  const selectedOption = value['selectedOption'];
  if (typeof selectedOption === 'string' && selectedOption) {
    out.selectedOption = redactBrowserText(selectedOption).slice(0, 200);
  }
  return out;
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: 'checked' | 'disabled' | 'expanded',
): Partial<BrowserElementCandidate> {
  return typeof value[key] === 'boolean' ? { [key]: value[key] as boolean } : {};
}

function optionalOptions(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const raw = value['options'];
  if (!Array.isArray(raw)) return {};
  const options: BrowserSelectOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const option = item as Record<string, unknown>;
    const optionValue = option['value'];
    const optionLabel = option['label'];
    if (typeof optionValue !== 'string' && typeof optionLabel !== 'string') continue;
    options.push({
      value: typeof optionValue === 'string' ? redactBrowserText(optionValue).slice(0, 200) : '',
      label: typeof optionLabel === 'string' ? redactBrowserText(optionLabel).slice(0, 200) : '',
      selected: option['selected'] === true,
    });
    if (options.length >= 50) break;
  }
  return options.length ? { options } : {};
}

function optionalString(
  value: Record<string, unknown>,
  key: keyof BrowserElementCandidate,
  maxLength: number,
): Partial<BrowserElementCandidate> {
  const item = value[key];
  return typeof item === 'string' && item ? { [key]: item.slice(0, maxLength) } : {};
}

function optionalText(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const text = value['text'];
  return typeof text === 'string' && text
    ? { text: redactBrowserText(text).slice(0, 1_000) }
    : {};
}

function optionalHref(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const href = value['href'];
  if (typeof href !== 'string' || !href) return {};
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {};
    return { href: redactBrowserUrl(href).slice(0, 2_000) };
  } catch {
    return {};
  }
}
