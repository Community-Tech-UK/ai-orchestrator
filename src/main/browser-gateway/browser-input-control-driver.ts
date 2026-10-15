/**
 * Page-level keyboard and viewport control for managed Puppeteer profiles
 * (same pattern as browser-type-driver / browser-control-driver). Keyboard
 * input goes through Puppeteer's keyboard, which is CDP Input — the browser's
 * real input mechanism, so focus movement and default key behaviour occur.
 * Modifiers are real keyboard state and are always released, including on
 * failure. The focused-element read-back never carries input values.
 */

import type { Page } from 'puppeteer-core';
import type {
  BrowserFocusInfo,
  BrowserPressKey,
  BrowserPressKeyModifier,
  BrowserPressKeyResult,
  BrowserSetViewportResult,
  BrowserViewportScope,
} from '@contracts/schemas/browser';
import { evaluatePageBridge } from './browser-page-bridge';
import { redactBrowserText, redactBrowserUrl } from './browser-redaction';

export async function applyBrowserPressKey(
  page: Page,
  key: BrowserPressKey,
  modifiers: BrowserPressKeyModifier[] = [],
): Promise<BrowserPressKeyResult> {
  // The down loop lives INSIDE the try so a failure halfway through holding
  // modifiers (e.g. Control's down throws after Shift is held) still reaches
  // the release below — never leave a modifier stuck in the user's session.
  try {
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier);
    }
    await page.keyboard.press(key);
  } finally {
    for (const modifier of [...modifiers].reverse()) {
      await page.keyboard.up(modifier).catch(() => undefined);
    }
  }
  const focusRaw = await evaluatePageBridge(page, { action: 'read_focus', args: [] });
  const focus = readFocusFromBridge(focusRaw);
  return {
    applied: true,
    key,
    modifiers: [...modifiers],
    ...(focus ? { focus } : {}),
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/**
 * Tab-scoped viewport emulation. `{}` reads, `{width,height}` emulates,
 * `{reset:true}` clears the override (setViewport(null)). Actual dimensions
 * always come from the live page's content box.
 */
export async function applyBrowserViewport(
  page: Page,
  command: { width?: number; height?: number; reset?: boolean },
): Promise<BrowserSetViewportResult> {
  const scope: BrowserViewportScope = 'tab';
  const before = await readManagedViewport(page);
  let mode: BrowserSetViewportResult['mode'] = 'read';
  if (command.reset === true) {
    // null clears the emulation override entirely (no silent placeholder size).
    await page.setViewport(null);
    mode = 'reset';
  } else if (command.width !== undefined && command.height !== undefined) {
    await page.setViewport({
      width: command.width,
      height: command.height,
      deviceScaleFactor: 1,
    });
    mode = 'tab_emulation';
  }
  const actual = await readManagedViewport(page);
  return {
    mode,
    scope,
    ...(command.width !== undefined && command.height !== undefined && mode === 'tab_emulation'
      ? { requested: { width: command.width, height: command.height } }
      : {}),
    actual: { innerWidth: actual.innerWidth, innerHeight: actual.innerHeight },
    emulation: {
      width: actual.emulationWidth ?? 0,
      height: actual.emulationHeight ?? 0,
      deviceScaleFactor: 1,
    },
    previous: {
      emulationActive: before.emulationActive,
      ...(before.emulationWidth !== undefined ? { emulationWidth: before.emulationWidth } : {}),
      ...(before.emulationHeight !== undefined ? { emulationHeight: before.emulationHeight } : {}),
    },
  };
}

/** Parse + redact the bridge's secret-free `read_focus` payload. */
function readFocusFromBridge(raw: unknown): BrowserFocusInfo | undefined {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['focus']
    : undefined;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  const focus = record as Record<string, unknown>;
  const out: BrowserFocusInfo = {};
  for (const key of ['tagName', 'role', 'id', 'name', 'type'] as const) {
    const value = focus[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, 200);
  }
  const ariaLabel = focus['ariaLabel'];
  if (typeof ariaLabel === 'string' && ariaLabel) {
    out.ariaLabel = redactBrowserText(ariaLabel).slice(0, 500);
  }
  const text = focus['text'];
  if (typeof text === 'string' && text) {
    out.text = redactBrowserText(text).slice(0, 300);
  }
  const href = focus['href'];
  if (typeof href === 'string' && href) {
    out.href = redactBrowserUrl(href).slice(0, 2000);
  }
  if (typeof focus['editable'] === 'boolean') out.editable = focus['editable'];
  return out;
}

/** Live content box plus the emulation override currently in force. */
async function readManagedViewport(page: Page): Promise<{
  innerWidth: number;
  innerHeight: number;
  emulationActive: boolean;
  emulationWidth?: number;
  emulationHeight?: number;
}> {
  const dims = (await evaluatePageBridge(page, { action: 'read_viewport', args: [] })) as {
    innerWidth?: number;
    innerHeight?: number;
  };
  const viewport = page.viewport();
  return {
    innerWidth: typeof dims?.innerWidth === 'number' ? dims.innerWidth : 0,
    innerHeight: typeof dims?.innerHeight === 'number' ? dims.innerHeight : 0,
    emulationActive: Boolean(viewport),
    ...(viewport?.width !== undefined ? { emulationWidth: viewport.width } : {}),
    ...(viewport?.height !== undefined ? { emulationHeight: viewport.height } : {}),
  };
}
