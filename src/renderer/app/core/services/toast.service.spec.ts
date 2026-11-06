import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastService } from './toast.service';
describe('action toast lifetime', () => {
  let service: ToastService;
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({}); service = TestBed.inject(ToastService); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('keeps plain calls working and action toasts for five seconds', () => {
    service.show('Plain'); service.show('Undoable', 'success', { action: { label: 'Undo', run: vi.fn() } });
    vi.advanceTimersByTime(4000); expect(service.toasts().map((t) => t.text)).toEqual(['Undoable']);
    vi.advanceTimersByTime(1000); expect(service.toasts()).toEqual([]);
  });
  it('pauses for both focus and hover until both leave', () => {
    service.show('Paused', 'success', { action: { label: 'Undo', run: vi.fn() } });
    const id = service.toasts()[0].id;
    vi.advanceTimersByTime(1000); service.pause(id, 'hover'); service.pause(id, 'focus');
    vi.advanceTimersByTime(10_000); service.resume(id, 'hover'); vi.advanceTimersByTime(10_000);
    expect(service.toasts()).toHaveLength(1); service.resume(id, 'focus');
    vi.advanceTimersByTime(3999); expect(service.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(service.toasts()).toEqual([]);
  });
  it('replaces the same key and preserves action toasts beyond the plain cap', () => {
    service.show('Old', 'success', { key: 'undo:archive' });
    service.show('New', 'success', { key: 'undo:archive', action: { label: 'Undo', run: vi.fn() } });
    for (let i = 0; i < 5; i++) service.show(String(i));
    expect(service.toasts().some((t) => t.text === 'Old')).toBe(false);
    expect(service.toasts().some((t) => t.text === 'New')).toBe(true);
    expect(service.toasts().filter((t) => !t.action)).toHaveLength(3);
    service.dismissKey('undo:archive'); expect(service.toasts().some((t) => t.action)).toBe(false);
    service.dismissAll(); expect(service.toasts()).toEqual([]);
  });
});
