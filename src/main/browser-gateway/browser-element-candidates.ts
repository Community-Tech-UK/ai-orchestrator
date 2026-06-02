import type {
  BrowserElementCandidate,
  BrowserSelectOption,
} from '@contracts/types/browser';
import {
  redactBrowserText,
  redactBrowserUrl,
} from './browser-redaction';

/**
 * Normalises a raw command response from the Browser Gateway extension into a
 * typed `BrowserElementCandidate[]`.  The extension returns `{ elements: [...] }`
 * so this function unwraps that envelope and validates/clamps every field.
 */
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
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const value = item as Record<string, unknown>;
    const selector = value['selector'];
    const tagName = value['tagName'];
    if (typeof selector !== 'string' || !selector || typeof tagName !== 'string' || !tagName) {
      continue;
    }
    candidates.push({
      selector: selector.slice(0, 2_000),
      tagName: tagName.slice(0, 120),
      ...optionalElementString(value, 'role', 120),
      ...optionalElementString(value, 'accessibleName', 500),
      ...optionalElementText(value),
      ...optionalElementString(value, 'inputType', 120),
      ...optionalElementString(value, 'placeholder', 500),
      ...optionalElementHref(value),
      ...optionalElementControlValue(value),
      ...optionalElementBoolean(value, 'checked'),
      ...optionalElementBoolean(value, 'disabled'),
      ...optionalElementBoolean(value, 'expanded'),
      ...optionalElementOptions(value),
    });
  }
  return candidates;
}

function optionalElementControlValue(
  value: Record<string, unknown>,
): Partial<BrowserElementCandidate> {
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

function optionalElementBoolean(
  value: Record<string, unknown>,
  key: 'checked' | 'disabled' | 'expanded',
): Partial<BrowserElementCandidate> {
  return typeof value[key] === 'boolean' ? { [key]: value[key] as boolean } : {};
}

function optionalElementOptions(
  value: Record<string, unknown>,
): Partial<BrowserElementCandidate> {
  const raw = value['options'];
  if (!Array.isArray(raw)) {
    return {};
  }
  const options: BrowserSelectOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const option = item as Record<string, unknown>;
    const optionValue = option['value'];
    const optionLabel = option['label'];
    if (typeof optionValue !== 'string' && typeof optionLabel !== 'string') {
      continue;
    }
    options.push({
      value: typeof optionValue === 'string' ? redactBrowserText(optionValue).slice(0, 200) : '',
      label: typeof optionLabel === 'string' ? redactBrowserText(optionLabel).slice(0, 200) : '',
      selected: option['selected'] === true,
    });
    if (options.length >= 50) {
      break;
    }
  }
  return options.length ? { options } : {};
}

function optionalElementString(
  value: Record<string, unknown>,
  key: keyof BrowserElementCandidate,
  maxLength: number,
): Partial<BrowserElementCandidate> {
  const item = value[key];
  return typeof item === 'string' && item
    ? { [key]: item.slice(0, maxLength) }
    : {};
}

function optionalElementText(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const text = value['text'];
  return typeof text === 'string' && text
    ? { text: redactBrowserText(text).slice(0, 1_000) }
    : {};
}

function optionalElementHref(value: Record<string, unknown>): Partial<BrowserElementCandidate> {
  const href = value['href'];
  if (typeof href !== 'string' || !href) {
    return {};
  }
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? { href: redactBrowserUrl(href).slice(0, 2_000) }
      : {};
  } catch {
    return {};
  }
}
