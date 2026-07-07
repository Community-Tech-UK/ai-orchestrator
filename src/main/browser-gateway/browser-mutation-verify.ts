import type { BrowserControlVerifyExpectation } from '@contracts/types/browser';
import type { FillControlReadback } from './browser-fill-plan-executor';
import { normalizeSelectText } from './browser-select-resolver';

export function verifyControlExpectation(
  expected: BrowserControlVerifyExpectation,
  actual: FillControlReadback,
): string | null {
  const mismatches: string[] = [];
  if (expected.value !== undefined && !textMatches(actual.value, expected.value)) {
    mismatches.push('value');
  }
  if (
    expected.selectedLabel !== undefined &&
    !textMatches(actual.selectedLabel, expected.selectedLabel)
  ) {
    mismatches.push('selectedLabel');
  }
  if (expected.checked !== undefined && actual.checked !== expected.checked) {
    mismatches.push('checked');
  }
  return mismatches.length > 0 ? `browser_verify_mismatch:${mismatches.join(',')}` : null;
}

export function verifySelector(
  expected: BrowserControlVerifyExpectation,
  fallbackSelector: string | undefined,
): string {
  const selector = expected.selector ?? fallbackSelector;
  if (!selector) {
    throw new Error('browser_verify_selector_required');
  }
  return selector;
}

function textMatches(actual: string | undefined, expected: string): boolean {
  if (actual === expected) {
    return true;
  }
  const normalizedExpected = normalizeSelectText(expected);
  if (normalizedExpected === '') {
    return (actual ?? '') === '';
  }
  return normalizeSelectText(actual) === normalizedExpected;
}
