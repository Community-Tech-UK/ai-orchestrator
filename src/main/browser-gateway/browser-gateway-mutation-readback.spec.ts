import { describe, expect, it } from 'vitest';
import { normalizeExistingTabControlReadback } from './browser-gateway-mutation-readback';

describe('normalizeExistingTabControlReadback frame origin', () => {
  // `__frameOrigin` decides where a vault secret may be typed, so it is an
  // anti-steering gate: only the extension's own key, only in exact-origin
  // shape. Anything else must fall back to "no frame origin" (the page origin).
  it('accepts the extension __frameOrigin in exact-origin shape', () => {
    expect(
      normalizeExistingTabControlReadback({ __found: true, __frameOrigin: 'https://login.lcn.com' })
        .frameOrigin,
    ).toBe('https://login.lcn.com');
  });

  it.each([
    ['a path', 'https://login.lcn.com/evil'],
    ['a fragment', 'https://login.lcn.com#x'],
    ['a query', 'https://login.lcn.com?x=1'],
    ['credentials', 'https://user:pass@login.lcn.com'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['mixed case', 'https://LOGIN.lcn.com'],
    ['empty', ''],
    ['a non-string', 42],
  ])('rejects %s and reports no frame origin', (_case, raw) => {
    expect(normalizeExistingTabControlReadback({ __found: true, __frameOrigin: raw })).toEqual({});
  });

  it('ignores a bare frameOrigin alias — only the extension key counts', () => {
    expect(normalizeExistingTabControlReadback({ frameOrigin: 'https://evil.example' })).toEqual({});
  });

  it('ignores an inherited __frameOrigin — own property only', () => {
    const forged = Object.create({ __frameOrigin: 'https://evil.example' }) as Record<string, unknown>;
    expect(normalizeExistingTabControlReadback(forged)).toEqual({});
  });
});
