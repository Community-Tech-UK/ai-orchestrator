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

interface PageBridgeElement extends PageBridgeRoot {
  tagName?: string;
  innerText?: string;
  value?: string;
  isContentEditable?: boolean;
  shadowRoot?: PageBridgeRoot | null;
  scrollIntoView?: (options?: unknown) => void;
  focus?: () => void;
  click?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
}

interface PageBridgeDocument extends PageBridgeRoot {
  title: string;
  body?: PageBridgeElement;
  documentElement: PageBridgeElement;
}

interface PageBridgeGlobal {
  document: PageBridgeDocument;
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

  if (action === 'snapshot') {
    return {
      title: documentRef.title,
      text: collectVisibleText().slice(0, 120_000),
    };
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
