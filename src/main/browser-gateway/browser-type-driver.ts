import type { Page } from 'puppeteer-core';
import {
  evaluatePageBridge,
  type PageBridgeFieldDescriptor,
} from './browser-page-bridge';

const DATE_FAMILY_INPUT_TYPES = new Set([
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
]);

async function requiresBridgeTyping(page: Page, selector: string): Promise<boolean> {
  try {
    const described = (await evaluatePageBridge(page, {
      action: 'describe_field',
      args: [selector],
    })) as PageBridgeFieldDescriptor;
    return (
      described.isContentEditable ||
      (described.inputType !== undefined && DATE_FAMILY_INPUT_TYPES.has(described.inputType))
    );
  } catch {
    return false;
  }
}

export async function applyBrowserTypedValue(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  if (await requiresBridgeTyping(page, selector)) {
    await evaluatePageBridge(page, { action: 'type', args: [selector, value] });
    return;
  }
  try {
    await page.type(selector, value);
  } catch {
    await evaluatePageBridge(page, {
      action: 'type',
      args: [selector, value],
    });
  }
}
