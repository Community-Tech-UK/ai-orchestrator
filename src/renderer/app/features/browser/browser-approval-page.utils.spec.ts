import { describe, expect, it, vi } from 'vitest';
import { BrowserApprovalFocus } from './browser-approval-page.utils';

describe('BrowserApprovalFocus', () => {
  it('stops retrying after a bounded number of missing-card render passes', () => {
    const host = document.createElement('div');
    const focus = new BrowserApprovalFocus(host);

    for (let attempt = 0; attempt < 20; attempt += 1) focus.apply('missing-request');
    const lateCard = document.createElement('article');
    lateCard.id = 'browser-approval-missing-request';
    lateCard.focus = vi.fn();
    host.appendChild(lateCard);
    focus.apply('missing-request');

    expect(lateCard.focus).not.toHaveBeenCalled();
  });

  it('handles malformed query-string request IDs without building a CSS selector', () => {
    const host = document.createElement('div');
    const focus = new BrowserApprovalFocus(host);

    expect(() => focus.apply('request-"]')).not.toThrow();
  });
});
