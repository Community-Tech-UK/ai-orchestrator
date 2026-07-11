import { describe, expect, it } from 'vitest';
import { MOBILE_ICON_NAMES, MOBILE_ICON_PATHS } from './mobile-icon.component';

describe('mobile icon registry', () => {
  it('defines a non-empty vector path for every structural icon', () => {
    expect(MOBILE_ICON_NAMES).toEqual([
      'menu',
      'more',
      'folder',
      'compose',
      'chevron-down',
      'chevron-left',
      'search',
      'plus',
      'history',
      'pause',
      'play',
      'host',
      'provider',
      'settings',
      'microphone',
      'arrow-up',
      'attachment',
      'clipboard',
      'close',
      'check',
      'lock',
      'tool',
      'warning',
      'error',
      'qr',
    ]);

    for (const name of MOBILE_ICON_NAMES) {
      expect(MOBILE_ICON_PATHS[name].trim().length).toBeGreaterThan(0);
    }
  });
});
