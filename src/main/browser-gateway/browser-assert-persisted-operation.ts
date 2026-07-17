/**
 * `browser.assert_persisted` (reliability hardening, 2026-07-17): a first-class
 * post-mutation persistence check callers use after (or instead of trusting)
 * individual write results in a long, stateful flow.
 *
 * Combines the target-app failure-signal scan (the app's own "failed to save /
 * you got disconnected" surfaces) with optional control read-backs, and states
 * plainly whether the checked state can be considered persisted. A DOM
 * read-back alone can lie for SPA state (see the rich-text-editor gotcha) —
 * the signal scan covers the app-rejected-the-save case the DOM cannot show.
 */

import type { BrowserControlVerifyExpectation } from '@contracts/types/browser';
import { verifyControlExpectation } from './browser-mutation-verify';
import type { BrowserTargetPersistenceScan } from './browser-target-persistence-sentinel';

export interface BrowserAssertPersistedExpectation {
  /** CSS selector of the control to read back. */
  selector: string;
  value?: string;
  selectedLabel?: string;
  checked?: boolean;
}

export interface BrowserAssertPersistedData {
  /** False when the app reports failure/staleness or a read-back mismatched. */
  persisted: boolean;
  /**
   * 'verified' when a definitive signal scan and/or read-backs backed the
   * verdict; 'weak' when the scan was unavailable and nothing was read back.
   */
  confidence: 'verified' | 'weak';
  signalState: BrowserTargetPersistenceScan['state'];
  matchedPattern?: string;
  checkedExpectations: number;
  mismatches: Array<{ selector: string; mismatch: string }>;
}

export interface BrowserAssertPersistedDeps {
  /**
   * App failure-signal scan for this target. Callers without a scannable
   * surface (managed profiles) supply a closure resolving to state 'unknown'.
   */
  scan: () => Promise<BrowserTargetPersistenceScan>;
  readControl: (selector: string) => Promise<{
    value?: string;
    selectedLabel?: string;
    checked?: boolean;
  } | null>;
}

export async function runAssertPersisted(
  deps: BrowserAssertPersistedDeps,
  expectations: readonly BrowserAssertPersistedExpectation[],
): Promise<BrowserAssertPersistedData> {
  const scan = await deps.scan();

  const mismatches: Array<{ selector: string; mismatch: string }> = [];
  let checkedExpectations = 0;
  for (const expectation of expectations) {
    const expected: BrowserControlVerifyExpectation = {
      ...(expectation.value !== undefined ? { value: expectation.value } : {}),
      ...(expectation.selectedLabel !== undefined
        ? { selectedLabel: expectation.selectedLabel }
        : {}),
      ...(expectation.checked !== undefined ? { checked: expectation.checked } : {}),
    };
    if (Object.keys(expected).length === 0) {
      continue;
    }
    checkedExpectations += 1;
    let readback: Awaited<ReturnType<BrowserAssertPersistedDeps['readControl']>>;
    try {
      readback = await deps.readControl(expectation.selector);
    } catch (error) {
      mismatches.push({
        selector: expectation.selector,
        mismatch: `read_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
      });
      continue;
    }
    if (!readback) {
      mismatches.push({ selector: expectation.selector, mismatch: 'control_not_found' });
      continue;
    }
    const mismatch = verifyControlExpectation(expected, readback);
    if (mismatch) {
      mismatches.push({ selector: expectation.selector, mismatch });
    }
  }

  const failureSignal = scan.state === 'save_failed' || scan.state === 'session_stale';
  const persisted = !failureSignal && mismatches.length === 0;
  const confidence: BrowserAssertPersistedData['confidence'] =
    scan.state !== 'unknown' || checkedExpectations > 0 ? 'verified' : 'weak';
  return {
    persisted,
    confidence,
    signalState: scan.state,
    ...(scan.matchedPattern ? { matchedPattern: scan.matchedPattern } : {}),
    checkedExpectations,
    mismatches,
  };
}
