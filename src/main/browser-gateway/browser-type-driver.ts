import type { Page } from 'puppeteer-core';
import { normaliseBindableOrigin } from './browser-credential-origin';
import { CredentialVaultError } from './browser-credential-vault';
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

/** Secure broker writes have no unguarded keystroke or selector fallback. */
export async function applyBrowserCredentialValue(
  page: Page, selector: string, value: string, authorizedOrigin: string,
  beforeDispatch?: () => void,
): Promise<void> {
  let expectedOrigin: string;
  try { expectedOrigin = normaliseBindableOrigin(authorizedOrigin); }
  catch { throw new CredentialVaultError('Credential website is invalid', 'origin_mismatch'); }
  let liveOrigin: string;
  try { liveOrigin = new URL(page.url()).origin; }
  catch { throw new CredentialVaultError('Credential website could not be confirmed', 'origin_mismatch'); }
  if (liveOrigin !== expectedOrigin) throw new CredentialVaultError('Credential website changed before dispatch', 'origin_mismatch');
  beforeDispatch?.();
  // The bridge repeats the origin check inside the same synchronous page task
  // that writes the value, covering navigation after this process-side check.
  await evaluatePageBridge(page, { action: 'type_credential', args: [selector, value, expectedOrigin] });
}
