import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';
import { applyBrowserTypedValue } from './browser-type-driver';
import type { PageBridgeFieldDescriptor } from './browser-page-bridge';

/**
 * Builds a fake Puppeteer page. `describe` is the descriptor returned for the
 * `describe_field` bridge probe (or an Error to simulate the probe throwing).
 * Records whether the value was applied via page.type (per-character keystrokes)
 * or via the bridge `type` action (safe direct-value path).
 */
function makeFakePage(
  describe: PageBridgeFieldDescriptor | Error,
  opts: { pageTypeThrows?: boolean } = {},
): {
  page: Page;
  calls: { pageType: number; bridgeType: number };
} {
  const calls = { pageType: 0, bridgeType: 0 };
  const page = {
    evaluate: vi.fn(async (_fn: unknown, input: { action: string }) => {
      if (input.action === 'describe_field') {
        if (describe instanceof Error) {
          throw describe;
        }
        return describe;
      }
      if (input.action === 'type') {
        calls.bridgeType += 1;
        return { tagName: 'INPUT' };
      }
      return {};
    }),
    type: vi.fn(async () => {
      calls.pageType += 1;
      if (opts.pageTypeThrows) {
        throw new Error('page.type failed');
      }
    }),
  } as unknown as Page;
  return { page, calls };
}

describe('applyBrowserTypedValue', () => {
  it('uses the safe bridge path for date-family inputs (page.type races the date segments)', async () => {
    const { page, calls } = makeFakePage({
      tagName: 'INPUT',
      inputType: 'date',
      isContentEditable: false,
    });

    await applyBrowserTypedValue(page, 'input[type=date]', '2026-07-07');

    expect(calls.bridgeType).toBe(1);
    expect(calls.pageType).toBe(0);
  });

  it.each(['datetime-local', 'time', 'month', 'week'])(
    'uses the bridge path for the %s date-family input',
    async (inputType) => {
      const { page, calls } = makeFakePage({
        tagName: 'INPUT',
        inputType,
        isContentEditable: false,
      });

      await applyBrowserTypedValue(page, 'input', '2026-07');

      expect(calls.bridgeType).toBe(1);
      expect(calls.pageType).toBe(0);
    },
  );

  it('uses the bridge path for contenteditable (rich-text editors desync on textContent overwrite)', async () => {
    const { page, calls } = makeFakePage({
      tagName: 'DIV',
      isContentEditable: true,
    });

    await applyBrowserTypedValue(page, 'div.editor', 'Hello world');

    expect(calls.bridgeType).toBe(1);
    expect(calls.pageType).toBe(0);
  });

  it('uses the fast page.type path for a plain text input', async () => {
    const { page, calls } = makeFakePage({
      tagName: 'INPUT',
      inputType: 'text',
      isContentEditable: false,
    });

    await applyBrowserTypedValue(page, 'input[name=title]', 'Release notes');

    expect(calls.pageType).toBe(1);
    expect(calls.bridgeType).toBe(0);
  });

  it('falls back to the bridge path when page.type throws on a plain input', async () => {
    const { page, calls } = makeFakePage(
      { tagName: 'INPUT', inputType: 'text', isContentEditable: false },
      { pageTypeThrows: true },
    );

    await applyBrowserTypedValue(page, 'input', 'value');

    expect(calls.pageType).toBe(1);
    expect(calls.bridgeType).toBe(1);
  });

  it('falls back to the fast page.type path when the describe probe throws', async () => {
    const { page, calls } = makeFakePage(new Error('probe failed'));

    await applyBrowserTypedValue(page, 'input', 'value');

    expect(calls.pageType).toBe(1);
    expect(calls.bridgeType).toBe(0);
  });
});
