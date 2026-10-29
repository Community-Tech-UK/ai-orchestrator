import type { BrowserTargetInspectionState } from '@contracts/types/browser';

const INSPECTION_UNAVAILABLE_TITLE = 'Tab inspection unavailable';
const SECRET_TAINTED_TITLE = 'Secret-filled tab';

/**
 * Page text could not be read, and the URL/title from `chrome.tabs` are not a
 * substitute. Kept in step with `buildTabPayloadLocked` in the extension.
 */
const PAGE_TEXT_UNREADABLE_REASONS = new Set([
  'host_permission_denied',
  'page_text_read_failed',
  // The page did not answer within the extension's page-text time limit.
  'page_not_responding',
  // A Chrome pop-up the extension saw open is blocking the page.
  'dialog_open',
]);

export function isPageTextUnreadableReason(
  reason: string | undefined,
): reason is 'host_permission_denied' | 'page_text_read_failed' | 'page_not_responding' | 'dialog_open' {
  return reason !== undefined && PAGE_TEXT_UNREADABLE_REASONS.has(reason);
}

export function deriveBrowserTargetInspectionState(input: {
  inspectionState?: BrowserTargetInspectionState;
  title?: string;
  textUnavailableReason?: string;
  url?: string;
}): BrowserTargetInspectionState {
  if (
    input.inspectionState === 'secret_tainted'
    || input.textUnavailableReason === 'browser_secret_observation_blocked_for_tainted_origin'
    || input.title === SECRET_TAINTED_TITLE
  ) {
    return 'secret_tainted';
  }
  if (
    input.inspectionState === 'inspection_unavailable'
    || input.textUnavailableReason === 'browser_secret_inspection_unavailable'
    || input.title === INSPECTION_UNAVAILABLE_TITLE
    || isPageTextUnreadableReason(input.textUnavailableReason)
  ) {
    return 'inspection_unavailable';
  }
  if (input.inspectionState) {
    return input.inspectionState;
  }
  return 'readable';
}

export function isOpaqueBrowserTarget(
  state: BrowserTargetInspectionState,
): boolean {
  return state === 'inspection_unavailable' || state === 'secret_tainted';
}
