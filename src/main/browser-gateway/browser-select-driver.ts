import type { Page } from 'puppeteer-core';
import { evaluatePageBridge } from './browser-page-bridge';
import {
  resolveSelectOption,
  selectionMatches,
  summarizeOptions as summarizeSelectOptions,
  type SelectControlState,
} from './browser-select-resolver';

export async function applyBrowserSelect(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const described = (await evaluatePageBridge(page, {
    action: 'describe_control',
    args: [selector],
  })) as SelectControlState;

  let finalState: SelectControlState;
  if (described.kind === 'native') {
    const resolved = resolveSelectOption(described.options, value);
    if (!resolved) {
      throw new Error(
        `browser.select: no <select> option at ${selector} matches "${value}". ` +
          `Available: ${summarizeSelectOptions(described.options)}`,
      );
    }
    finalState = (await evaluatePageBridge(page, {
      action: 'apply_select_native',
      args: [selector, resolved.index],
    })) as SelectControlState;
  } else {
    finalState = (await evaluatePageBridge(page, {
      action: 'apply_select_custom',
      args: [selector, value],
    })) as SelectControlState;
  }

  if (!selectionMatches(finalState, value)) {
    throw new Error(
      `browser.select: setting ${selector} to "${value}" did not take ` +
        `(control now shows value=${JSON.stringify(finalState.value)}, ` +
        `label=${JSON.stringify(finalState.selectedLabel)}). ` +
        `The option may require a different interaction, or the value is not a valid choice.`,
    );
  }
}
