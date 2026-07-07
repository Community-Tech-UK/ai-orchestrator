import type { Page } from 'puppeteer-core';
import { evaluatePageBridge } from './browser-page-bridge';
import type { FillControlReadback } from './browser-fill-plan-executor';

/** Read a control's current state (value / selected label / checked) for read-back. */
export async function readControlState(
  page: Page,
  selector: string,
): Promise<FillControlReadback> {
  const state = (await evaluatePageBridge(page, {
    action: 'read_control',
    args: [selector],
  })) as FillControlReadback;
  return {
    value: typeof state.value === 'string' ? state.value : undefined,
    selectedLabel: typeof state.selectedLabel === 'string' ? state.selectedLabel : undefined,
    checked: typeof state.checked === 'boolean' ? state.checked : undefined,
  };
}

/**
 * Set a checkbox/radio/switch to the desired state, verifying it took. Throws
 * loudly on a mismatch rather than reporting a silent no-op as success.
 */
export async function applySetChecked(
  page: Page,
  selector: string,
  checked: boolean,
): Promise<void> {
  const state = (await evaluatePageBridge(page, {
    action: 'set_checked',
    args: [selector, checked],
  })) as FillControlReadback;
  if (state.checked !== checked) {
    throw new Error(
      `browser.set_checked: ${selector} did not reach checked=${checked} ` +
        `(now ${JSON.stringify(state.checked)}).`,
    );
  }
}
