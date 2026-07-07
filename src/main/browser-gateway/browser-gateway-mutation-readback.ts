import type {
  BrowserControlVerifyExpectation,
  BrowserFillFormField,
} from '@contracts/types/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { FillControlReadback } from './browser-fill-plan-executor';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import { HEAVY_DOM_COMMAND_TIMEOUT_MS } from './browser-mutation-safety';
import {
  verifyControlExpectation,
  verifySelector,
} from './browser-mutation-verify';

export interface BrowserGatewayMutationReadbackDeps {
  existingTabOperations: Pick<BrowserExistingTabOperations, 'sendCommand'>;
  driver: Pick<PuppeteerBrowserDriver, 'readControl'>;
}

export async function verifyGatewayFillFormReadback(
  deps: BrowserGatewayMutationReadbackDeps,
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  fields: BrowserFillFormField[],
  existingTab?: BrowserExistingTabAttachment,
): Promise<void> {
  for (const field of fields) {
    await verifyGatewayMutationReadback(
      deps,
      request,
      field.verify,
      field.selector,
      existingTab,
    );
  }
}

export async function verifyGatewayMutationReadback(
  deps: BrowserGatewayMutationReadbackDeps,
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  expected: BrowserControlVerifyExpectation | undefined,
  fallbackSelector: string | undefined,
  existingTab?: BrowserExistingTabAttachment,
): Promise<void> {
  if (!expected) {
    return;
  }
  const selector = verifySelector(expected, fallbackSelector);
  const actual = existingTab
    ? normalizeVerifyReadback(await deps.existingTabOperations.sendCommand(
      existingTab,
      'read_control',
      { selector },
      HEAVY_DOM_COMMAND_TIMEOUT_MS,
    ))
    : await deps.driver.readControl(request.profileId, request.targetId, selector);
  const mismatch = verifyControlExpectation(expected, actual);
  if (mismatch) {
    throw new Error(mismatch);
  }
}

function normalizeVerifyReadback(value: unknown): FillControlReadback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser_verify_readback_invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record['value'] === 'string' ? { value: record['value'] } : {}),
    ...(typeof record['selectedLabel'] === 'string' ? { selectedLabel: record['selectedLabel'] } : {}),
    ...(typeof record['checked'] === 'boolean' ? { checked: record['checked'] } : {}),
  };
}
