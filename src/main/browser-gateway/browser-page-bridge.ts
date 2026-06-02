import type { Page } from 'puppeteer-core';

interface PageBridgeSnapshot {
  title: string;
  text: string;
}

export function isPageBridgeSnapshot(value: unknown): value is PageBridgeSnapshot {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as Partial<PageBridgeSnapshot>).text === 'string',
  );
}

interface PageBridgeInput {
  action: string;
  args: unknown[];
}

interface PageBridgeRoot {
  textContent?: string | null;
  querySelector?: (selector: string) => PageBridgeElement | null;
  querySelectorAll?: (selector: string) => ArrayLike<PageBridgeElement>;
}

interface PageBridgeOption {
  value?: string;
  label?: string;
  textContent?: string | null;
  selected?: boolean;
}

interface PageBridgeElement extends PageBridgeRoot {
  tagName?: string;
  id?: string;
  className?: string;
  innerText?: string;
  value?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  selectedIndex?: number;
  options?: ArrayLike<PageBridgeOption>;
  isContentEditable?: boolean;
  parentElement?: PageBridgeElement | null;
  children?: ArrayLike<PageBridgeElement>;
  shadowRoot?: PageBridgeRoot | null;
  getAttribute?: (name: string) => string | null;
  getAttributeNames?: () => string[];
  scrollIntoView?: (options?: unknown) => void;
  focus?: () => void;
  click?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
}

interface PageBridgeControlState {
  value?: string;
  selectedOption?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
}

interface PageBridgeDocument extends PageBridgeRoot {
  title: string;
  body?: PageBridgeElement;
  documentElement: PageBridgeElement;
}

interface PageBridgeGlobal {
  document: PageBridgeDocument;
  CSS?: {
    escape?: (value: string) => string;
  };
  InputEvent: new (type: string, options?: Record<string, unknown>) => unknown;
  Event: new (type: string, options?: Record<string, unknown>) => unknown;
  MutationObserver: new (callback: () => void) => {
    observe: (target: PageBridgeElement, options: Record<string, unknown>) => void;
    disconnect: () => void;
  };
}

export function evaluatePageBridge(page: Page, input: PageBridgeInput): Promise<unknown> {
  const evaluate = page.evaluate as unknown as (
    fn: (payload: PageBridgeInput) => unknown,
    payload: PageBridgeInput,
  ) => Promise<unknown>;
  return evaluate.call(page, pageBridgeScript, input);
}

function pageBridgeScript(input: PageBridgeInput): unknown {
  const { action, args } = input;
  const pageGlobal = globalThis as unknown as PageBridgeGlobal;
  const documentRef = pageGlobal.document;

  function deepQuerySelector(
    selector: string,
    root: PageBridgeRoot = documentRef,
  ): PageBridgeElement | null {
    const direct = root.querySelector?.(selector);
    if (direct) {
      return direct;
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of Array.from(nodes as ArrayLike<PageBridgeElement>)) {
      if (!node.shadowRoot) {
        continue;
      }
      const found = deepQuerySelector(selector, node.shadowRoot);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function collectVisibleText(
    root: PageBridgeRoot = documentRef,
    seen = new Set<PageBridgeRoot>(),
  ): string {
    if (seen.has(root)) {
      return '';
    }
    seen.add(root);
    const parts = [];
    if (root === documentRef) {
      parts.push(documentRef.body?.innerText || '');
    } else {
      parts.push(root.textContent || '');
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of Array.from(nodes as ArrayLike<PageBridgeElement>)) {
      if (node.shadowRoot) {
        parts.push(collectVisibleText(node.shadowRoot, seen));
      }
    }
    return parts
      .map((part) => String(part).trim())
      .filter(Boolean)
      .join('\n');
  }

  function requireElement(selector: string): PageBridgeElement {
    const element = deepQuerySelector(selector);
    if (!element) {
      throw new Error(`No element matches selector: ${selector}`);
    }
    return element;
  }

  function describeElement(element: PageBridgeElement): Record<string, string | undefined> {
    return {
      tagName: element.tagName,
      text: (element.innerText || element.textContent || '').slice(0, 1000),
      value: typeof element.value === 'string' ? element.value.slice(0, 1000) : undefined,
    };
  }

  function typeIntoElement(selector: string, value: string): Record<string, string | undefined> {
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      element.value = value;
    }
    element.dispatchEvent?.(new pageGlobal.InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    element.dispatchEvent?.(new pageGlobal.Event('change', { bubbles: true }));
    return describeElement(element);
  }

  function cssAttr(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function cssIdent(value: string): string {
    return pageGlobal.CSS?.escape?.(value) ?? cssAttr(value);
  }

  function countMatches(selector: string): number {
    try {
      return documentRef.querySelectorAll?.(selector).length ?? 0;
    } catch {
      return 0;
    }
  }

  function tagName(element: PageBridgeElement): string {
    return (element.tagName || 'div').toLowerCase();
  }

  function childIndex(element: PageBridgeElement): number {
    const siblings = Array.from(element.parentElement?.children ?? []);
    const sameTagBefore = siblings
      .slice(0, siblings.indexOf(element))
      .filter((item) => tagName(item) === tagName(element));
    return sameTagBefore.length + 1;
  }

  function selectorForElement(element: PageBridgeElement): string {
    if (element.id) {
      const byId = `#${cssIdent(element.id)}`;
      if (countMatches(byId) === 1) {
        return byId;
      }
      const byIdAttr = `[id="${cssAttr(element.id)}"]`;
      if (countMatches(byIdAttr) === 1) {
        return byIdAttr;
      }
    }

    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name', 'title']) {
      const value = element.getAttribute?.(attr);
      if (!value) {
        continue;
      }
      const selector = `${tagName(element)}[${attr}="${cssAttr(value)}"]`;
      if (countMatches(selector) === 1) {
        return selector;
      }
    }

    const segments = [];
    let current: PageBridgeElement | null | undefined = element;
    for (let depth = 0; current && current !== documentRef.body && depth < 5; depth++) {
      const segment = `${tagName(current)}:nth-of-type(${childIndex(current)})`;
      segments.unshift(segment);
      const selector = segments.join(' > ');
      if (countMatches(selector) === 1) {
        return selector;
      }
      current = current.parentElement;
    }
    return segments.join(' > ') || tagName(element);
  }

  function elementText(element: PageBridgeElement): string {
    return (element.innerText || element.textContent || '').trim().slice(0, 1000);
  }

  function candidateText(element: PageBridgeElement): string {
    return [
      elementText(element),
      element.getAttribute?.('aria-label') ?? '',
      element.getAttribute?.('title') ?? '',
      element.getAttribute?.('placeholder') ?? '',
      element.getAttribute?.('name') ?? '',
      element.getAttribute?.('data-testid') ?? '',
      element.id ?? '',
    ].join(' ').toLowerCase();
  }

  function collectCandidateElements(root: PageBridgeRoot = documentRef): PageBridgeElement[] {
    const selector = [
      'a',
      'button',
      'input',
      'select',
      'textarea',
      '[role]',
      '[aria-label]',
      '[title]',
      '[data-testid]',
      '[contenteditable="true"]',
    ].join(',');
    const direct = Array.from(root.querySelectorAll?.(selector) ?? []) as PageBridgeElement[];
    const nested = [];
    for (const node of Array.from(root.querySelectorAll?.('*') ?? []) as PageBridgeElement[]) {
      if (node.shadowRoot) {
        nested.push(...collectCandidateElements(node.shadowRoot));
      }
    }
    return [...direct, ...nested];
  }

  function controlState(element: PageBridgeElement): PageBridgeControlState {
    const state: PageBridgeControlState = {};
    const tag = (element.tagName || '').toUpperCase();
    const type = (element.type || '').toLowerCase();
    if (tag === 'SELECT') {
      const options = Array.from(element.options ?? []);
      if (typeof element.value === 'string') {
        state.value = element.value.slice(0, 1000);
      }
      const selectedLabel = options
        .filter((option) => option.selected)
        .map((option) => (option.label || option.textContent || option.value || '').trim())
        .filter(Boolean)
        .join(', ');
      if (selectedLabel) {
        state.selectedOption = selectedLabel.slice(0, 200);
      }
      state.options = options.slice(0, 50).map((option) => ({
        value: String(option.value ?? '').slice(0, 200),
        label: (option.label || option.textContent || '').trim().slice(0, 200),
        selected: Boolean(option.selected),
      }));
    } else if (type === 'checkbox' || type === 'radio') {
      state.checked = Boolean(element.checked);
      if (typeof element.value === 'string' && element.value && element.value !== 'on') {
        state.value = element.value.slice(0, 200);
      }
    } else if (type === 'password') {
      // Never surface secret input values to the agent.
    } else if (typeof element.value === 'string') {
      state.value = element.value.slice(0, 1000);
    } else if (element.isContentEditable) {
      state.value = (element.textContent || '').slice(0, 1000);
    }

    if (element.disabled === true) {
      state.disabled = true;
    }
    const ariaExpanded = element.getAttribute?.('aria-expanded');
    if (ariaExpanded === 'true' || ariaExpanded === 'false') {
      state.expanded = ariaExpanded === 'true';
    }
    const ariaChecked = element.getAttribute?.('aria-checked');
    if (state.checked === undefined && (ariaChecked === 'true' || ariaChecked === 'false')) {
      state.checked = ariaChecked === 'true';
    }
    return state;
  }

  function queryElements(query: string | undefined, limit: number | undefined): unknown {
    const normalizedQuery = query?.trim().toLowerCase();
    const max = Math.max(1, Math.min(limit ?? 50, 100));
    const elements = collectCandidateElements()
      .filter((element) => !normalizedQuery || candidateText(element).includes(normalizedQuery))
      .slice(0, max)
      .map((element) => ({
        selector: selectorForElement(element).slice(0, 2000),
        tagName: element.tagName ?? tagName(element).toUpperCase(),
        role: element.getAttribute?.('role') ?? tagName(element),
        accessibleName:
          element.getAttribute?.('aria-label') ??
          element.getAttribute?.('title') ??
          element.getAttribute?.('name') ??
          undefined,
        text: elementText(element),
        inputType: element.type,
        placeholder: element.placeholder,
        href: element.href,
        ...controlState(element),
      }));
    return { elements };
  }

  if (action === 'snapshot') {
    return {
      title: documentRef.title,
      text: collectVisibleText().slice(0, 120_000),
    };
  }

  if (action === 'query_elements') {
    const [query, limit] = args as [string | undefined, number | undefined];
    return queryElements(query, limit);
  }

  if (action === 'click') {
    const [selector] = args as [string];
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.click?.();
    return describeElement(element);
  }

  if (action === 'type') {
    const [selector, value] = args as [string, string];
    return typeIntoElement(selector, value);
  }

  if (action === 'select') {
    const [selector, value] = args as [string, string];
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    element.value = value;
    element.dispatchEvent?.(new pageGlobal.Event('input', { bubbles: true }));
    element.dispatchEvent?.(new pageGlobal.Event('change', { bubbles: true }));
    return describeElement(element);
  }

  if (action === 'wait_for') {
    const [selector, timeoutMs] = args as [string, number];
    return new Promise((resolve, reject) => {
      const existing = deepQuerySelector(selector);
      if (existing) {
        resolve(describeElement(existing));
        return;
      }
      const observer = new pageGlobal.MutationObserver(() => {
        const element = deepQuerySelector(selector);
        if (!element) {
          return;
        }
        clearTimeout(timeout);
        observer.disconnect();
        resolve(describeElement(element));
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for selector: ${selector}`));
      }, timeoutMs);
      observer.observe(documentRef.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  throw new Error(`Unsupported page bridge action: ${action}`);
}
