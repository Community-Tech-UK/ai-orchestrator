import { describe, expect, it } from 'vitest';
import {
  BrowserPressKeyRequestSchema,
  BrowserSetViewportRequestSchema,
  BrowserSetZoomRequestSchema,
} from '../browser-input-controls.schemas';

const base = {
  profileId: 'existing-tab:n.windows-pc:7:42',
  targetId: 'existing-tab:n.windows-pc:7:42:target',
};

describe('BrowserPressKeyRequestSchema', () => {
  it('accepts named keys with modifiers and idempotency keys', () => {
    const request = {
      ...base,
      key: 'Tab',
      modifiers: ['Shift'],
      actionHint: 'move focus to the previous control',
      idempotencyKey: 'focus-1',
    };
    expect(BrowserPressKeyRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects printable characters so credential typing cannot bypass browser.type', () => {
    expect(() => BrowserPressKeyRequestSchema.parse({ ...base, key: 'A' })).toThrow();
    expect(() => BrowserPressKeyRequestSchema.parse({ ...base, key: 'a' })).toThrow();
    expect(() => BrowserPressKeyRequestSchema.parse({ ...base, key: 'F5' })).toThrow();
    expect(() => BrowserPressKeyRequestSchema.parse({
      ...base,
      key: 'Tab',
      modifiers: ['Hyper'],
    })).toThrow();
  });

  it('is strict and requires the key', () => {
    expect(() => BrowserPressKeyRequestSchema.parse({ ...base })).toThrow();
    expect(() => BrowserPressKeyRequestSchema.parse({
      ...base,
      key: 'Enter',
      unknownExtra: true,
    })).toThrow();
  });
});

describe('BrowserSetViewportRequestSchema', () => {
  it('accepts a paired size, a reset, or a pure read', () => {
    expect(BrowserSetViewportRequestSchema.parse({ ...base, width: 768, height: 1024 }))
      .toMatchObject({ width: 768, height: 1024 });
    expect(BrowserSetViewportRequestSchema.parse({ ...base, reset: true })).toMatchObject({ reset: true });
    expect(BrowserSetViewportRequestSchema.parse(base)).toEqual(base);
  });

  it('rejects half-open sizes and set+reset mixes, and allows window-scope reads', () => {
    expect(() => BrowserSetViewportRequestSchema.parse({ ...base, width: 768 })).toThrow();
    expect(() => BrowserSetViewportRequestSchema.parse({
      ...base,
      width: 768,
      height: 1024,
      reset: true,
    })).toThrow();
    // A pure read with scope 'window' reports the real window's bounds.
    expect(BrowserSetViewportRequestSchema.parse({ ...base, scope: 'window' }))
      .toMatchObject({ scope: 'window' });
    expect(BrowserSetViewportRequestSchema.parse({
      ...base,
      width: 1024,
      height: 768,
      scope: 'window',
    })).toMatchObject({ scope: 'window' });
  });
});

describe('BrowserSetZoomRequestSchema', () => {
  it('accepts set and reset but not both, with bounded factors', () => {
    expect(BrowserSetZoomRequestSchema.parse({ ...base, zoomFactor: 2 }))
      .toMatchObject({ zoomFactor: 2 });
    expect(BrowserSetZoomRequestSchema.parse({ ...base, reset: true })).toMatchObject({ reset: true });
    expect(BrowserSetZoomRequestSchema.parse(base)).toEqual(base);
    expect(() => BrowserSetZoomRequestSchema.parse({ ...base, zoomFactor: 2, reset: true })).toThrow();
    expect(() => BrowserSetZoomRequestSchema.parse({ ...base, zoomFactor: 50 })).toThrow();
  });
});
