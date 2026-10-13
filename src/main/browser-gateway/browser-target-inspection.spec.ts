import { describe, expect, it } from 'vitest';
import {
  deriveBrowserTargetInspectionState,
  isOpaqueBrowserTarget,
} from './browser-target-inspection';

describe('deriveBrowserTargetInspectionState', () => {
  it.each(['host_permission_denied', 'page_text_read_failed'] as const)(
    'overrides a readable stamp when page text is %s',
    (textUnavailableReason) => {
      const state = deriveBrowserTargetInspectionState({
        inspectionState: 'readable',
        title: 'Login - LCN',
        url: 'https://www.lcn.com/login',
        textUnavailableReason,
      });

      expect(state).toBe('inspection_unavailable');
      expect(isOpaqueBrowserTarget(state)).toBe(true);
    },
  );

  it('keeps a secret-tainted stamp ahead of a page-read failure', () => {
    expect(deriveBrowserTargetInspectionState({
      inspectionState: 'secret_tainted',
      textUnavailableReason: 'host_permission_denied',
    })).toBe('secret_tainted');
  });

  it('stays readable when the page text was read', () => {
    expect(deriveBrowserTargetInspectionState({
      inspectionState: 'readable',
      title: 'Login - LCN',
      url: 'https://www.lcn.com/login',
    })).toBe('readable');
  });
});
