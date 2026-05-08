import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { ModelPickerFocusService } from './model-picker-focus.service';

describe('ModelPickerFocusService', () => {
  let service: ModelPickerFocusService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ModelPickerFocusService);
  });

  it('starts at zero', () => {
    expect(service.request()).toBe(0);
  });

  it('requestOpen increments the signal monotonically', () => {
    service.requestOpen();
    expect(service.request()).toBe(1);
    service.requestOpen();
    expect(service.request()).toBe(2);
    service.requestOpen();
    expect(service.request()).toBe(3);
  });

  it('multiple subscribers see the same signal value', () => {
    const a = service.request();
    const b = service.request();
    service.requestOpen();
    expect(service.request()).toBe(a + 1);
    expect(service.request()).toBe(b + 1);
  });

  it('exposes request as a readonly signal', () => {
    // Trying to call .set on the returned readonly signal would not compile
    // (typecheck guard). Smoke check: the service does not expose a setter.
    expect((service as unknown as { request: { set?: unknown } }).request.set).toBeUndefined();
  });
});
