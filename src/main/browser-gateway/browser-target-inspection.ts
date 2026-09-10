import type { BrowserTargetInspectionState } from '@contracts/types/browser';

const INSPECTION_UNAVAILABLE_TITLE = 'Tab inspection unavailable';
const SECRET_TAINTED_TITLE = 'Secret-filled tab';

export function deriveBrowserTargetInspectionState(input: {
  inspectionState?: BrowserTargetInspectionState;
  title?: string;
  textUnavailableReason?: string;
  url?: string;
}): BrowserTargetInspectionState {
  if (input.inspectionState) {
    return input.inspectionState;
  }
  if (
    input.textUnavailableReason === 'browser_secret_inspection_unavailable'
    || input.title === INSPECTION_UNAVAILABLE_TITLE
  ) {
    return 'inspection_unavailable';
  }
  if (
    input.textUnavailableReason === 'browser_secret_observation_blocked_for_tainted_origin'
    || input.title === SECRET_TAINTED_TITLE
  ) {
    return 'secret_tainted';
  }
  return 'readable';
}

export function isOpaqueBrowserTarget(
  state: BrowserTargetInspectionState,
): boolean {
  return state === 'inspection_unavailable' || state === 'secret_tainted';
}
