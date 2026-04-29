import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CLIPBOARD_TOAST, type ClipboardToastAdapter } from './clipboard-toast.token';

describe('CLIPBOARD_TOAST', () => {
  it('is optional', () => {
    TestBed.configureTestingModule({ providers: [] });

    const adapter = TestBed.inject(CLIPBOARD_TOAST, null, { optional: true });

    expect(adapter).toBeNull();
  });

  it('accepts a provider', () => {
    const fake: ClipboardToastAdapter = {
      success: () => undefined,
      error: () => undefined,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: CLIPBOARD_TOAST, useValue: fake }],
    });

    expect(TestBed.inject(CLIPBOARD_TOAST)).toBe(fake);
  });
});
